# The single-insight psychology short

*2026-08-17*

## What this is

A production format, not a channel. Forty to fifty-five seconds, vertical, no
presenter: one behavioural insight, explained in second person, paid off by
naming a real psychological effect. The operator supplied a prompt pack
decoding it — six narrative beats, a voice rulebook, a visual style bible, and a
validator. This document maps that pack onto Framecast and is honest about what
is a setting, what is new code, and what the pack asks for that this app cannot
do.

## Why this one and not the other

The previous style teardown (`2026-08-17-automation-canvas-design.md`'s sibling,
the Explainer Chris analysis) concluded that reproducing *that* format needs a
board compositor: a persistent white canvas with elements popping onto it at
timed offsets. That is a second renderer beside the one this app has.

This format needs no such thing. Its unit is **one full-frame clip per spoken
sentence, cut at sentence boundaries, with captions burned in over a ducked
music bed** — which is a description of `planRender` as it already exists. The
work below is almost entirely *tuning what runs* rather than *building a second
way to run*.

That difference is the reason this is worth doing first.

## What already exists

| The pack asks for | Framecast today |
|---|---|
| 1080×1920, 30fps | `FRAME_SIZES.VERTICAL`, `FPS = 30` |
| One clip per scene, cut at sentence ends | `planRender` + `anchorCues`/`cueWindows` |
| Shot changes every 3–5s | Falls out of per-section narration timing |
| One to three caption words on screen | `SHORT_MAX_WORDS_PER_LINE = 3` |
| Word-level caption timing | ElevenLabs per-character `Alignment`, already stored |
| Music under VO, ducked | `AudioStyle` sidechain compressor |
| Stability / style / speed | `VoiceStyle` |
| A topic bank feeding one video at a time | `ScheduleTopic`, consumed by `ScheduleService` |
| Structured JSON with validation and retry | `structured-output.ts` + `scriptService` |
| A scene with narration, a visual prompt and a time window | `Scene { index, narration, prompt, startSeconds, endSeconds }` |

The `Scene` model deserves calling out: it already carries exactly the four
fields a scene in the pack carries. Nothing about the pack's shape is foreign to
this schema.

## Three corrections the pack needs before it is wired to anything

**The model id is wrong.** The pack specifies `claude-sonnet-4-6`, which does
not exist and would fail at the first call. `src/config/env.ts` already names
`claude-sonnet-5`. Use what the app is configured with rather than what the pack
says.

**Stage 2 assumes text-to-video. There is no such provider here** — only
`image.provider` (gpt-image) and `stock-footage.provider`. This is less of a
problem than it looks: `buildSegmentArgs` already loops a still with `-loop 1`
and pans a crop window across it, so a *generated still plus the existing
motion* produces "a cinematic shot with one slow move" without a video model.
The pack's prompt formula survives almost unchanged as an image prompt. A t2v
provider is a later option, not a prerequisite.

**Declared scene durations cannot be honoured.** The pack has the model emit
`duration: 2.5–5.0`. `planRender` derives a clip's length from where its section
actually falls in the narration, and refuses a clip shorter than the transition
it must make room for. Emitting durations is still useful — the validator uses
them to catch a script that will run long — but the render must keep deriving
the real cut from alignment. A model's guess about timing is not a fact about
audio.

## The three stages, mapped

The pack's insistence on three separate calls is right and matches what this
codebase already does for scripts and metadata.

### Stage 1 — script

A new `PromptTemplate` in the SCRIPT category, holding the pack's system prompt
verbatim. Nothing in the app needs to know it is special: `scriptService.generate`
already takes a `templateId`, and `Series.promptTemplateId` already pins one per
show. **A new format is a new prompt template and a style preset, not a new code
path.**

What is new is the *shape of the output*. Today a script is prose that
`anchorCues` splits into sections. The pack returns a scene array with beats,
captions and emphasis. Two options, and the second is the recommendation:

1. Have the model emit prose with cue markers, as now, and lose the beats.
2. Have it emit the pack's JSON, persist the scenes, and keep the prose form as
   a derived join of `narration`. `Scene` already exists and already has the
   fields; the beat and the emphasis are what it lacks.

The second keeps the pack's structure intact, which is where its value is — the
six beats are the format.

### Stage 2 — visual expander

`FootageService` already composes an art style (`composeArtStyle` in
`src/lib/art-styles.ts`) and searches or generates per section. The pack's style
bible is a stricter, more opinionated version of exactly that — a look applied
identically to every shot. So this is **a new entry in `art-styles.ts` and one
in `footage-styles.ts`**, plus the pack's expander prompt. No new service.

