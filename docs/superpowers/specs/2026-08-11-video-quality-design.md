# Video quality — design

**Goal:** Make a Framecast video sound and look produced rather than
assembled — narration at a consistent loudness over a ducked music bed, clips
that move, cuts that dissolve with a sound behind them, captions in a chosen
typeface, and proper nouns pronounced correctly.

**Status:** Approved by the operator. Ready for an implementation plan.

## Why

Three things about today's output read as amateur, in the operator's own
assessment:

- **The picture is static.** A clip fills its slot without moving. Even after
  script-matched footage lands and cuts fall on sentences, each shot is a
  still frame held for seconds.
- **The sound is raw.** Narration is whatever ElevenLabs returned — no
  loudness normalisation, so level drifts between videos and against every
  other video on YouTube. There is no music and no sound design at all.
- **The narration reads like a bot.** Proper nouns are mispronounced, and the
  voice runs at default settings with no control over pace or expressiveness.

Mispronounced names in particular are the single clearest tell of an automated
channel, and pronunciation is the one defect a viewer attributes to the
creator rather than to the footage.

Captions are a fourth, unraised item folded in here because it is nearly free:
they render in libass's default Arial, which is the typeface nobody chose.

## Decisions taken

| Question | Decision |
|---|---|
| Scope | All of motion, audio, transitions, SFX, captions and narration in one spec |
| Where settings live | A typed `VideoStyle` object with a default constant — not yet persisted |
| Loudness target | −14 LUFS, hard-coded; it is a platform fact, not a taste |
| Music source | Jamendo API, commercial-safe Creative Commons only |
| Music attribution | Appended to the description, beside the existing Pixabay credit |
| Transitions | Crossfade stubs at boundaries, not a full `xfade` graph |
| Sound effects | Bundled pack: transition whooshes plus intro stinger and outro swell |
| Pronunciation entries | Generated automatically from the script, no approval gate |
| Pronunciation mechanism | ElevenLabs dictionary locators, not SSML in the text |

## Architecture

Five units, each independently testable:

1. **Motion** — animates the frame within one clip, in render pass one.
2. **Audio mix** — normalises narration and mixes music and SFX beneath it, in
   render pass two.
3. **Transitions** — generates crossfade stubs between adjacent segments and
   interleaves them into the concat list.
4. **Captions** — styles the existing burned-in subtitles.
5. **Narration** — voice settings and a per-channel pronunciation dictionary,
   upstream of ffmpeg entirely.

They share one input, the `VideoStyle` value object, and otherwise communicate
through files on disk and stored state. Nothing here introduces a call between
two of these units.

## Style configuration

Every knob added by this spec is a field on a `VideoStyle` type in
`src/lib/video-style.ts`, with a `DEFAULT_STYLE` constant. `RenderService`
reads it once and threads it into the ffmpeg builders and the TTS call.

This is deliberately not a database column yet. The eventual destination is a
per-channel style — that is the whole "everything that varies per user is
data" direction — but persisting it now would mean a migration, validation and
an editor UI before a single improved render exists. Because every setting is
already a field on one object, that later change is a migration plus a loader,
with no rewrite of the render code.

The loudness target is the exception and stays a module constant. YouTube
normalises playback to roughly −14 LUFS; a channel that "prefers" −9 simply
gets turned down on playback, so exposing it would offer a choice that does
not exist.

## Dependency on the script-matched footage plan

**This spec is written against the post-footage-plan signature of
`ffmpeg-command.ts`**, in which `planRender(clipPaths, segmentDir, durations)`
takes one duration per segment. That plan
(`docs/superpowers/plans/2026-08-11-script-matched-footage.md`, Task 5) is
approved but not yet implemented.

The operator chose to design both in parallel rather than serialise them. The
consequence to watch: if this work is implemented first, the motion section
must read `SegmentInput.clipSeconds` per segment, which exists in both the old
and new shape, and the transition arithmetic below must be re-checked against
whatever `planRender` actually accepts at that time.

The footage plan also already removes `ensureCoverage` and its clip repetition,
and cuts on sentences at roughly eight seconds. This spec does not restate any
of that and does not change pacing.

## 1. Motion

Each segment gets a slow drift — left, right, up or down — applied in
`buildSegmentArgs`, where that clip's decoder is already open.

### Pan, not zoom

A `crop` filter's output size must stay constant, so an animated crop can
translate its window but cannot resize it. That rules out push-in and pull-out
here: zoom needs `zoompan`, which computes per-frame scaling against integer
pixel positions and visibly judders unless the input is pre-upscaled far past
the output — memory this worker does not have.

So pass one scales the clip to 1.15× the frame and animates a `crop` window
across `t`, giving a pan. The scale filter was already in the chain and nothing
new is held open; cost is roughly a fifth more CPU on the cheaper of the two
passes. Pan alone removes the slideshow feel, which is the actual complaint.
Zoom is deferred rather than faked.

### Direction and rate

