# The doodle format

*2026-08-21*

## What this is

A production format, not a channel. Up to five minutes, landscape, no
presenter: hand-drawn stick figures on paper, one picture every five to twenty
seconds, cut hard on sentence ends. It is the look of the faceless
doodle-storytelling channels — still images, no animation, and a cutting rhythm
fast enough that the stillness is never the point.

The operator brought a reference: a channel with fourteen videos, 137k
subscribers and 14.5M views in two months, whose best video has 7.5M views and
consists entirely of stick figures held for a few seconds each. The tutorial
explaining it prescribes a nine-step manual workflow across five tools. Framecast
already performs eight of those nine steps automatically. This document covers
the ninth — the look and the rhythm — and is honest about what is a setting,
what is new code, and what it deliberately does not do.

## Why this needs no second renderer

`planStoryBeats` has two plans, and only one of them is the twenty-second
bedtime pacing. The other is already the plan this format wants:

```ts
if (isBeatScripted(anchored) || isShotScripted(anchored)) {
  return anchored.map((cue, index) => ({ sectionIndices: [index], cues: [cue.cue] }));
}
```

One picture per cue, `BEAT_MIN_SECONDS` not applied, `MAX_BEATS` not applied.
Two formats already take that path — the single-insight short and the long-form
list — and `story-beats.ts` documents both, including the sentence that decides
this whole design: *"Nothing here asks for that arithmetic; asking for forty
sections is what performs it."*

So the doodle format's cadence is chosen by asking the writer for a particular
number of sections and having it tag every one. No cadence argument is threaded
anywhere, and the seam that carries it — `ScriptVersion.cues` — is one every
consumer already reads.

That matters more than it looks. `planStoryBeats` is called from three places —
`footage.service.ts:891`, `render.service.ts:364`, `shorts.service.ts:581` — and
its design premise, stated in its own doc comment, is that the grouping must be
"derivable from data both of them have, without a stored plan that could drift
from the script". A channel-stored cadence passed as a third argument would put
three separate fetches behind that premise; if one drifted, pictures would play
against the wrong words and nothing would throw. The tagged path has no such
failure mode because there is nothing to fetch.

## What already exists

| The format needs | Framecast today |
|---|---|
| Script written to a section count | `SCRIPT_STYLES` templates with `{{duration}}` |
| One picture per section | `planStoryBeats`'s tagged path |
| Pictures timed to the spoken words | `anchorCues` → `cueWindows` → `sectionDurations` |
| Cuts landing on sentence ends | Falls out of per-section timing |
| Character-level narration timestamps | ElevenLabs `Alignment`, stored at `captions/alignment.json` |
| Generated stills, no stock search | `FOOTAGE_SEARCH_PLAN`'s `CINEMATIC` arm |
| A per-channel look composed into every prompt | `ART_STYLES` + `composeArtStyle` |
| Per-beat idempotent generation and retry | `collectGenerated` |
| A render that refuses a missing picture | `render.service.ts` + `missingBeats` |
| Metadata, thumbnail, shorts, upload | Unchanged |

Nothing in the render path changes. Same encoder settings, same caption
pipeline, same narration, same resolution.

## What is new

### 1. `ART_STYLES` gains `doodle-marker`

`src/lib/art-styles.ts` sets an explicit bar for entry: an entry qualifies only
if the same character survives a dozen generations in it, which is why the file
excludes ink wash, chalk pastel and impressionist brushwork. A stick figure
clears that bar more easily than anything already in the catalogue — there is
almost nothing in it to drift.

Written to the file's own convention (medium, line quality, palette, lighting
model; never a proper noun; colour behaviour stated):

```
Hand-drawn marker doodle on paper. Stick figures with round solid-black heads
and simple straight-line limbs, drawn in a single thick black felt-tip line of
even weight; no shading, no gradients, no rendered form. Warm off-white paper
with faint grain. Two accent colours only — a flat red and a flat blue — used
sparingly as fills and repeated exactly; everything else is black line on
paper. Flat even light, no shadows. Subject centred with generous empty margin
above and below.
```

Two clauses in that prompt are load-bearing and are argued under **Quality**
below: *warm off-white paper* and *subject centred*.