The one genuinely new idea worth taking: the pack's rule that the visual is an
*emotional rhyme* of the narration rather than a literal illustration ("memory
is not a brain; it is a woman pausing in a doorway"). That is a line in a prompt
and it is most of why the format does not look like stock slop.

### Stage 3 — metadata

`MetadataService` already produces title, description and tags, and
`ThumbnailService` already generates a thumbnail from a prompt. The pack's
metadata prompt replaces the wording; the ranked-titles idea (five options with
predicted CTR) is the only structural addition, and it is optional.

## Data model

```prisma
model Scene {
  /// Which of the six narrative beats this scene is.
  ///
  /// Null for every scene produced by any other format, which is every scene
  /// that exists today. Present only for scripts written to a beat structure,
  /// and read by the renderer for exactly one thing: the dip-to-black before
  /// NAME_IT. Everything else about a beat is the writer's concern.
  beat String?

  /// Words the voice should stress, as the model chose them.
  ///
  /// A `String[]` rather than markup inside `narration`, so the narration
  /// stays the plain text the aligner and the captions both read. The TTS
  /// layer applies them; nothing else has to know they exist.
  emphasis String[]
}
```

Both additive, both null/empty for existing rows. `VoiceStyle` gains
`similarity: number` — ElevenLabs takes it, `VoiceStyle` does not currently
carry it, and the pack pins it at 0.80.

## The renderer

This is where the real work is, and it is three things.

### Kinetic captions

The single largest visual difference between this format and generic AI video,
and the one thing the pack specifies that the current pipeline cannot express at
all.

`captions.ts` emits **SRT**. SRT has no styling per word and no animation: a cue
appears whole and disappears whole. The pack wants one to three words at a time,
popping in word by word, with the keyword in amber.

The timing already exists — `Alignment` is per character, and `toWords` already
reduces it to words with start and end. What has to change is the *format*:
emit **ASS** instead, one `Dialogue` event per word group, with `\k` karaoke
timing or per-word events and an inline colour override on the emphasised word.
`buildSubtitleFilter` already passes `force_style` to libass, which reads ASS
natively.

Self-contained: one module, its own tests, no other service touched.

### Fonts

The worker image installs `fonts-dejavu-core` and nothing else. The pack wants
Montserrat ExtraBold or Anton.

**libass falls back silently on a missing font** — the Dockerfile says so at
line 44, and it is why that image asserts the DejaVu file exists at build time.
A heavy grotesque added to `BRAND_FONTS` without being added to the image ships
a video in the wrong typeface with no error anywhere. The Dockerfile assertion
must grow a line per new font.

### Motion, and the one thing to re-test

The pack's primary camera move is a slow push-in. `buildVideoFilter` does pans
only, and the comment above `PAN_EXPRESSIONS` explains why: `zoompan` computes
per-frame scaling against integer pixel positions and judders unless the input
is pre-upscaled far past the output, which the 1GB worker could not afford.

That reasoning was written about landscape stock clips. It is worth *re-testing*
for this format, because the inputs are different: a generated still at 1024×1536
panned into a 1080×1920 frame is a single decode of a single image, not a
1440p h264 stream. A push-in may now be affordable where it was not. It is a
measurement, not an assumption — and if it still judders, the pans stay and the
format survives, because a slow drift reads as intentional.

### Per-boundary transitions

`TransitionStyle` is global: enabled or not, one duration, applied at every
join. The pack wants hard cuts everywhere and one six-frame dip-to-black before
NAME_IT.

`planRender` already builds a `TransitionJob[]`, one per adjacent pair — the
structure is per-boundary; only the *decision* is global. Making the caller pass
a style per boundary is a small change to a function that already loops over
them.

### Beat-aware music

The pack asks for no drums until the TURN beat. Framecast mixes one bed for the
whole video. This is the one item that is genuinely disproportionate: it needs
either two music assets and a timed crossfade, or a provider that returns stems.
**Recommended: drop it.** It is the least visible rule in the pack and the most
expensive to honour.

## What is config and what is code

| | |
|---|---|
| **Config only** | The script prompt, the visual prompt, the metadata prompt, the vertical format, three-word captions, music gain, voice settings, the topic bank |
| **Small code** | `Scene.beat`, `Scene.emphasis`, `VoiceStyle.similarity`, per-boundary transitions, a footage style, fonts in the image |
| **Real code** | ASS captions with per-word timing and emphasis colour |
| **Measurement first** | Push-in versus pan |
| **Recommended out** | Beat-aware music, a text-to-video provider, ranked title CTR prediction |

## The validator

The pack ships a TypeScript validator. It drops in essentially as written, to
`src/lib/knowsense-script.ts`, with its own tests — it is pure, and this codebase
tests pure logic. Two changes:

- The banned-phrase list belongs beside it as an exported constant so a test can
  assert the list is applied rather than restating it.
- The timing-drift check compares declared durations against `words / 2.6`.
  Keep it as a *script* check, but do not let it reach the renderer: the render
  uses alignment, so a drift that matters will show up as a real number there.

The retry loop the pack describes — re-call with the validator errors appended,
once, then regenerate — matches what `scriptService` already does for structured
output failures.

## Phasing

1. **The preset.** Vertical, generated stills, existing pan, three-word captions,
   ducked music, and the pack's three prompts. Produces a real video of this
   format on the pipeline as it stands today. Nothing here is new code.
2. **Kinetic captions and the fonts.** The two things that separate rough from
   convincing.
3. **`Scene.beat` and `emphasis`, per-boundary transitions.** The dip-to-black
   and the stressed words.
4. **Push-in, if it measures well.**

Phase 1 is worth doing on its own even if nothing after it happens.

## Out of scope

- Text-to-video. Stills plus motion first; revisit if the look demands it.
- Any use of the reference channel's scripts or transcripts. The format is the
  product; the words are not, and rewrites inherit somebody else's topic choices
  along with the risk.
- The `concept_is_real` allow-list as a hard gate. Worth having, but it is a
  content decision the operator owns, not a rendering one — and a wrong
  allow-list refuses good scripts as confidently as it catches bad ones.