Direction is chosen from the segment's index, cycling through left, right, up
and down. Two consequences, both wanted: adjacent shots
never move the same way, and a re-render of an unchanged video produces an
identical file.

The rate derives from that segment's duration. A fixed rate looks like two
different effects over a four-second cue and a twelve-second one — the short
shot barely moves while the long one drifts unnaturally far. Deriving the rate
from duration is what makes motion survive variable-length segments, and is
the reason this unit depends on the footage plan's per-segment durations.

## 2. Audio: mastering and music

### The provider

`src/services/providers/music.provider.ts` defines a `MusicProvider` interface
in `types.ts` and a `JamendoProvider` implementation, following the shape
`stock-footage.provider.ts` already established: a search method, a typed
result, an exported singleton.

Pixabay is not an option despite already being a configured provider — its
documented API covers images and videos only, with no music endpoint. Jamendo
is the workable stock music API and exposes exactly the filters this needs.

Queries exclude `ccnc`, because a non-commercial licence is unusable on a
channel intended for monetisation, and require `audiodownload_allowed`, which
individual artists can switch off regardless of licence. A track that fails
either check is skipped rather than downloaded and reasoned about later.

One track per video, stored as an `Asset` of kind `MUSIC` — the enum already
has that value, so no migration. Storing it means a re-render never re-fetches
and never silently swaps the music under a video the operator already
reviewed.

New environment key: `JAMENDO_CLIENT_ID`.

### Attribution

The track's artist and licence are appended by `buildDescription` in
`publish.service.ts`, beside `PIXABAY_CREDIT`. That constant's own comment
gives the reasoning and it applies unchanged here: attribution that depends on
the operator remembering is not attribution.

### The mix

Pass two currently maps narration straight through untouched. It becomes a
video branch and an audio branch:

- narration → `loudnorm=I=-14:TP=-1.5:LRA=11`, then `asplit`, because the
  narration is needed twice — once in the mix and once as the ducking key
- music → looped with `-stream_loop -1`, held at a fixed low gain
- SFX → the pre-built track from section 3
- `sidechaincompress` on the music, keyed by the narration, so the bed drops
  under speech and recovers in the gaps
- `amix` of the three, then `alimiter` so the sum cannot clip

Three details that will otherwise be discovered the hard way:

**`amix=normalize=0` is load-bearing.** The default normalises by input count,
halving levels and silently undoing the `loudnorm` above it.

**`-stream_loop -1` makes the music input infinite,** so the existing
`-t durationSeconds` stops being a drift guard and becomes the argument that
terminates the render. `-shortest` cannot be relied on against an infinite
input.

**`loudnorm` runs single-pass.** A true two-pass measure is more accurate but
needs an analysis run over the whole narration, which is not worth a second
pass on a 2-vCPU container. Single-pass is dynamic, so final integrated
loudness lands near −14 rather than exactly on it — inaudible, and well inside
what YouTube's own normalisation absorbs.

Audio filters cost almost nothing in memory, so none of this threatens the
budget that shaped `ffmpeg-command.ts`.

## 3. Transitions and sound effects

### Why stubs rather than `xfade` across the timeline

`xfade` needs both clips live in a filter graph simultaneously. That is
precisely the shape `ffmpeg-command.ts` was rewritten to eliminate after
thirty-eight concurrent decoders got the worker OOM-killed, so applying it
across the timeline would reintroduce a failure mode already paid for once.

A stub is a single crossfade file built from the tail of segment A and the
head of segment B. Two decoders, half a second of output. The concat list then
interleaves them:

```
A' → stub(A,B) → B' → stub(B,C) → C'
```

Memory stays flat in the number of segments, which is the property the two-pass
design exists to protect.

### Keeping the timeline honest

Each crossfade consumes `D` seconds of overlap, so a naive implementation
produces a video `D × boundaries` shorter than its narration. Over a long video
that drifts the picture away from the cue timings the footage plan establishes,
which is the exact defect that plan exists to fix.

`planRender` therefore requests `D` extra seconds for each segment that owns an
outgoing boundary, and the total is asserted rather than assumed. Stock clips
loop via `-stream_loop -1`, so the additional material is always available
regardless of the source clip's real length.

`D` is 0.5 s, on `VideoStyle`.

### Sound effects

A bundled pack in blob storage, not an API. A whoosh reused across a thousand
videos is a licence settled once; fetching one per render adds latency, a
failure mode and a per-clip licence check for a file that never varies.
Freesound is the alternative and needs OAuth for downloads, which is a lot of
machinery for six sounds.

Whooshes sit on each transition, a stinger at the start of the video and a
swell at the end. "Start" and "end" here mean the first and last seconds of the
timeline, not script sections — the video does not yet have a structural hook
or outro, and giving it one is out of scope below. Selection rotates by
boundary index — deterministic, and no two adjacent cuts share a sound.