### 2. `FootageStyle` gains `DOODLE`

`FOOTAGE_SEARCH_PLAN` gets a `{ kind: "DOODLE" }` arm, routed into
`collectGenerated` beside `ILLUSTRATED`, `CINEMATIC` and `MIXED`.

It **reads no character sheet**, like `CINEMATIC` and unlike `ILLUSTRATED`. The
line style is the consistency; there is nothing to pre-generate. A doodle channel
can therefore produce its first video without visiting the branding screen at
all, which `ILLUSTRATED` cannot.

`GENERATED_STYLE_NOUN` gains `DOODLE: "Doodle"` so a refusal names itself.

### 3. `ChannelBrand.beatSeconds Int?`

The operator's seconds-per-picture. Range **5 to 20**, refused outside it at the
boundary in `updateBrandingSchema`.

Under five is a strobe rather than a video. Over twenty is what `ILLUSTRATED`
already does, so a channel wanting that should choose `ILLUSTRATED` rather than
a doodle style imitating one.

Nullable with no default, for the reason `artStyle` is: a default would pick a
rhythm for a channel that never asked for one. Null on a `DOODLE` channel is
refused at script generation with a message naming the setting.

**Read in exactly one place: `script.service.ts`.** `footage.service.ts`,
`render.service.ts` and `shorts.service.ts` never learn the column exists.

### 4. A `doodle-story` script style, and how the number reaches the model

A new `SCRIPT_STYLES` entry modelled on `longform-list`, which is the closest
existing sibling: both decide their own picture count, both tag every cue.

The differences from `longform-list`: five minutes instead of eight, every
section tagged `[still]` rather than `[still]`/`[motion]` (a doodle channel has
no use for stock footage), and a section count that is computed rather than
written into the template.

That last one needs care. The count cannot be a `{{variable}}`.
`script.service.ts:193` already documents why: `renderTemplate` treats the
template's declared variables as authoritative and deliberately leaves an
undeclared `{{placeholder}}` unsubstituted so a typo stays visible — so
injecting a token would print it verbatim in every template that does not
declare it. Appending prose to `template.content` is worse: it silently edits
the operator's own template and then stores the edited text in
`ScriptVersion.prompt`, whose entire job is to record what the template said.

There is already a sanctioned path for a brand-derived fact:
`recurringCharacterInstruction(brand)`, sent as a **system instruction beside
the prompt, never inside it** (`script.service.ts:213`). `doodleCadenceInstruction`
follows it exactly — it computes `round(targetSeconds / beatSeconds)`, states the
section count and the tagging rule, and leaves the operator's template
untouched and stored verbatim.

At the default five minutes and seven seconds a picture: 300 / 7 = **43
sections**. At 150 words a minute that is 750 words, so ~17 words a section —
short lines, which is what the genre reads like.

### 5. The five-minute cap

Enforced in `script.service.ts`, on the template's `duration` variable, and not
in `story-beats.ts`.

That location is not arbitrary: it is the same call in the same service that
already reads `beatSeconds` (§4), so the two numbers whose product is the
picture count are validated together, once, against each other. A cap enforced
anywhere else could be satisfied by a duration the cadence instruction never
saw.

Enforcing it in `story-beats.ts` instead is ruled out by that file. `MAX_BEATS`
is explicitly not applied on the tagged path, and it says why: *"the writer's
count is the count, it arrived with the script, and capping it would drop shot
forty-one silently — leaving the last minute of narration with no picture over
it to save five cents."* So the money ceiling has to come from the length limit
instead.

| beatSeconds | Pictures at 5 min | Image cost |
|---|---|---|
| 5 (fastest allowed) | 60 | ~$3.00 |
| 7 (expected default) | 43 | ~$2.15 |
| 12 | 25 | ~$1.25 |
| 20 (slowest allowed) | 15 | ~$0.75 |

The worst case a doodle channel can reach is $3.00, against the ~$2.00 ceiling
`MAX_BEATS` enforces for an illustrated video today. At the expected seven
seconds it is $2.15 — the same order as what the app already spends.

### 6. The style picker

The art style control today is a `<Select>` showing only the style's name
(`branding-form.tsx:494`), with the description rendered under the field one
style at a time. Comparing six looks means opening the menu six times and
reading six sentences, having seen none of them. That is the wrong control for
a decision that is entirely visual.

