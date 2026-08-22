# Animated cuts

*2026-08-22*

## What this is

A production format: a vertical short, sixty seconds by default, whose pictures
are generated cel-look stills cut every two seconds. The feel of an action
edit — fast shot-to-shot cutting, dramatic framing, a new size of shot every
time — produced entirely from frames this app generated itself.

The operator's ask was for "the feel of anime / cartoon / movie editing" with
"best cuts energy". This document takes that as a statement about **cutting and
framing**, not about motion, and the argument for that reading is the whole of
§3.

## 1. The constraint that shapes everything

**No footage from anime, cartoons or films. Not a frame, not a second.**

Three reasons, stated plainly because they are business facts rather than
squeamishness:

- **Content ID matches at any length.** It fingerprints the reference audio and
  video, and a two-second cut from a film is a match. There is no clip short
  enough to be safe and no transformation this pipeline performs that defeats
  it — the frames would go through unaltered except for a crop and a caption.
- **These channels are monetised and auto-publish.** `auto-publish.service.ts`
  puts videos live without anybody watching them first. A claim is not a
  conversation the operator gets to have; it is revenue diverted or a strike
  landing on a channel that will publish again tomorrow on its own.
- **The house rule already exists and this format must not be its exception.**
  `art-styles.ts` has a section headed *"No living artist, no studio, ever"*,
  and its argument is that a channel whose look is "in the style of X" is built
  on somebody else's IP and somebody else's livelihood — and that it is also
  worse prompting, because a technique tells a model something it can act on
  and a proper noun tells it to guess.

So the format is an anime *technique*, described as medium, line quality,
palette and lighting model. Never a studio, never a title, never a character.
See §4, which also explains why the word "anime" appears nowhere in the prompt
itself.

The existing `CARTOON` footage style is not the answer either, and not for
copyright reasons — Pixabay's library is licensed. It is the wrong library.
`footage-styles.ts` already records the finding: `video_type=animation` means
"rendered rather than filmed", so it returns motion-graphics loops and photoreal
renders as often as anything drawn.

## 2. What the style is, concretely

| Element | What it does | Why |
| --- | --- | --- |
| Frame | 1080x1920, full bleed | The format is a Short; the framing list in §5 assumes a tall frame |
| Length | 60s default, 90s ceiling | The ceiling is a money ceiling wearing a length's clothes — see §7 |
| Pictures | One generated still per section, ~30 of them | §3 |
| Cadence | 2.0 seconds a picture, fixed by the format | §6 |
| Shot grammar | A new framing every cut, rotated through a closed list of eight | §5 |
| Transitions | Hard cuts, every join, no exception | Below |
| Motion | Off | Below |
| Captions | Kinetic — one to three words landing on the spoken moment, stressed word coloured | Below |
| Script | 30 sections of four to seven words, third person, one image per line | §6 |

**Transitions off** is not a preference here, it is arithmetic. The default
crossfade is 0.5 seconds (`DEFAULT_STYLE.transitions`). Against a two-second
shot that is a quarter of every picture spent dissolving, and two consecutive
shots are visible simultaneously for a quarter of the video. `render.service.ts`
also derives its slot floor from the longest overlap, so a half-second dissolve
would raise the minimum slot whether or not the narration wanted it. With
transitions off the floor is `MIN_CLIP_SECONDS = 1`, which is the number the
cadence in §6 is checked against.

**Motion off** for the reason `FORMAT_STYLE_DEFAULTS` already gives `DOODLE`,
which applies more strongly here. `ffmpeg-command.ts` records that at
`scale: 1.15` the crop window travels 0.48px a frame, `x` quantises to an
integer, and the picture is frozen for 75.7% of adjacent frame pairs. Over two
seconds that pan travels about 29 pixels of a 1242-pixel-wide source — an
imperceptible drift bought at the price of a visible judder. The alternative,
`kenburns`, is smooth but pre-upscales the source 4x, thirty times a video, for
a move this format does not use. **The cut is the motion.**

**Kinetic captions** because the format cuts faster than a caption line can be
read. At 2.6 words a second (`WORDS_PER_SECOND` in `insight-script.ts`) a
two-second shot carries about five words, which is one or two kinetic chunks. An
SRT cue appearing and disappearing whole would change on almost exactly the same
frames the picture does, and the two would fight.

## 3. Stills or generated motion — the central question

Fast cutting implies either many stills cut fast, or actual generated motion
clips. **This format uses stills.** The argument is not aesthetic; the motion
tier's own gates refuse this format before taste enters it.

### The measured numbers

From `motion.service.ts`'s own doc comment and the constants it enforces:

| Fact | Value | Source |
| --- | --- | --- |
| One measured 5-second clip's wall time | **217 seconds** | `motion.service.ts` |
| Clip length the tier will accept | 4.0–5.0s | `MIN_CLIP_SECONDS` / `MAX_CLIP_SECONDS` |
| Clips per video the tier will accept | 10–12 | `MIN_CLIPS` / `MAX_CLIPS` |
| Billed-seconds ceiling per video | **96** = 12 × 5 × 1.6 | `MAX_BILLED_SECONDS_PER_VIDEO` |
| Surveyed rate | $0.03–$0.25 per second | `motion-spend.ts` |
| What 96 seconds buys | ~$4 at $0.043/s, ~$10 at $0.10/s, ~$24 at $0.25/s | `motion-spend.ts` |
| Everything else in a video | **about $1.50 total** | `motion.service.ts` |
| A generated still | ~$0.05, seconds of latency | `story-beats.ts` |

### The comparison, for one sixty-second video at two seconds a cut

| | Stills | Generated motion |
| --- | --- | --- |
| Shots wanted | 30 | 30 |
| Shots the tier accepts | no limit on the cued path | **12** (`MAX_CLIPS`) |
| Shortest expressible shot | 1s (render floor) | **4.0s** (`MIN_CLIP_SECONDS`) |
| Billed for a 2-second shot | one picture | four seconds, two discarded |
| Video total | 30 × $0.05 = **$1.50** | 30 × 4s × 1.6 = **192 billed seconds** |
| Against the ceiling | n/a | **2× over 96** — `planMotionSpend` refuses |
| If it did not refuse | — | $8 to $48 |
| Wall time | ~2–4 minutes | 30 × 217s = **1h 49m**, serialised |

### Three structural refusals, not three opinions

1. **`MAX_CLIPS = 12`.** A thirty-clip manifest fails `checkManifest` before a
   row is written.
2. **`MIN_CLIP_SECONDS = 4.0`.** A two-second shot cannot be expressed at all.
   You would buy four seconds and throw two away — paying double for the
   privilege of the format's defining property.
3. **`MAX_BILLED_SECONDS_PER_VIDEO = 96`.** Thirty shots is 192 billed seconds.
   `planMotionSpend` refuses, and `motion.service.ts` is explicit that this is a
   refusal and not a warning, "because by the time a warning has been read the
   money is spent."

`motion.service.ts` states the conclusion itself, one format early: *"It does
not stretch a clip to fill a still's slot… this tier serves formats that cut at
four to five seconds and no others."* Animated cuts is a format that cuts at
two.

### And the deeper reason, which survives even if the numbers changed

The motion tier exists for footage whose energy is *inside* the frame — a slow
push in, a rack focus, a drift left. This format's energy is *between* frames. A
two-second generated clip has time to begin a camera move and not finish it,
which reads as a stumble rather than a shot. Thirty of those in a row is not a
faster version of the motion tier; it is the motion tier used against its grain
at forty times the price.

**Decision: stills, cut fast. No `MotionClipJob` row is ever written by this
format.**

## 4. The art style fragment

### It is a constant, not an `ART_STYLES` entry

`CINEMATIC_STYLE_BIBLE` already established the precedent and stated the reason:
the catalogue is a *choice an illustrated channel makes*, and offering a look
there that belongs to one format "would let a children's bedtime channel select
photoreal footage of strangers with two clicks."

There is also a hard mechanical blocker, and it is the decisive one.
`composeArtStyle` prepends `SHARED_DIRECTION` to every catalogue entry:

> *"Illustration for a children's picture book. Nothing frightening, nothing
> sharp, nothing photoreal."*

"Nothing sharp" and "children's picture book" are the exact opposite of this
format's grammar. An `ART_STYLES` entry would inherit them and could not opt
out — the file's own doc comment says keeping the invariant half out of the
catalogue is deliberate, "so a new style cannot accidentally drop it." A
constant read by its own composer inherits nothing.

So: `CEL_STYLE_BIBLE`, a constant in `art-styles.ts` beside
`CINEMATIC_STYLE_BIBLE`, with a `composeCelShot` composer beside
`composeCinematicShot`.

### The text