They are mixed into **one full-length SFX track** by a small intermediate step
using `adelay` and `amix`, not passed to pass two as separate inputs. Fifty
boundaries would otherwise mean fifty extra inputs; audio decoders are far
cheaper than video ones, but adding pressure to this particular worker without
needing to is how the original OOM happened. Pass two mixes exactly three audio
streams.

## 4. Captions

The `subtitles` filter gains `force_style`: font, size, weight, outline,
shadow and bottom margin, all fields on `VideoStyle`. No new filter, no new
pass, no change to SRT generation.

The one real dependency is that libass resolves fonts against the container,
so `worker/Dockerfile` must install the chosen font or the repo must ship a
TTF. A font named in `force_style` but absent from the image falls back
silently to the default — the failure looks like the feature simply not
working, so the Dockerfile change is part of this unit, not an afterthought.

## 5. Narration: voice settings and pronunciation

### Voice settings

`voice_settings` (`stability`, `style`, `speed`) and a fixed `seed` are added
to the request in `elevenlabs.provider.ts`, sourced from `VideoStyle`. The
settings address the uniform robotic rhythm; the seed makes a re-render
reproducible, which matters in a pipeline that already re-encodes and re-runs.

### Why dictionaries rather than SSML

`SpeechProvider.synthesize` calls `/text-to-speech/{id}/with-timestamps` and
returns a character alignment that `lib/captions.ts` turns directly into SRT.
Injecting `<phoneme>` or `<lexeme>` markup into `text` puts that markup into
the very stream the alignment describes, risking corrupted captions as the
price of corrected audio.

`pronunciation_dictionary_locators` — which that endpoint accepts, up to three
— keeps the dictionary server-side at ElevenLabs and `text` clean, so the
alignment stays trustworthy.

### Alias rules, not phonemes

Phoneme support is model-dependent: Flash v2 takes SSML phonemes, v3 takes IPA
in slashes, and Multilingual v2 supports only alias replacement. Since
`ELEVENLABS_MODEL_ID` is environment-configured and can change without touching
this code, rules use **alias** replacements, which every model honours. A model
change cannot silently degrade pronunciation.

### Generation

After script generation, a model pass extracts proper nouns and likely
mispronounced terms from the narration and upserts them into a per-channel
ElevenLabs dictionary. Its ID and version are stored on `Channel`; synthesis
passes the locator.

Entries apply without review, per the operator's decision. Two properties make
that cheaper to live with: rules are aliases, so a bad entry produces a
mispronunciation rather than invalid markup, and entries persist on the
channel, so a wrong guess is corrected once and never recurs on that channel.

## Failure handling

Every unit here is an enhancement to a video that is already publishable, so
each degrades rather than blocking. The rule: nothing added by this spec may
turn a renderable video into a failed one.

| Failure | Behaviour |
|---|---|
| Jamendo search returns nothing | Render without music |
| Jamendo fails transiently | Render without music |
| Every candidate track fails the licence or download check | Render without music |
| SFX pack missing from storage | Render without the SFX track |
| Dictionary create or update fails | Synthesise without a locator |
| Font missing from the container | Captions render in the fallback face; logged |
| Transition stub generation fails for a boundary | That boundary becomes a hard cut |
| Total duration does not equal narration duration | Render fails loudly |

The last row matches the footage plan's own reasoning. A duration mismatch can
only come from a bug in the overlap arithmetic, and a video whose picture
drifts out of sync with its narration is worse than one that refuses to
render.

## Testing

- **Motion:** direction cycles by index; rate derived from duration, checked
  across a short and a long segment; the same input produces identical args.
- **Mix:** `normalize=0` present; the filter graph names three audio inputs
  when music and SFX exist, and fewer when they do not; `-t` present whenever
  the music input is looped.
- **Music provider:** `ccnc` excluded from the query; a track with
  `audiodownload_allowed` false is skipped; a provider error yields no music
  rather than throwing; the stored `MUSIC` asset is reused on re-render.
- **Attribution:** the description carries the track credit alongside the
  Pixabay credit.
- **Transitions:** boundary count is segments minus one; total duration equals
  narration duration for one, two and many segments; a failed stub degrades to
  a hard cut.
- **SFX:** rotation never repeats across adjacent boundaries; the built track
  matches the video length.
- **Captions:** `force_style` reaches the filter with the configured values and
  is escaped like the subtitle path already is.
- **Narration:** voice settings and seed present in the request body; the
  locator sent when a dictionary exists and omitted when it does not; `text`
  contains no markup.

Tests use throwaway users via `src/test/fixtures.ts`, never
`prisma.user.findFirstOrThrow`.

## Out of scope

Zoom (push in, pull out), for the reason given in section 1: it needs
`zoompan` and a pre-upscale the worker cannot afford. Worth revisiting if the
render ever moves to a larger container.

Content-triggered sound effects — rain, crowds, keyboards anchored to what the
narration is describing — need cue anchoring of their own and are their own
spec. Video structure (hook, chapters, outro as script sections) is likewise
separate. Persisting `VideoStyle` per channel, and the UI to edit it, is the
natural follow-on once the defaults have been seen on real videos.
