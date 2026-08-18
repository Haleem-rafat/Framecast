# The long-form hybrid: eight minutes, mostly stills

*2026-08-18*

## What this is

An eight-minute horizontal video in a list format — seven segments — whose
pictures come from more than one source in the same timeline: generated stills
that actually move, and stock clips for the shots that need real motion. Plus
vertical Shorts cut from the same run.

The operator supplied a spec proposing a three-tier asset economy — 25%
generated motion clips, 55% generated stills with Ken Burns, 20% reused library
b-roll — at about $8.65 a video against $25–96 for an all-motion equivalent.

This document is the honest version of that. Most of what it asks for already
exists; one of its central claims about cost is wrong in a way that matters; the
Ken Burns it wants to build on is broken today in a way nobody has measured; and
the mix it proposes is, on this codebase's own numbers, the wrong mix.

Everything below that is stated as a measurement was measured. Everything
stated as unverified is named as unverified.

---

## The short version

| | |
|---|---|
| **Recommended mix** | ~80% generated stills, ~20% stock clips, **0% generated motion** |
| **Real cost** | **~$1.60 a video** at the price the code computes; ~$0.29 if the operator's logged figure is right |
| **Blocked on a key** | Only the motion tier — which is recommended out of v1 |
| **Biggest single win** | Fixing Ken Burns. The current pan is frozen for **76% of frame pairs** |
| **Genuinely new code** | A mixed footage plan, and shorts that work on a generated video |
| **Recommended dropped** | The generated-motion tier, the reuse library, dual generation |

---

## Part 1 — What already exists

The single most useful thing to establish first is how little of this is new.
Long-form landscape video is not a new capability being added to Framecast; it
is what Framecast was built to do and what every video it has made until this
month has been.

| The operator's spec asks for | Framecast today |
|---|---|
| Eight minutes, horizontal | `default-script` — `targetSeconds: 540`, "8–10 minutes". `FRAME_SIZES.LANDSCAPE` is the default for every video ever rendered. |
| A list format, seven segments | `countdown` in `script-styles.ts` — `targetSeconds: 360`, with a `count` variable **whose default value is `7`** |
| Generated stills, one per beat | `FootageStyle.ILLUSTRATED` / `CINEMATIC`, `planStoryBeats`, `beatIllustrationPrompt`, `composeCinematicShot` |
| Ken Burns over the stills | `buildSegmentArgs` (`-loop 1`) + `buildVideoFilter` + `PAN_EXPRESSIONS` |
| Reused b-roll | `collectPerCue`'s tier 4 — `nearestAssignedIndex` reuses an already-downloaded clip once `MAX_UNIQUE_SECTION_CLIPS` is hit |
| Stock b-roll | `FOOTAGE_SEARCH_PLAN` — Pexels then Pixabay, keyed per section off the script's own cue |
| Seven vertical Shorts | `shorts.service.ts` — an LLM picks moments, `planShortWindow` resolves them to seconds, `planShortSlots` builds the picture plan, the worker renders them at 1080×1920 |
| A QC gate before spending on generated clips | `render-manifest.ts` — `checkManifest`, `billedSeconds`, `CAMERA_MOVES`, `FORBIDDEN_IN_PROMPT` |
| Timing that survives eight minutes | The two-pass render. Memory is flat in clip count *and* in duration — `buildSegmentArgs` normalises one clip at a time, `buildAssembleArgs` joins with the concat demuxer |

So the answer to "can this app make an eight-minute list video with generated
stills and Ken Burns" is: **it can today, with no code at all.** Pick
`countdown`, set `count` to 7 and `duration` to 8, approve as `LANDSCAPE`, set
the channel's `footageStyle` to `CINEMATIC`. That produces 24 pictures at ~20
seconds each with a slow pan across them.

That is the baseline this spec is arguing with, not a thing it is proposing to
build.

### What is genuinely new, and it is a short list

1. **A footage plan that mixes sources inside one video.** `FootagePlan` is a
   tagged union — `STOCK`, `ILLUSTRATED`, `CINEMATIC` — and a channel is
   entirely one of them. There is no plan that generates some shots and
   searches for others. This is the actual "mixed asset economy", and it is the
   only structural change in the whole proposal.