It becomes a card grid: one card per style, each with a sample image, the name,
and the description beneath. Footage style gets the same treatment for the same
reason.

**Sample images are generated once and committed** to
`public/art-styles/<id>.webp` — seven styles at ~$0.05 is **$0.35 one time,
ever**, not per channel and not per view. Same reasoning `art-styles.ts` already
gives for being code rather than database rows: the app ships with them whether
or not a seed has run, and improving one improves it for every channel.

Every sample draws the **same subject** in each style. A different subject per
card would ask the operator to compare two things at once, which is the mistake
the comparison protocol below exists to avoid.

`branding-form.tsx` is 984 lines and dropping a card grid into it makes a large
file larger, so the picker is extracted to
`src/features/channels/components/art-style-picker.tsx`. That is the only
refactor proposed here; the rest of the form is not touched.

## Quality: the three places this could come out worse

The operator's requirement is that output quality does not drop. Three specific
ways it could, all closed in the prompt rather than in the renderer.

**Motion off, and it is a gain rather than a saving.** `ffmpeg-command.ts:189`
records a measurement: at the default `scale: 1.15` pan the crop window travels
0.48px a frame, `x` quantises to an integer, and the picture is frozen for
**75.7% of adjacent frame pairs**. On a photograph that judder hides. On a thick
black line against pale paper it sits exactly where the eye is and reads as a
broken encode. The alternative, `kenburns`, is smooth but pre-upscales the
source 4x — forty-three times a video, for a move this genre does not use. So
`DOODLE` renders with `motion: { enabled: false }`: hard cuts on static frames,
which is both what the reference does and one less upscale past the frame.

*Where that is applied* is worth stating, because there are three plausible
places and two are wrong. Not on the branding screen — `brand.service.ts:106`
records that the screen deliberately does not edit `videoStyle`. Not in
`render.service.ts` — `shorts.service.ts` re-composes through the same
`composer.ts` and would need the same override, which is two places to
disagree. It goes in `brandService.resolve`, which already merges the stored
style over `DEFAULT_STYLE` and is the single source both consumers read
(`render.service.ts:525`). The merge gains one layer, so the order becomes
**`DEFAULT_STYLE` → the format's default → the operator's stored style**.
Putting the format default *under* the stored style is the part that matters:
an operator who has explicitly set motion on a doodle channel still wins, and
the format only supplies a better starting point than the global default.
`mergeVideoStyle` takes `footageStyle` from the brand row it is already
reading.

**Warm off-white paper, not white.** Burned-in captions are
`PrimaryColour=&H00FFFFFF` — white — with a 2px black outline
(`ffmpeg-command.test.ts:718`, pinned by a test that exists so the string cannot
drift). White text with a thin outline on pure white paper is a muddy,
low-contrast mess. Specifying off-white paper in the art prompt gives the
outline something to sit against, keeps the captions exactly as legible as they
are on every other style, and leaves the pinned `force_style` string untouched.
It also reads more like marker on real paper than pure white does.

**Subject centred.** A landscape still is generated at 1536x1024 (3:2) and
covered into 1920x1080, so the top and bottom ~15% of every picture is cropped
away. `longform-list` already instructs its writer to keep the subject centred
for the same reason; the art prompt says it too, which additionally keeps
vertical Shorts cut from these videos intact.

## Failure handling

Nothing new is required, which is the point of routing through
`collectGenerated`. It is already idempotent per beat — a re-run generates only
the beats whose image is missing — a failed beat is named in `missingBeats`
rather than skipped, and `render.service.ts` refuses to render until it exists.
One failure in forty-three costs one retry of one picture.

### The correction the first real generation forced

This section originally specified that the doodle script would ask the writer to
tag every section `[still]`, copying `longform-list`, and that a partly tagged
script would raise a warning. The first generation against a real model returned
**forty-three sections and tagged none of them**. The warning fired correctly and
said so — but a warning is a detector, and the failure did not need detecting.
It needed removing.

Two things were wrong with tagging here, and only the second is about the model:

1. **There was never a judgement to record.** `longform-list` asks for a tag
   because its writer is genuinely choosing between drawn and filmed. A doodle
   channel draws everything. The answer is `still` for every section of every
   doodle video that will ever be made, so asking is asking the model for one
   more thing to get wrong for no information in return.
2. **The gate was on the wrong thing.** Cue parsing in `script.service.ts` is
   keyed off `input.format`, so tags would only have been read for a generation
   that passed `format: "longform"`. A doodle channel generating from any other
   template would have produced untagged cues and rendered at one picture every
   twenty seconds, silently.

So `doodleCues` sets `shot: "still"` in code, keyed off the **channel** rather
than off a format string, and the prompt asks for no tags at all. This deletes
the failure mode rather than reporting it, which is why the untagged-cue warning
no longer exists.

`readShotTag` still runs over each cue, for one reason: a model may volunteer a
tag anyway, and `[still]` left in the cue reaches the illustration prompt as
literal text and gets **drawn** — the exact thing `beatDoodlePrompt`'s no-text
rule exists to prevent, arriving from inside the pipeline instead of from the
model's habits.

## The comparison, and what it decides

The operator asked to see the expensive version against the cheap one before
committing. The naive form of that test is confounded — at twenty seconds a
picture the writer produces ~15 sections, so the two videos would have different
scripts and the comparison would be judging two variables.

Instead, one script and one narration, rendered twice:

- **Video A** — normal render: 43 pictures, one every 7s.
- **Video B** — the same video with the tagged path bypassed, so
  `planStoryBeats` groups it to ~15 pictures at 20s.

Same words, same voice, same length, same art style; the only variable is
cutting speed. Cost for the pair: 58 images ≈ **$2.90**.

**What the comparison also measures:** forty-three sequential generations is a
much longer footage stage than twelve. If each takes ~8 seconds that is ~6
minutes before the render starts. This document does not guess at that number.
If video A shows it is unacceptable, the fix is concurrency inside
`collectGenerated` — a separate change, deliberately not designed here.

## What this does not do

- **No pause-snapped cuts.** `sectionDurations` already times every picture off
  the real ElevenLabs alignment, and one picture per section means cuts already
  land on sentence ends. Snapping to detected silences on top of that is a
  refinement worth measuring after video A exists, not before.
- **No per-video cadence override.** `beatSeconds` lives on the channel only.
  A per-video column was considered and dropped: the comparison protocol above
  needs no override, and a channel whose rhythm changes video to video has no
  rhythm.
- **No stock footage.** A doodle channel generates every picture. `MIXED` exists
  for formats that want both.
- **No concurrency in `collectGenerated`.** See above.
- **No character sheet support.** Deliberate, per §2.

## Testing

| What | Where |
|---|---|
| `doodle-marker` is in the catalogue and resolves | `art-styles.test.ts` |
| `doodleCadenceInstruction` computes the section count | new unit test, pure function |
| A fully tagged doodle script yields one beat per cue | `story-beats.test.ts` |
| A partly tagged script does **not**, and warns | new test — this is the silent failure |
| `beatSeconds` outside 5–20 is refused at the boundary | `brand.service.test.ts` |
| A `DOODLE` channel with null `beatSeconds` is refused | `script.service.test.ts` |
| A doodle video over 5 minutes is refused | `script.service.test.ts` |
| `DOODLE` resolves to motion disabled | `brand.service.test.ts` |
| An operator's explicit motion setting still wins over it | `brand.service.test.ts` |
| `DOODLE` needs no character sheet | `footage.service.test.ts` |

## Migration

`ChannelBrand.beatSeconds Int?` and `FootageStyle.DOODLE`. Nullable with no
default, so **no backfill**: an existing channel is unaffected, and a channel
nobody has touched behaves tomorrow as it does today.

Two operational notes, both of which have caused real incidents here:

- The migration folder must be named **`20260905090000_add_doodle_format`**, not
  a folder dated today. The existing folders run ahead of the calendar — the
  latest is `20260904090000_add_credits` — and a folder dated 2026-08-21 would
  file this migration into the middle of history and run in the wrong order.
- **Migrations are not applied by any deploy step.** This one must be run by
  hand. An unapplied migration adding a column that the app then selects turns
  every affected request into a 500 with a missing-column error.