```
Hand-inked cel animation frame. Clean confident ink outlines of varying weight,
heavier on the silhouette edge and finer inside the form. Flat cel shading: two
tones per surface, a base and a shadow, with a hard-edged boundary between them
and no gradient inside either. One warm rim light along the edge facing the key.
Painted background in soft airbrushed gradients, held a step less saturated than
the foreground so figures separate from it. A fixed palette repeated exactly in
every frame: deep teal shadows, warm amber key light, off-white highlights.
Faint paper grain over the whole image and a soft bloom around the brightest
areas. Dramatic composition — strong diagonals, deliberate empty space, the
horizon placed away from centre. No text, no words, no letters, no logos, no
watermark and no caption bar anywhere in the image. Do not draw any existing or
recognisable character, mascot, uniform, insignia, logo or title card.
```

### Two words that are deliberately absent

**"Anime" is not in the prompt.** It appears in the operator-facing name and
description and nowhere else. It is the single token most likely to make a model
reach for a recognisable character design, and a recognisable character design
is the copyright risk arriving through the front door after §1 locked the back
one. It is also, by the file's own argument, worse prompting: "two tones per
surface with a hard-edged boundary" is something a model can act on.

**No studio, no film, no artist**, per the house rule. The final sentence states
the negative explicitly rather than relying on the absence of a positive,
because a model handed "cel animation frame, dramatic composition" will
volunteer a familiar silhouette if nothing tells it not to.

## 5. Shot grammar

The look is half of it. The other half is that **consecutive shots differ in
size**, because that is what makes cutting read as cutting rather than as a
gallery. Handed an open brief, an image model returns the same medium-wide
composition every time, and thirty identical framings cut fast is a slideshow
played at speed.

So a closed list, exactly as `CAMERA_MOVES` in `render-manifest.ts` is a closed
list, and for the reason that file gives: "one handheld or whip pan among eleven
locked-off shots does not read as variety, it reads as a different video spliced
in."

```ts
export const CEL_FRAMINGS = [
  "extreme wide, the figure small against a large sky",
  "low angle looking up, the figure filling most of the frame",
  "extreme close on the eyes, the rest of the face cropped away",
  "over the shoulder, the subject soft in the background",
  "insert on the hands or one object, shallow focus",
  "silhouette against a bright field, no interior detail",
  "high angle looking straight down",
  "profile two-shot with empty space between the figures",
] as const;
```

Assigned by beat index — `CEL_FRAMINGS[index % CEL_FRAMINGS.length]` — which
buys three properties for nothing:

- **Deterministic.** `collectGenerated` is idempotent per beat and a re-run must
  redraw a failed beat with the framing it was always going to have.
- **No adjacent repeat**, guaranteed by construction rather than by a check.
- **A full cycle every eight shots**, so a thirty-shot video visits every
  framing three or four times and none of them twice in a row.

`composeCelShot` puts the bible in whole and identically every time, the beat's
own cue as the subject, and exactly one framing line — the same split
`composeCinematicShot` documents as "the entire defence against twelve shots
that look like twelve different films".

## 6. Cadence, and why it is a constant rather than a setting

**`CEL_BEAT_SECONDS = 2.0`.** Fixed by the format. No column, no migration.

- **The floor is 1.5s.** Below that the picture changes faster than the caption
  chunk under it — at 2.6 words a second a 1.5-second shot is four words, which
  is one kinetic chunk, and a shot that shows one chunk is a flash rather than a
  frame.
- **The ceiling is 3.0s.** `insight-script.ts` puts its own scenes at 2.5–5.0
  seconds, and above three seconds this format *is* the insight short with a
  different palette.

**Why not an operator setting, given `DOODLE` made cadence one.** `DOODLE` made
it a setting because its reference channels genuinely run five to twenty seconds
and `footage-styles.ts` says so: "it is the whole feel of the format". The
animated-cuts band is 1.5–3.0, and the difference between 2.0 and 2.5 is not a
channel's identity — it is a tuning knob nobody can evaluate without spending
$1.50 per experiment.

There is a concrete obstacle too, worth recording so a later change knows what
it costs. `ChannelBrand.beatSeconds` is validated as an integer between
`DOODLE_BEAT_MIN_SECONDS` and `DOODLE_BEAT_MAX_SECONDS`. A two-second cadence
fails on both the floor and the integer check. Making it a setting therefore
means turning a flat field rule into a cross-field refine keyed on
`footageStyle`. Deferred, not forgotten.

### How the cadence reaches the model

Exactly as the doodle format's does, in a new `src/lib/cel-cadence.ts`:

```ts
export const CEL_BEAT_SECONDS = 2.0;
export const CEL_MAX_SECONDS = 90;
export const CEL_MIN_SECONDS = 30;

export function celSectionCount(targetSeconds: number): number {
  return Math.max(1, Math.round(targetSeconds / CEL_BEAT_SECONDS));
}
```

- `celCadenceInstruction(count)` is sent as a **system instruction beside the
  operator's prompt, never inside it** — `script.service.ts` documents why.