2. **A Ken Burns move that moves.** See Part 3; this is a bug fix wearing a
   feature's clothes.
3. **Shorts from a generated-stills video.** They do not work at all today —
   see Part 6.
4. **Image spend reaching the cost tables.** It never has — see Part 2.
5. A video-generation provider. Blocked on a key, and recommended out.

---

## Part 2 — The cost table, and the $0.006

### The claim

The operator reports that the last render logged `$0.006` per generated still
via `openai/gpt-image-2`, against the $0.03 the spec assumed and the $0.05 this
codebase's own UI copy states.

### What the code actually does

`image.provider.ts:86`:

```ts
costUsd: estimateCostUsd(
  reported,
  result.usage?.inputTokens ?? 0,
  result.usage?.outputTokens ?? 0,
),
```

`cost.ts:21` prices `openai/gpt-image-2` at **$5 per million input tokens and
$30 per million output**, read off the gateway's model list on 16 Aug 2026.
`cost.ts`'s own comment records the measurement: one 1024×1536 picture reports
**~1,150 input and ~1,372 output tokens**, which is **$0.047**.

Now do the arithmetic on the operator's number:

```
1,150 input tokens × $5/M  = $0.00575
        0 output tokens    = $0
                             ---------
                             $0.00575  →  .toFixed(3)  →  "$0.006"
```

**$0.006 is $0.047 with the output tokens missing.** The match is exact, on the
same input-token count the comment in `cost.ts` records, through a `?? 0` that
is right there in the provider. `ImageModelV4Usage` types both fields as
`number | undefined`, so a gateway response that omits `outputTokens` silently
prices away 86% of the bill and nothing anywhere reports it.

**So the honest answer to "recompute with the real number" is: $0.006 is not a
price, it is a reporting gap, and the real number is very probably $0.047.**

There is one clean way to settle it and it costs nothing: take the AI Gateway
invoice for the day of that render and divide by the number of images that run
generated. If it comes to $0.006 the operator is right and the table below
should be read down its right-hand column. If it comes to $0.047 the middle
column is the truth. That check is Task 1 of the plan, and every other task is
written so that the answer changes a number rather than a design.

There is a second, quieter reason to do it: **image spend never reaches
`ProviderUsage` at all.** Only `script.service.ts` and `voiceover.service.ts`
write that table. `footage.service.ts` computes `costUsd`, sums it, prints it to
the progress log and throws it away — so the single largest line item in a
render is invisible on `/providers`, on the analytics daily-cost chart and in
every rollup this app has. `openai/gpt-image-1` (thumbnails, logos) has no rate
table entry at all and therefore prices at exactly $0.00 by construction.

### The table

An eight-minute landscape video, ~1,200 words of narration, ~7,000 characters,
40 picture slots (see Part 5 for where 40 comes from).

| Line | Quantity | At $0.047/still | At $0.006/still |
|---|---|---|---|
| Script — `claude-sonnet-5`, ~2k in / ~1.7k out, incl. one retry | 1–2 calls | $0.04 | $0.04 |
| Metadata + thumbnail prompt | 2 calls | $0.01 | $0.01 |
| Thumbnail image — `gpt-image-1` | 1 | *unpriced by `cost.ts`* | *unpriced* |
| **Generated stills — 32 of 40 slots** | 32 | **$1.50** | **$0.19** |
| Stock clips — 8 of 40 slots (Pexels/Pixabay) | 8 | $0.00 | $0.00 |
| Music bed (Jamendo) | 1 | $0.00 | $0.00 |
| Narration (ElevenLabs, `eleven_turbo_v2_5`) | ~7,000 chars | *quota, recorded as $0.00* | *quota* |
| Render (worker CPU on the VPS) | ~25 min | $0.00 | $0.00 |
| **Total cash** | | **~$1.55** | **~$0.24** |
| **7 Shorts** — 1 moment-selection call, 7 composes from assets already paid for | | +$0.01 | +$0.01 |
| **Total** | | **~$1.60** | **~$0.25** |

Two caveats stated plainly rather than buried:

- **ElevenLabs is quota, not cash, and this codebase does not price it.**
  `voiceover.service.ts` writes a `ProviderUsage` row with the character count
  in `inputTokens` and **no `costUsd`**, so it defaults to zero. Whether 7,000
  characters is worth $0.30 or $1.50 depends on the operator's plan tier, and I
  could not verify which one is in use. On a per-video basis it is plausibly
  the *largest* line item after the stills — which is worth knowing before
  optimising the stills further.
- The thumbnail is a real generated image billed to the same account and
  reported as free. Same fix as Task 1.

### The operator's spec, checked

| Spec claims | Actual |
|---|---|
| $0.03 a still | $0.047 computed, $0.006 logged. Neither is $0.03. |
| ~$8.65 a video | ~$1.60 on the recommended mix. ~$10.40 if the 25% motion tier is built at the price the spec implicitly assumes. |
| $25–96 for all-motion | Consistent: 480 seconds at $0.05–0.20/s. |

Working backwards from $8.65: the spec's motion tier is 25% of ~480s = 120
billed seconds, and `render-manifest.ts`'s own honest reject multiplier of
**1.6** makes that 192 billed seconds. $8.65 minus the still and script lines
leaves roughly $8.20 for 192 seconds — **about $0.043 a second**. That is the
cheapest open-weights tier. It is not Kling, Veo, Runway or Luma; it is the tier
whose output is least likely to hold one grade across eleven shots, which is the
entire reason `render-manifest.ts` has a `styleLock` appended by the renderer.
The spec's cost figure and its quality assumption are in tension with each other.

---

## Part 3 — Ken Burns: the rejection does not hold, and the thing it defended is broken

The comment above `PAN_EXPRESSIONS` says:

> These are pans, not zooms. A `crop` filter's output size must be constant, so
> an animated crop can translate its window but cannot resize it — zoom needs
> `zoompan`, which computes per-frame scaling against integer pixel positions
> and judders visibly unless the input is pre-upscaled far past the output.
> That is memory this worker does not have.

Two claims: zoompan judders without a pre-upscale, and the pre-upscale costs
memory the worker cannot afford. The first is true. **The second is not, and
the pan it defends judders worse than the zoompan it rejects.**

### The measurement

FFmpeg 9.0 on darwin-arm64, one 1536×1024 still (the exact size
`ILLUSTRATION_SIZE.LANDSCAPE` asks gpt-image-2 for) into a 20-second 1920×1080
segment, `-threads 1` in, `-threads 2` out, `libx264 -preset veryfast -crf 18`
— i.e. `buildSegmentArgs`' own argv.

"Frozen" is the fraction of adjacent frame pairs whose mean absolute luma
difference is under 0.05/255 — a pair where the picture did not move at all.

| Filter | Frozen pairs | Peak RSS | Wall, 20s segment |
|---|---|---|---|
| **`crop` pan, `scale=1.15` — what ships today** | **75.7%** | 226 MB | 6.1 s |
| `crop` pan, `scale=1.50` | 20.0% | 246 MB | 5.7 s |
| `zoompan`, no pre-upscale | 54.8% | 227 MB | 6.3 s |
| `zoompan`, 2× pre-upscale | 18.5% | 234 MB | 5.7 s |
| `zoompan`, 3× pre-upscale | 4.4% | 255 MB | 7.6 s |
| **`zoompan`, 4× pre-upscale, push-in + drift** | **0.0%** | **267 MB** | 10.4 s |
| `zoompan`, 4×, vertical 1024×1536 → 1080×1920 | 0.0% | 268 MB | 9.5 s |

The worker's real limit is **`mem_limit: 640m`** (`deploy/docker-compose.yml`),
not the 1GB the code comments assume. 267 MB leaves 373 MB of headroom.

### What this means

**The pan that ships today is frozen for three frame pairs out of four.** The
arithmetic is not subtle once you look at it: `motion.scale = 1.15` on a 1920px
frame leaves 288 pixels of travel, spread over 600 frames of a 20-second slot —
**0.48 pixels per frame.** `crop`'s `x` expression is evaluated per frame and
then quantised to an integer pixel, so the picture holds perfectly still for two
frames and jumps one pixel on the third. That is not "a slow drift that reads as
intentional". It is a still image with a one-pixel stutter in it, at 10 effective
frames per second.

The 52%-pixel-identical figure from the teardown of the comparable channel is
worth putting beside that number. That channel — the one this format is
benchmarked against, the one the teardown concluded "is largely stills" —
**moves more than Framecast does.** Framecast is at 76%.

So the honest verdict on the operator's request for `zoompan`:

- **The memory objection is dead.** 4× pre-upscale costs +41 MB over the current
  pan, inside a 640 MB budget, because the two-pass design already guarantees
  exactly one clip is open at a time. The comment's parenthetical — "see the
  two-pass rationale above" — is pointing at the very change that made its own
  conclusion obsolete.
- **The judder objection is right, and it applies to the incumbent too.** Naive
  `zoompan` is 54.8% frozen. But so is the pan, worse. The pre-upscale is the
  fix for both, and 4× is where it goes to zero: a 4× upscale makes one output
  pixel a quarter-pixel step in the source, below the eye's threshold at 30fps.
  3× (0.33px) leaves 4.4% and is visible on a flat sky.
- **The new objection is CPU, and it is real.** 10.4 s versus 6.1 s for a
  20-second segment: **1.7× the segment pass.** For an eight-minute video of 40
  slots that is the difference between roughly 4 and roughly 7 minutes of
  segment encoding *on this Mac*. The worker has 2 vCPU on an OVH VPS and is
  materially slower. It is affordable — the render is already a
  quarter-of-an-hour job and nobody is waiting on it — but it should be stated
  rather than discovered.

### The one thing that must not be done

**Pre-upscale stills only.** `buildVideoFilter` is shared with stock clips, and
a stock clip arrives at up to 2560×1440. `scale=iw*4:ih*4` on that is
10240×5760 — about 88 MB per frame in yuv420p, held alongside a live h264
decoder, inside 640 MB. That is the exact shape of the SIGKILL that produced
`render-oom-report.md`. `SegmentInput.still` already carries the fact, derived
by `planRender` from the path extension, so the gate is one condition on a flag
that is already there.

---

## Part 4 — The mixed asset economy is already renderable

This is the finding that decides the shape of the implementation, so it is worth
stating on its own.

`planRender` sets, for every clip:

```ts
still: isStillImagePath(clipPath),
```

and `buildSegmentArgs` spreads `-loop 1 -framerate 30` for a still and
`-stream_loop -1` for a clip. **A timeline that mixes PNGs and MP4s already
works, today, with no change to `ffmpeg-command.ts`, `composer.ts` or
`planRender`.** The renderer has never cared what kind of file a slot holds; it
asks the path.

What does not exist is a *collector* that produces such a timeline, and a
*query* that can find it. `render.service.ts:309-327` asks:

```ts
const beatAssets = await prisma.asset.findMany({
  where: { kind: "IMAGE", deletedAt: null,
           storagePath: { startsWith: beatPrefix(videoId) } },
  ...
});
const illustrated = beatAssets.length > 0;
```

`kind: "IMAGE"` is the whole obstacle. Widen it to `kind: { in: ["IMAGE",
"VIDEO"] }`, let a beat resolve to `beats/beat-NNN.png` *or*
`beats/beat-NNN.mp4`, and the mixed economy renders. Everything downstream —
the per-beat durations from `beatSeconds`, the transitions, the concat list, the
captions — is untouched.

That is the design: **one slot per beat, one asset per slot, either kind,
under one prefix.** It costs one widened query and one path resolver, and it
inherits every guarantee the illustrated path already has (idempotent per beat,
refuses to render with a beat missing, timing derived from the same alignment).

The alternative — a separate prefix per source, or a stored plan naming which
slot got which — reintroduces exactly the drift `story-beats.ts` was written to
avoid: two services having to agree on a grouping neither can recompute.

---

## Part 5 — The recommended mix, with the numbers

### The question

Given stills cost $0.047 (or $0.006), is 25/55/20 motion/still/reuse right?

### The evidence against the motion tier