- It asks for a section count **and a word count per section**: "exactly 30
  sections of four to seven words each." At two seconds a shot, a count alone is
  not enough. The arithmetic closes: 30 × 5.5 words = 165 words, and 165 words
  at 2.6 words a second is 63 seconds against a 60-second target.
- `celCues(sections)` sets `shot: "still"` **in code**, keyed off the channel's
  `footageStyle` and not off a format string. This is the correction a real
  generation already forced once on the doodle path: asked to tag forty-three
  sections the model tagged none.
- `readShotTag` still runs over each cue: a volunteered `[still]` left in the
  cue reaches the image prompt as literal text and gets **drawn**.
- The stress word for kinetic captions uses the same `stressWord` heuristic,
  which should be lifted out of `doodle-cadence.ts` into a shared module rather
  than copied.

`planCelGeneration` refuses, before the first billed call, a duration outside
`CEL_MIN_SECONDS`–`CEL_MAX_SECONDS`. The lower bound matters more than it looks:
`sectionDurations` has a degenerate branch when the section count times the
floor exceeds the narration, and this is the only format that gets near it.

## 7. Cost

Planning is against **$0.05 a still**, the figure `story-beats.ts` uses.
`ProviderUsage` has recorded lower per-image costs, and those are believed to
under-report output tokens. Planning against the lower number is the dangerous
mistake.

| Length | Pictures | Images | + rest of pipeline | Total |
| --- | --- | --- | --- | --- |
| 30s (floor) | 15 | $0.75 | ~$1.50 | **$2.25** |
| 60s (default) | 30 | $1.50 | ~$1.50 | **$3.00** |
| 90s (ceiling) | 45 | $2.25 | ~$1.50 | **$3.75** |

**Against the $20 gateway budget cap the account recently hit**: at $1.50 of
images a video that is thirteen videos, and at the worst case eight. That is a
live constraint and it is the reason the cadence is 2.0 and not 1.5 — the extra
half-second is worth $0.75 a video, which is four more videos before the cap.

## 8. The preset entry

```ts
{
  id: "animated-cuts",
  name: "Animated cuts",
  description:
    "Cel-look frames cut every two seconds, a new size of shot each time, with " +
    "captions landing a word at a time. The most energetic look here and the " +
    "most expensive per second — thirty generated pictures in sixty seconds — " +
    "and it cannot hold a recurring character.",
  footageStyle: "CEL",
  scriptStyleId: "animated-cuts",
  video: {
    motion: { enabled: false, scale: DEFAULT_STYLE.motion.scale },
    transitions: { enabled: false, durationSeconds: DEFAULT_STYLE.transitions.durationSeconds },
    captionMode: "kinetic",
  },
}
```

No `artStyle`: this style carries its own look in code, like `CINEMATIC`. No
`beatSeconds`: the format decides, which is what an absent field means. The
description names the trade-off rather than selling the look — both of its
costs are stated, the money and the missing character.

## 9. Script format: a new `SCRIPT_STYLES` entry, and no new `ScriptFormat`

**No new `ScriptFormat`.** A new member earns its place only when there is a
structured generator with a validator behind it. Here the expensive thing is the
picture count, and that is already what the cadence instruction asks for and
what `celCues` guarantees. The doodle format reached the same conclusion.

**A new `SCRIPT_STYLES` entry, `animated-cuts`.** Its closest sibling is
`vertical-short` — the only existing style measured in seconds rather than
minutes. It differs in three ways:

1. **Sixty seconds, not forty-five**, so `targetSeconds: 60`.
2. **No section count in the template.** The count is computed per generation
   and arrives as a system instruction, so the template must not contradict it.
3. **Written in lines, not sentences.** Third person, one image per line, no
   clause that needs a second clause to land.

**Why not `insight`.** Its validator pins 10–14 scenes at 2.5–5.0 seconds, six
named beats in a fixed order, 95–150 total words, and a second-person register
about a psychological effect. Every one of those is wrong here.

## 10. `FootageStyle`: a new value, `CEL`

### Why not reuse one

| Candidate | Why not |
| --- | --- |
| `ILLUSTRATED` | Refuses without a brief, art style and sheet; groups at 20s; carries the children's-picture-book direction |
| `CARTOON` | Stock, and the wrong stock — see §1 |
| `DOODLE` | `planDoodleGeneration` keys on this enum value and imposes a 5–20s cadence; the branding copy promises stick figures |
| `MIXED` | Searches stock for `motion`-tagged shots; this format has none |
| `CINEMATIC` | Mechanically identical, but it is *one* style with *one* bible and `composeCinematicShot` is called unconditionally. Reusing it would need a second discriminator on the brand row — and the enum value **is** that discriminator |

### Naming

`CEL`, not `ANIMATED`. `ANIMATED` promises motion this format does not deliver,
and the app already has one style whose name over-promises — `CARTOON`, whose
description spends a sentence walking it back. The operator-facing label is
"Animated cuts", where a description is available to explain.

### The three predicates

| | `isGeneratedFootage` | `stylePicksArtStyle` | `needsCharacterSheet` |
| --- | --- | --- | --- |
| `ILLUSTRATED` | yes | yes | yes |
| `DOODLE` | yes | yes | no |
| `CINEMATIC` | yes | no | no |
| **`CEL`** | **yes** | **no** | **no** |

`CEL` answers all three exactly as `CINEMATIC` does. That is fine, because
nothing reads a predicate to choose a prompt — `collectGenerated` branches on
`kind`. The predicates answer operator-facing questions ("will this cost
money", "show the art-style field", "show the character card") and on all three
the two styles genuinely have the same answer.

### The rest of the wiring

`FootagePlan` gains `{ kind: "CEL" }`; `FOOTAGE_SEARCH_PLAN` gains the arm;
`GENERATED_STYLE_NOUN` gains `CEL: "Animated cuts"`; `collectGenerated`'s prompt
branch gains a fourth arm calling `composeCelShot`; the `holds` progress string
gains a fourth arm so it does not print "cinematic" and send somebody looking
for a photographic style that was never running.

**Nothing in the render path changes.**

## 11. What this explicitly does not do

- **No generated motion, ever.** §3. If a cheaper video model arrives, re-argue
  against `MIN_CLIP_SECONDS = 4.0` first, because that constant refuses the
  format independently of price.
- **No recurring character.** The format's biggest aesthetic compromise, stated
  in the preset description rather than hidden. Making the sheet *optional*
  rather than *required* needs a fourth predicate (`offersCharacterSheet`) plus
  replacing the `illustrated` local in `collectGenerated`, which conflates three
  questions today.
- **No speed lines, impact frames or flash cuts as render effects.** A white
  flash would be a new `TransitionKind`, a new stub encode at every join, and a
  change to `buildTransitionArgs`. Hard cuts cost nothing.
- **No re-framing one still into several shots.** Punching in on the same frame
  would halve the picture cost and is what an action edit does, but it means two
  beats pointing at one asset with different crop windows — new code in
  `planRender` and `buildSegmentArgs`.
- **No music-synced cutting.** Cuts land on sentence ends because
  `sectionDurations` times them off the narration alignment.
- **No new `ScriptFormat`.** §9.
- **No landscape tuning.** The framing list assumes a tall frame.
- **No cadence setting.** §6.

## 12. Testing

**Pure units, no database, no network.**

- `celSectionCount` at the floor, default and ceiling.
- `planCelGeneration` refuses under 30s and over 90s, *before* the charge.
- `celCues` sets `shot: "still"` on every section, including one whose cue
  arrived with a volunteered `[still]` tag, which must be stripped.
- The framing rotation: deterministic per index, never repeated adjacently,
  every framing used across thirty shots.

**Prompt guards — the tests that cannot be reasoned about after the fact.**

- `composeCelShot` contains the bible verbatim, exactly one framing line, and
  the no-text clause.
- **A deny-list assertion**: the composed prompt contains none of "anime",
  "manga", "studio", and a handful of studio-shaped and franchise-shaped words.
  Cheap, and it is the one guard §1 depends on.

**Style resolution.** `styleBaseFor("CEL", preset.video)` resolves to motion
off, transitions off, kinetic captions — and **loses to an operator who
explicitly asked for motion**.

**Collection, with a fake `ImageProvider`.** Thirty beats produce thirty
generations and zero stock searches. Per-beat idempotency after one refusal. And
**a spend assertion**: a 90-second script cannot produce more than 45
generations, counted on the fake provider — the ceiling in §7 expressed as a
test rather than as a paragraph.

**One real video.** Sixty seconds, watched end to end, compared against
`insight-short` on the same topic. The two questions this document cannot
answer: whether thirty frames without a recurring character read as one film,
and whether two seconds is the right number.

## Open question for the operator

Whether the format should carry a character sheet after all (§11). It is the
single largest quality lever available, it costs one generation per channel
rather than per video, and the machinery is nearly all there. It is left out
because it turns a style a channel can use immediately into one that requires a
branding-screen visit first — and because the answer should come from watching a
video rather than from this document.