**1. It costs more than everything else combined, for the smallest share of the
screen.** At the spec's own 25%, and `render-manifest.ts`'s own 1.6× reject
multiplier, the motion tier is 192 billed seconds a video. That is $8.20 at
$0.043/s, $19 at $0.10/s, $48 at $0.25/s — against $1.50 for all thirty-two
stills. **The motion tier is 84–97% of the video's cash cost for 25% of its
runtime.**

**2. It fights the cutting rhythm, and this codebase already knows it.**
`render-manifest.ts` caps a generated clip at `MAX_CLIP_SECONDS = 5.0`, and says
why: "above five the shot outstays the sentence under it". A still holds 12–25
seconds. A timeline that alternates them either cuts every 5 seconds throughout
— in which case the stills are being cut three times faster than the genre
does — or loops the generated clips to fill a 12-second slot, which is
`-stream_loop -1` playing the same two seconds of motion twice and reads as a
glitch. `CAMERA_MOVES`' own comment makes the identical argument one level down:
"One handheld or whip pan among eleven locked-off shots does not read as
variety, it reads as a different video spliced in."

**3. There is no provider, and there is no key.** `AiProviderType` has
`GOOGLE_VEO`, `RUNWAY`, `KLING`, `REPLICATE`, `PIKA`, `LUMA`. Every one of them
appears in exactly three places: the enum, `provider-labels.ts`, and
`provider.schema.ts`. There is no adapter, no service, no test, no call site.
Everything image-shaped in this app goes through `createGateway` from the `ai`
package, and **the Vercel AI Gateway does not carry a video model** — so this is
not "add a model id", it is a new provider integration, a new credential path, a
new async-job shape (video generation is a poll-for-result API, unlike every
provider here), and a key the operator does not have.

**4. The genre does not use it.** Two independent measurements already in this
repository say so. The teardown of the comparable channel: **52% of sampled
frame pairs pixel-identical**. And `story-beats.ts`, on the four-million-view
channels in the neighbouring genre: "one visual every 13–70 seconds, at a
frame-to-frame distance floor five times lower than the genuinely animated
channels. They are still illustrations with slow camera motion."

**5. The gap to the benchmark closes for free.** The reference channel is 52%
frozen. Framecast is 76% frozen. Properly-executed Ken Burns is 0%. **Fixing the
move puts this app past the channel it is benchmarking against without buying a
single generated second.** That is the whole argument in one line.

### The evidence against the reuse library

The spec's third tier is 20% "reused library b-roll" — generated assets kept and
re-served to later videos. Three problems.

**It saves almost nothing.** 20% of 40 slots is 8 stills, $0.38 a video at
$0.047 and $0.05 at $0.006.

**It costs a lot to build.** The `Asset` table is structurally hostile to it:
no owner column, no channel column, no tags, no keywords, no content hash, no
unique constraint on `(provider, externalId)`, one index (`[sceneId, kind]`,
on a field the pipeline never populates), and identity carried by a path string
with a single `videoId` baked into it. There is no asset search anywhere —
`search.service.ts` and `search.ts` contain zero references to it. Building a
searchable cross-video library means an owner column, a tagging scheme, an index,
a migration, a browse UI, and a change to how `footage.service.ts` establishes
identity. That is not eight dollars' worth of work; it is weeks.

**It is the thing that makes a channel look like a farm.** The same picture
recurring across videos is the visible signature of automated content, and it is
the one defect a viewer can name without knowing why. Paying engineering effort
to acquire it is the wrong trade in both directions.

### The recommendation

**Stills-dominant, stock for motion, no generation of video.**

| Tier | Share | Slots (of 40) | Source | Cash |
|---|---|---|---|---|
| Generated stills, Ken Burns | 80% | 32 | `gpt-image-2` at 1536×1024 | $1.50 |
| Stock clips | 20% | 8 | Pexels → Pixabay, already implemented | $0.00 |
| Generated motion | 0% | 0 | — | $0.00 |

The 20% is **stock, not reuse**, and the swap is the point. Stock costs the same
as reuse ($0) and buys the one thing a generated still fundamentally cannot: a
crowd actually moving, water actually running, hands actually working. Reuse buys
a picture the channel has already shown. Both tiers are free; only one of them
adds something.

### How a shot is assigned to a tier

Not by a quota in code, and not by an operator toggle. **By the writer.**

The script already emits a cue per section, and `CUE_RULES` already requires
that cue to be "a stock-footage search query for what fills the screen" —
"Describe the picture, never the idea", "Prefer motion and people over static
objects". The writer is already making exactly this judgement; it just has
nowhere to record the answer.

So: `ScriptCue` gains an optional `shot?: "still" | "motion"`. Additive on a
`Json?` column, no migration, absent on every cue ever written — exactly the
shape `beat` and `emphasis` already took. The prompt tells the writer to tag a
shot `motion` only when the thing being described is a thing that *moves*, and
to keep it to about one in five.

Two guards, both in code rather than in the prompt, because a prompt is a
request and a guard is a guarantee:

- **A `motion` shot whose stock search finds nothing becomes a generated still.**
  This is the same fallback shape `collectPerCue` already has, and it means a
  thin stock library degrades into a slightly more expensive video rather than a
  video with holes in it.
- **A cap on the stock share.** A model that tags everything `motion` must not
  be able to turn the video into a stock reel; excess `motion` tags fall back to
  stills in cue order.

### Where 40 slots comes from

`beatCountFor(480, n)` with today's `BEAT_TARGET_SECONDS = 20` gives **24**
pictures at 20 seconds each. That number was measured on four-minute children's
bedtime stories, and `story-beats.ts` says so. It is the wrong number for an
adult list explainer, where a segment is ~68 seconds and one picture across it is
a slideshow.

**40 at ~12 seconds each.** Three reasons it is 40 and not a round guess:

- `MAX_BEATS = 40` already exists, and its comment already prices it: "Forty is
  about $2". The long-form format is the first one that has a reason to reach
  that ceiling. Nothing new has to be invented to justify the number, because
  the codebase already sized it.
- 12 seconds is inside the 13–70s band `story-beats.ts` measured on real
  channels, at its fast end, which is where an explainer belongs relative to a
  bedtime story.
- At 40 slots the video is 480/40 = 12s per picture, and `BEAT_MIN_SECONDS = 15`
  — the floor written for the bedtime genre — must **not** apply. That is
  already precedented: `planStoryBeats` has an early return for beat-scripted
  narrations that deliberately lives below the floor, with a comment saying so.

The mechanism for getting 40 rather than 24 is the same trick that early return
uses, and this matters more than the number: **`footage.service.ts` and
`render.service.ts` must reach the same grouping without a stored plan, and
neither can see the channel's `footageStyle`.** So the signal has to be in the
cues, which both of them have. `isBeatScripted` already reads `cue.beat` for
exactly this purpose. The long-form plan reads `cue.shot` the same way: **every
cue carrying a `shot` tag means one slot per cue**, and the writer — told to
emit ~40 sections for eight minutes — decides the count.

That also means the change is invisible to every existing video. A four-minute
illustrated bedtime story has no `shot` tags, groups by `BEAT_TARGET_SECONDS`
exactly as it does today, and its cost does not move.

---

## Part 6 — Shorts, and what "seven derived Shorts" actually costs

### What exists

`shorts.service.ts` is 1,130 lines and does the whole job:

- An LLM picks moments as **section numbers**, never quoted text, so a cut can
  only land on a sentence boundary (`planShortWindow`).
- `MIN_SHORT_SECONDS = 12`, `MAX_SHORT_SECONDS = 60`, overlapping candidates
  dropped rather than nudged (`windowsOverlap`).
- Composed at 1080×1920 **from the source clips**, not cropped from the finished
  landscape MP4 — `composer.ts`'s doc comment explains that this is a bug fix,
  because a crop inherits the landscape captions burned into those pixels.
- Worker-claimed with a lease, rendered, banked, and drip-published by
  `release.service.ts` on a `ReleaseCadence`.
- `generate(userId, videoId, count = DEFAULT_SHORT_COUNT)` — **the count is
  already a parameter.** `DEFAULT_SHORT_COUNT = 3`, and
  `generateShortsAction` simply never passes one.

So "seven derived Shorts" is, on the count alone, **an argument nobody is
passing.** Eight minutes at 12–60s a short is 84–420 seconds of window out of
480, which fits comfortably with the overlap rule.

### What does not exist, and it is the whole job

**Shorts cannot be cut from a generated-stills video at all.**
`requireSectionClips` builds the list of wanted paths from `sectionClipPath`
(`videos/{id}/clips/section-NNN.mp4`) and queries `kind: "VIDEO"`. A generated
video's pictures are `kind: "IMAGE"` at `beats/beat-NNN.png`. Every short on
every `ILLUSTRATED` or `CINEMATIC` video fails with "This video's footage is no
longer in storage" — a message about a recovery problem, for what is actually an
unimplemented path.

`planShortSlots` has the same shape mismatch: it maps a window onto *sections*,
and a generated video's picture unit is a *beat* covering several sections.

That is the real content of "seven derived Shorts": teach the shorts path that
a video's picture units can be beats. It is a day's work, not a feature, and it
is entirely unblocked.

### One operational fact that must not be lost

`publish.service.ts` calls `reclaimClipStorage` the moment YouTube confirms the
upload, deleting `videos/{id}/clips/`. **Shorts must be generated before the
parent is published.** `requireSectionClips` already says so in its error text.

Worth noting for the recommended mix: `reclaimClipStorage` filters `kind:
"VIDEO"` under `clips/`, so **generated beat images are never reclaimed** and
sit on the 40GB disk forever. A stills-dominant format makes that a real
retention question — 32 PNGs a video, indefinitely — and it is not in scope
here, but it should not be discovered later.

---

## Part 7 — Dual aspect, and what the format lock actually costs

### The lock

`Video.format` is written by exactly one statement, `VideoService.approveScript`:

```ts
const { count } = await tx.video.updateMany({
  where: { id, userId, deletedAt: null, status: "DRAFT" },
  data: { status: "QUEUED", format },
});
```

The same statement moves the row out of `DRAFT`, and the `where` requires
`DRAFT`. The field is not "documented as unchangeable"; it is **structurally
single-write** — there is no second write to guard against, which is why there
is no immutability check anywhere. The enum's own comment gives the reason:
format decides what the narration, footage and captions are composed into, and
"it decides whether the video can have shorts cut from it at all — a vertical
video already is one."

### What dual aspect would cost, honestly

Four options, priced:

1. **Generate every asset twice, once per size.** 32 extra stills at $0.047 =
   **+$1.50, a doubling of the video's entire cash cost**, to serve derivative
   clips. Rejected.
2. **Make `format` mutable.** Re-opens the one irreversible gate, invalidates
   the framing of every already-collected asset, and every stage after Gate 1
   reads the field. The enum comment is right that changing it after a render
   "would mean paying for the whole pipeline again, which is a new video, not an
   edit." Rejected.
3. **Generate portrait and letterbox for landscape.** A 1024×1536 asset in a
   1920×1080 frame is pillarboxed to 720×1080 with 600px of dead frame either
   side. Rejected.
4. **Generate 16:9 and centre-crop for 9:16 — which is what already happens.**

Option 4 is not a proposal; it is a description of the existing code.
`buildVideoFilter` composes a vertical frame as
`scale=…:force_original_aspect_ratio=increase,crop=1080:1920` — a **centre crop
of the source**, not of the finished render. `composer.ts` and
`shorts.service.ts` both already rely on this.

So the entire dual-aspect requirement reduces to one arithmetic question:
**does a 1536×1024 still survive a 9:16 centre crop?**

- Centre 9:16 of 1536×1024 is **576×1024** — 37.5% of the pixels.
- Scaled to 1080×1920, that is a **1.875× upscale.**

That is softer than a native vertical still and clearly softer than a 1440p stock
clip downsampled into the same frame. For a derivative clip it is acceptable; as
a primary output it is not.

### The recommendation

**Dual-crop-safe framing is a prompt rule and a crop, not a schema change.**

- Keep `Video.format = LANDSCAPE`. Do not touch Gate 1.
- Add one rule to the shot prompt: the subject sits inside the central 9:16 of
  the frame, with the sides carrying context rather than content. This is a
  sentence, and it is the whole feature.
- Accept the 1.875× upscale on shorts, and write it down so nobody rediscovers
  it as a bug.
- **State the inversion plainly**, because it is a real choice the operator owns:
  if the Shorts matter more than the long video, approve as `VERTICAL` and give
  up the long-form. There is no configuration that makes both native, and
  pretending otherwise is how a channel ends up with two mediocre outputs.

The one place this is not free: a *stock* clip crops beautifully (2560×1440 down
to 1080×1920 is a downsample) and a *generated still* does not. So the mixed
economy makes shorts slightly better than an all-generated video would, which is
a small argument in the same direction as everything else in Part 5.

---

## Part 8 — What is config, what is code, what to drop

| | |
|---|---|
| **Config only** | The eight-minute list format (`countdown`, `count: 7`), the landscape frame, the music bed, the caption style, the voice |
| **Small code** | `ScriptCue.shot`; widening the beat query to `IMAGE \| VIDEO`; resolving a beat path by extension; passing a count to `shortsService.generate`; one prompt rule for centre-safe framing |
| **Real code** | The mixed collector (`FootageStyle.MIXED`); zoompan gated on `still`; shorts over beats rather than sections; image spend into `ProviderUsage` |
| **Measurement first** | The gateway invoice ÷ image count (settles $0.047 vs $0.006); the zoompan numbers repeated on the worker image, which is FFmpeg 5.1.9 on Debian 12, not 9.0 on darwin |
| **Recommended out** | The generated-motion tier; the reuse library; dual generation; making `Video.format` mutable |

### What I deliberately did not do

- **I did not adopt 25/55/20.** The motion tier is 84–97% of the cash cost for
  25% of the runtime, needs a provider that does not exist and a key that does
  not exist, and fights the cutting rhythm the rest of the format depends on.
  The recommendation is 0/80/20 with the 20 being stock.
- **I did not price the video models with any confidence.** The $0.03–0.25/s
  band is provider list pricing from outside this repository and is not
  verifiable in it. Everything in Part 5's argument holds across that whole
  band, which is why the band is stated rather than a point estimate.
- **I did not verify $0.006 against a real invoice.** I could not reach the VPS
  or the database from here. What I did instead was reproduce the number
  exactly from the code path, which is strong evidence and not proof.
- **I did not re-run the FFmpeg measurements on the worker's FFmpeg.** They were
  taken on 9.0/darwin-arm64; the worker runs 5.1.9 on Debian 12 with 2 vCPU.
  Memory is very unlikely to differ by the 2.4× that would matter; wall time
  certainly will. Task 2 repeats them on the image before the filter changes.
- **I did not design the asset library.** Part 5 argues it should not be built.
  If the operator disagrees, the honest starting point is that `Asset` needs an
  owner column, a tagging scheme and an index before anything can be looked up
  in it, and that the precedent for cross-video reuse in this codebase
  (`ChannelBrand.logoPath`, `characterSheetPath`) deliberately bypasses the
  `Asset` table entirely.
- **I did not touch beat-image retention.** `reclaimClipStorage` leaves
  `beats/` alone, so a stills-dominant format accumulates 32 PNGs a video on a
  40GB disk forever. Named here, not solved.

---

## Phasing

1. **Settle the price and record it.** The invoice check, plus image spend into
   `ProviderUsage`. Costs nothing, changes a number in every table above.
2. **Fix Ken Burns.** The largest visible improvement available, on a video the
   app can already make, blocked on nothing. Worth shipping on its own even if
   everything after it is abandoned.
3. **The long-form list format.** A script style, `ScriptCue.shot`, and the
   one-slot-per-tagged-cue plan. Produces a 40-shot eight-minute video with
   generated stills that move.
4. **The mixed collector.** Stock clips in the 20% of slots the writer tagged
   `motion`.
5. **Shorts over beats**, then seven of them.
6. **Motion tier.** Only if 1–5 are shipped, watched, and judged insufficient —
   and only after a key exists and a real per-second price is known.

Phase 2 is worth doing on its own. Phases 1–3 are worth doing before anyone
argues about the mix again, because they are what produce the video the argument
is about.
