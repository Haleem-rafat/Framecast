# Long-form hybrid: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One eight-minute landscape list video whose pictures are generated stills that actually move, with stock clips in the shots that need real motion, and seven vertical Shorts cut from the same run — for about $1.60 of real money.

**Architecture:** Nothing about the renderer changes. `planRender` already decides `-loop 1` versus `-stream_loop -1` from a clip path's extension, so a timeline that mixes PNGs and MP4s already composes today. The mixed economy is therefore a *collector* that files both kinds under one prefix (`videos/{id}/beats/`) and a *query* that looks for both. The picture count comes from the writer, not from a constant: a cue tagged `shot` means one slot per cue, exactly as a cue tagged `beat` already does. Ken Burns becomes a real move by pre-upscaling the still 4× before `zoompan`, gated on `SegmentInput.still` so a 1440p stock clip can never take that path.

**Tech Stack:** TypeScript, Next.js 15 App Router, Prisma 7 / Postgres, Vitest, Zod 4, FFmpeg 5.1.9 (worker image, Debian 12).

**Spec:** `docs/superpowers/specs/2026-08-18-long-form-hybrid-design.md`

---

## Read this first

**The eight-minute list video already exists.** `countdown` in `script-styles.ts`
targets six minutes with a `count` variable whose default is `7`;
`default-script` targets 8–10. `FootageStyle.CINEMATIC` already generates stills
per beat. A `LANDSCAPE` approval already renders them with a pan. Nothing in
Tasks 1–4 below is required to make an eight-minute list video today — they are
required to make a *good* one for a *known* price.

**Three tasks are pure bug fixes** and are worth doing whether or not the rest of
this plan happens: Task 1 (image spend is invisible), Task 3 (the Ken Burns pan
is frozen for 76% of frame pairs), Task 8 (shorts do not work on a generated
video at all).

**Nothing in Tasks 1–9 needs an API key the operator does not have.** Only
Task 10 does, and Task 10 is explicitly recommended against in the spec. It is
written down so that the decision to skip it is a decision rather than an
omission.

---

## Global Constraints

- **Tests need a real Postgres, which the Mac does not have.** `pnpm test` fails
  locally. Run `pnpm lint` and `pnpm typecheck` locally; run the suite on the
  OVH VPS. Never claim tests pass without that output.
- **Every service test creates its own throwaway user** via `createTestUser` /
  `deleteTestUser` from `@/test/fixtures`. The test database is shared with real
  data; `prisma.user.findFirstOrThrow()` is forbidden.
- **Every existing video's argv must stay byte-for-byte identical.** This is the
  discipline `ffmpeg-command.ts`, `composer.ts` and `shorts-plan.ts` are already
  written to, and every new field below is optional-and-absent for exactly that
  reason. A test that asserts the unchanged argv is part of every task that
  touches the renderer.
- **`planRender`, `buildAssembleArgs`, `buildTransitionArgs` and `composer.ts`
  are not modified by this plan.** If a task appears to need it, the task is
  wrong.
- **`Video.format` is not made mutable.** See the spec, Part 7. Gate 1 stays
  single-write.
- **Comment style:** this codebase explains *why*, not *what*, and says plainly
  what it deliberately did not do. Match it. A comment that only restates the
  code is worse than none.
- **Record the test baseline before Task 1** (`N files, M tests`) and quote it
  in each task's verification.

### Running the suite

```bash
rsync -az --delete -e "ssh -i ~/.ssh/framecast_vps" src/ root@51.38.80.36:/root/fc-src/src/
ssh framecast 'cd /srv/framecast
TEST_URL=$(grep -m1 "^DATABASE_URL=" env/prod.env | cut -d= -f2- | sed "s#/framecast\([?\"]\|$\)#/framecast_test\1#")
docker compose run --rm --no-deps -e DATABASE_URL="$TEST_URL" -e NODE_ENV=test \
  -v /root/fc-src/src:/app/src --entrypoint npx worker-prod vitest run'
```

---

## File Structure

**Create:**
- `src/lib/longform-script.ts` — the shot-tag vocabulary and the pre-spend gate
- `src/lib/longform-script.test.ts`
- `prisma/migrations/20260903090000_add_mixed_footage_style/migration.sql`
  — **not** today's real date. This repo's migration timestamps run ahead of the
  calendar; applied history ends at `20260901090000`, and Task 4 takes
  `20260902090000`. A migration stamped with the real date sorts into the
  *middle* of applied history, which fails a fresh deploy and can trigger a
  destructive reset. This has already gone wrong once on this project.

**Modify:**
- `src/services/providers/image.provider.ts` — surface raw token counts
- `src/services/footage.service.ts` — record spend; the mixed collector
- `src/lib/cost.ts` — price `gpt-image-1`
- `src/lib/video-style.ts` — `MotionStyle.kind`, `MotionStyle.preScale`
- `src/lib/ffmpeg-command.ts` — `buildVideoFilter` emits zoompan for stills
- `src/lib/script-cues.ts` — `CueMeta.shot`
- `src/lib/story-beats.ts` — one slot per shot-tagged cue
- `src/lib/beat-storage.ts` — `beatClipPath`, `beatAssetPath`
- `src/services/render.service.ts` — widen the beat query to `IMAGE | VIDEO`
- `src/services/script.service.ts` — parse `shot` out of the script
- `src/lib/script-styles.ts` — the long-form list style
- `src/lib/footage-styles.ts` + `prisma/schema.prisma` — `FootageStyle.MIXED`
- `src/services/shorts.service.ts` — beats as picture units
- `src/actions/shorts.action.ts` + `src/features/videos/components/shorts-panel.tsx` — pass a count

---

### Task 1: Make image spend visible

**Files:**
- Modify: `src/services/providers/image.provider.ts`, `src/services/providers/types.ts`, `src/lib/cost.ts`, `src/services/footage.service.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GeneratedImage.inputTokens` / `.outputTokens`; `ProviderUsage` rows for `footage.collect`.

**Why first:** every cost number in the spec turns on whether a still is $0.047
or $0.006, and the whole difference is `result.usage?.outputTokens ?? 0`. Until
the raw counts are logged, nobody can tell a cheap model from a broken meter.
This task is also the only one whose output is a *fact* rather than a feature.

- [ ] **Step 1: Carry the raw token counts out of the provider**

`src/services/providers/types.ts`, on `GeneratedImage`:

```ts
  /**
   * What the provider said it billed, unpriced.
   *
   * Both optional, and that is the point rather than laziness:
   * `ImageModelV4Usage` types them `number | undefined`, and the whole reason
   * this pair exists is that a MISSING `outputTokens` is indistinguishable from
   * a free one once `costUsd` has been computed. An image priced at $0.006 and
   * an image priced at $0.047 are the same generation with and without this
   * field, so the honest thing is to record what arrived rather than only what
   * it came to.
   */
  inputTokens?: number;
  outputTokens?: number;
```

`src/services/providers/image.provider.ts`, in the returned object, beside
`costUsd`:

```ts
        // Spread rather than always-present, so a provider that reports no
        // usage at all produces an object without the keys instead of two
        // zeroes that read as a measurement.
        ...(result.usage?.inputTokens !== undefined
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(result.usage?.outputTokens !== undefined
          ? { outputTokens: result.usage.outputTokens }
          : {}),
```

- [ ] **Step 2: Price `gpt-image-1`, or say out loud that it is unpriced**

`src/lib/cost.ts` has no entry for `openai/gpt-image-1`, which is
`AI_IMAGE_MODEL`'s default and therefore every thumbnail and every channel logo.
By `estimateCostUsd`'s own rule an unlisted model prices at 0, so thumbnails
have always been recorded as free. Add the entry with its provenance, exactly as
the `gpt-image-2` entry carries its own:

```ts
  // Same gateway listing, same day. Present so a thumbnail stops pricing at
  // exactly $0.00 — which is what an unlisted model does, and which is
  // indistinguishable from a thumbnail that was never generated.
  "openai/gpt-image-1": { input: 5, output: 40 },
```

**Verify the two rates against `GET https://ai-gateway.vercel.sh/v1/models`
before committing them.** A wrong rate here is worse than no rate, because a
plausible number stops anybody looking.

- [ ] **Step 3: Write a `ProviderUsage` row per generated picture**

In `footage.service.ts`'s generation loop, immediately after the successful
`prisma.asset.create`:

```ts
      // The one table the spend dashboards read. Until now the money spent on
      // pictures — the largest line in a render by an order of magnitude — was
      // computed here, summed into a progress line and discarded, so
      // /providers and the daily cost chart have never shown it. Best-effort
      // and never awaited into the collection's failure path: a usage row that
      // could not be written must not lose the operator a picture they have
      // already paid for.
      await prisma.providerUsage
        .create({
          data: {
            provider: "OPENAI",
            operation: "footage.collect",
            model: image.model,
            inputTokens: image.inputTokens ?? 0,
            outputTokens: image.outputTokens ?? 0,
            costUsd: image.costUsd,
            succeeded: true,
            latencyMs: Date.now() - stepStartedAt,
          },
        })
        .catch(() => {});
```

- [ ] **Step 4: Put the raw counts in the progress line**

Change the per-beat progress line so the numbers behind the price are visible
without a database query:

```ts
      onProgress(
        `[${label}] ${beat.sectionIndices.length} section(s), ` +
          `${formatBytes(image.data.byteLength)}, ` +
          `${image.inputTokens ?? "?"} in / ${image.outputTokens ?? "?"} out, ` +
          `$${image.costUsd.toFixed(3)} … ` +
          `drawn (${formatElapsed(Date.now() - stepStartedAt)})`,
      );
```

- [ ] **Step 5: Tests**

- `image.provider.test.ts`: a fake `generateImage` reporting `{ inputTokens:
  1150, outputTokens: 1372 }` produces `costUsd === 0.047` **and** both raw
  fields; one reporting `{ inputTokens: 1150 }` alone produces `costUsd ===
  0.00575` and `outputTokens === undefined`. **That second test is the whole
  point of this task** — it pins the exact shape that produces the operator's
  `$0.006`.
- `footage.service.test.ts`: a collection run writes one `ProviderUsage` row per
  generated beat, with the model and both token counts.

- [ ] **Step 6: Settle the price — the measurement this task exists for**

- [ ] Open the AI Gateway billing page for the day of the last `CINEMATIC`
      render. Divide the image spend by the number of pictures that run drew.
- [ ] Record the answer in the spec's cost table, in this file, and in
      `ILLUSTRATION_USD` (`approve-script-button.tsx:127`) and the two
      `footage-styles.ts` descriptions — **all three are independent hardcoded
      copies of the same number with no test tying them together.**
- [ ] If it is $0.047: nothing else changes; the spec's middle column is the
      truth. If it is genuinely $0.006: `cost.ts`'s output rate is wrong and
      needs re-reading from the gateway, and every figure in the spec drops by
      a factor of eight.

**Needs a key?** No. Uses the existing `AI_GATEWAY_API_KEY`.

---

### Task 2: Measure the render filters on the worker's own FFmpeg

**Files:** none. This task writes no code.

**Why:** every number in the spec's Part 3 was taken on FFmpeg 9.0,
darwin-arm64, on a machine with far more CPU than the worker. Memory is unlikely
to differ by the 2.4× that would matter, but `zoompan`'s implementation changed
between 5.x and 9.x and wall time certainly differs. Task 3 changes a filter
graph on the strength of these numbers; measuring them on the target first is
the cheap half of the work.

- [x] **Step 1: Run the comparison inside the worker image**

```bash
ssh framecast 'cd /srv/framecast
docker compose run --rm --no-deps --entrypoint sh worker-prod -c "
set -e
cd /tmp
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1536x1024:rate=1:duration=1 \
  -frames:v 1 -update 1 still.png
enc=\"-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -threads 2\"
run () {
  /usr/bin/time -v ffmpeg -y -hide_banner -loglevel error -threads 1 -loop 1 \
    -framerate 30 -t 20 -i still.png -an -vf \"\$2\" \$enc out-\$1.mp4 2>&1 |
    grep -E \"Maximum resident|Elapsed\" | sed \"s/^/\$1 /\"
}
run pan \"scale=2208:1242:force_original_aspect_ratio=increase,crop=2208:1242,fps=30,crop=w=1920:h=1080:x=(in_w-out_w)*(t/20):y=(in_h-out_h)/2,setsar=1\"
run kb4 \"scale=6144:4096,zoompan=z=min(1+0.12*on/600\\,1.12):d=1:x=(iw-iw/zoom)*(on/600):y=ih/2-(ih/zoom/2):s=1920x1080:fps=30,setsar=1\"
"'
```

- [x] **Step 2: Record**

Measured 2026-08-18 in `framecast-worker-staging-1`, **FFmpeg 5.1.9-0+deb12u1**
on Debian 12. The image has no GNU `time`, so peak RSS is the high-water mark of
`/proc/<pid>/status` `VmHWM`, sampled at 5 Hz.

| | Peak RSS | Wall | Frozen frame pairs |
|---|---|---|---|
| `pan` (ships today) | 260 MB | 15 s | **75.7%** (446 of 589) |
| `kb4` (proposed) | 291 MB | 44 s | **0.0%** (0 of 589) |

Reference numbers from darwin/FFmpeg 9.0: pan 226 MB / 6.1 s / **75.7%**
frozen; kb4 267 MB / 10.4 s / **0.0%** frozen. The worker's `mem_limit` is
**640m**.

The frozen-frame fractions reproduced **exactly** — which is the half of the
measurement the whole task rests on, and it transfers across two FFmpeg majors
because it follows from integer quantisation of the crop origin, not from any
version's implementation.

Memory transferred too: +31 MB for the pre-upscale against a 640 MB limit.

Wall time did **not**. The pre-upscale costs **2.9×** the segment pass here, not
the 1.7× darwin showed. Anything downstream that budgets render time should
plan against 2.9×; a 40-slot long-form video pays it forty times.

- [x] **Step 3: Decide the gate**

- If `kb4` peak RSS is under **450 MB**, proceed to Task 3 as written.
- If it is between 450 and 600 MB, drop the pre-upscale to 3× (`4608:3072`) and
  accept 4.4% frozen pairs, which is still a seventeenfold improvement.
- If it exceeds 600 MB, **stop and report.** Do not ship a filter that leaves a
  render one large still away from the OOM killer; `render-oom-report.md`
  documents what that costs.

- [x] **Step 4: Reproduce the frozen-pair measurement**

The number that justifies the whole task is the fraction of adjacent frames that
do not move. Pull both MP4s back and count it:

```bash
ffmpeg -v error -i out-pan.mp4 -pix_fmt yuv420p -f rawvideo - | \
python3 -c "
import sys, statistics
W,H=1920,1080; fs=W*H*3//2; ys=W*H
d=[]; prev=None
while True:
    b=sys.stdin.buffer.read(fs)
    if len(b)<fs: break
    cur=b[:ys:7]
    if prev is not None: d.append(sum(abs(a-c) for a,c in zip(cur,prev))/len(cur))
    prev=cur
core=d[5:-5]
print('frozen', sum(1 for x in core if x<0.05), 'of', len(core))
"
```

**Needs a key?** No.

---

### Task 3: A Ken Burns move that moves

**Files:**
- Modify: `src/lib/video-style.ts`, `src/lib/ffmpeg-command.ts`
- Modify: `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Consumes: `SegmentInput.still` (exists), Task 2's measurement.
- Produces: `MotionStyle.kind`, `MotionStyle.preScale`.

**Why:** measured, the pan that ships today holds the picture perfectly still
for 75.7% of adjacent frame pairs. `motion.scale = 1.15` leaves 288 pixels of
travel across 600 frames of a 20-second slot — 0.48 pixels a frame — and
`crop`'s `x` is quantised to an integer, so the image jumps one pixel every
third frame and is otherwise frozen. The teardown's benchmark channel is 52%
pixel-identical; this app is at 76%.

- [x] **Step 1: Extend `MotionStyle`**

`src/lib/video-style.ts`:

```ts
export interface MotionStyle {
  enabled: boolean;
  /**
   * The source is scaled by this factor so the crop window has room to travel.
   * The pannable margin is (scale - 1) of the frame.
   */
  scale: number;
  /**
   * Which move. `pan` translates a fixed-size crop window and is what every
   * render before this produced; `kenburns` pushes in *and* drifts, which needs
   * `zoompan` because a `crop` filter's output size cannot change.
   *
   * Optional, and absent means `pan` — so a channel that has never been styled,
   * and every channel styled before this field existed, emits byte-for-byte the
   * filter string it always has.
   */
  kind?: "pan" | "kenburns";
  /**
   * How far past the output the still is upscaled before `zoompan` sees it.
   *
   * `zoompan` computes its crop origin in integer source pixels, so the
   * smoothness of the move is decided entirely by how small one output pixel is
   * in source terms. Measured on a 1536x1024 still into a 1920x1080 frame:
   * no pre-upscale leaves 54.8% of adjacent frames identical, 2x leaves 18.5%,
   * 3x leaves 4.4%, and 4x leaves none. Four is therefore the number, not a
   * round guess — it is where a step becomes a quarter of an output pixel and
   * drops below what the eye resolves at 30fps.
   *
   * The cost is +41MB peak RSS and 1.7x the segment pass. The 640MB the worker
   * is given (deploy/docker-compose.yml) has room for it *because a still is
   * one decode of one file* — see the guard in `buildVideoFilter`, which is the
   * load-bearing half of this field.
   */
  preScale?: number;
}
```

`DEFAULT_STYLE.motion` is **not** changed. Ken Burns is opted into per channel,
exactly as `captionMode: "kinetic"` is, so no existing render moves.

- [x] **Step 2: Emit the filter**

`src/lib/ffmpeg-command.ts`. Replace the comment above `PAN_EXPRESSIONS` — it
currently states a conclusion that measurement has overturned, and leaving it
would have somebody re-derive the wrong answer:

```ts
/**
 * Four directions, cycled by segment index.
 *
 * These are pans, not zooms: a `crop` filter's output size must be constant, so
 * an animated crop can translate its window but cannot resize it.
 *
 * This comment used to add that `zoompan` was rejected because the pre-upscale
 * it needs was memory the worker did not have. That was measured in Aug 2026
 * and it is wrong twice over. A 4x pre-upscale of a STILL costs 267MB against a
 * 640MB limit, because the two-pass design directly above guarantees exactly one
 * clip is open at a time — the very change that made the objection obsolete. And
 * the pan it was defending is worse than the thing it rejected: at scale 1.15
 * the crop window travels 0.48px a frame, `x` quantises to an integer, and the
 * picture is frozen for 75.7% of adjacent frame pairs.
 *
 * So the pans stay because they are what a *video clip* gets — a 2560x1440
 * stock clip pre-upscaled 4x is 88MB a frame beside a live h264 decoder, which
 * is the shape that SIGKILLed a render once already. See `buildVideoFilter`.
 *
 * `T` is substituted with `t/<seconds>`, which runs 0 to 1 across the segment,
 * so each expression traverses exactly the margin the upscale created.
 */
```

Then, inside `buildVideoFilter`, after the `if (!motion?.enabled)` early return:

```ts
  const { width, height } = frameSize(input.format);

  // Stills only, and it is a hard gate rather than a preference. `zoompan`'s
  // smoothness comes from pre-upscaling its input far past the output, and a
  // stock clip arrives at up to 2560x1440 — 4x of that is 10240x5760, about
  // 88MB a frame in yuv420p, held alongside a live h264 decoder inside a 640MB
  // container. A still is one decode of one file and costs 267MB measured. The
  // flag is already here: `planRender` derives it from the path's extension.
  if (motion.kind === "kenburns" && input.still) {
    const preScale = motion.preScale ?? DEFAULT_PRE_SCALE;
    const frames = Math.round(clipSeconds * FPS);
    const zoom = motion.scale;
    // A push-in and a drift at once, which is what Ken Burns is — a zoom alone
    // reads as a slow zoom and a drift alone is the pan we already had.
    // `on` is the output frame number, so `on/frames` runs 0 to 1 exactly as
    // `T` does for the pans, and the two moves share one clock.
    const progress = `on/${frames}`;
    const drift = PAN_EXPRESSIONS[(input.index ?? 0) % PAN_EXPRESSIONS.length];

    return (
      `scale=${Math.round(1536 * preScale)}:${Math.round(1024 * preScale)}:` +
      `force_original_aspect_ratio=increase,` +
      `zoompan=z='min(1+${(zoom - 1).toFixed(3)}*${progress},${zoom})':d=1:` +
      `x='${zoomPanX(drift, progress)}':y='${zoomPanY(drift, progress)}':` +
      `s=${width}x${height}:fps=${FPS},setsar=1`
    );
  }
```

with, above it:

```ts
/** See `MotionStyle.preScale`. Four is where the frozen-frame fraction reaches
 *  zero; three leaves 4.4% and is the fallback if Task 2's measurement on the
 *  worker comes back tighter than expected. */
const DEFAULT_PRE_SCALE = 4;
```

`zoomPanX` / `zoomPanY` translate the four `PAN_EXPRESSIONS` directions into
`zoompan`'s coordinate space, where the crop size is `iw/zoom` rather than a
constant. They are two small pure functions and belong beside
`PAN_EXPRESSIONS`, sharing its cycle so the same segment index picks the same
direction in either mode.

- [x] **Step 3: Tests in `ffmpeg-command.test.ts`**

- A `SegmentInput` with no `motion.kind` produces **exactly** the filter string
  the existing snapshot asserts. This is the test that matters most.
- `kind: "kenburns"` + `still: true` emits `zoompan`, the 4× `scale` before it,
  and `s=1920x1080`.
- **`kind: "kenburns"` + `still: false` emits the pan, not `zoompan`.** Assert
  the absence of the string `zoompan` explicitly. This is the OOM guard and it
  needs a test that fails loudly if somebody "simplifies" the condition.
- Vertical: `format: "VERTICAL"` + kenburns emits `s=1080x1920`.
- The zoom expression's ceiling equals `motion.scale`, so a still never scales
  past the margin it was given.

- [x] **Step 4: Prove it on the worker**

Re-run Task 2's frozen-pair count against a segment produced by the *real*
`buildSegmentArgs` output for a kenburns still. The number to beat is 75.7%; the
number to expect is 0%.

**Needs a key?** No.

---

### Task 4: `ScriptCue.shot`

**Files:**
- Modify: `src/lib/script-cues.ts`, `src/lib/script-cues.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CueMeta.shot`, carried through `anchorCues` and `cueWindows`.

**Why:** the picture plan has to be computable by `footage.service.ts` and
`render.service.ts` independently, from data both already hold, with no stored
plan that could drift — that is what `story-beats.ts` exists to guarantee. The
channel's `footageStyle` is not available to the renderer *by design*. The cues
are. So the shot plan lives on the cue, exactly as `beat` does.

`cues` is a `Json?` column. **There is no migration in this task.**

- [ ] **Step 1: Add the field to `CueMeta`**

```ts
  /**
   * What kind of picture this section wants: a generated still, or a stock clip
   * of something actually moving.
   *
   * Written by the long-form list format's writer, which is already making this
   * judgement — `CUE_RULES` tells it to "prefer motion and people over static
   * objects", and the cue it emits is already a stock search query. It just had
   * nowhere to record the answer.
   *
   * Absent on every cue written before today, and absent is what makes this
   * safe: a script with no shot tags groups by `BEAT_TARGET_SECONDS` exactly as
   * it always has. Presence on EVERY cue is what switches the plan — see
   * `isShotScripted`, and see `isBeatScripted` beside it, which took the same
   * shape for the same reason.
   */
  shot?: "still" | "motion";
```

- [ ] **Step 2: Carry it through both functions**

`anchorCues`, in the conditional spread beside `beat` and `emphasis`:

```ts
      ...(cue.shot !== undefined ? { shot: cue.shot } : {}),
```

`cueWindows`, destructure `shot` and spread it the same way. Both spreads are
conditional so a cue without a shot tag produces an object byte-identical to the
one these functions have always returned.

- [ ] **Step 3: Tests**

- A cue with `shot: "motion"` survives anchoring and windowing.
- A cue without one produces an object with no `shot` key at all — assert with
  `expect(Object.keys(result[0])).toEqual([...])`, not `toBeUndefined()`, which
  passes for a present-but-undefined key.

**Needs a key?** No.

---

### Task 5: One slot per shot-tagged cue

**Files:**
- Modify: `src/lib/story-beats.ts`, `src/lib/story-beats.test.ts`

**Interfaces:**
- Consumes: `CueMeta.shot` (Task 4).
- Produces: `planStoryBeats` returning one beat per cue for a shot-scripted
  narration.

**Why:** `beatCountFor(480, n)` with `BEAT_TARGET_SECONDS = 20` gives 24
pictures at 20 seconds each. That constant was measured on four-minute
children's bedtime stories and `story-beats.ts` says so. An eight-minute list
explainer has seven segments of ~68 seconds; one picture across a segment is a
slideshow. The target is ~40 shots at ~12s — and 40 is exactly `MAX_BEATS`,
whose own comment already prices it at "about $2".

The mechanism is the one already in the file: an early return for a narration
whose writer decided the shot changes.

- [ ] **Step 1: Add the predicate beside `isBeatScripted`**

```ts
/**
 * True when this script's writer chose where every shot changes.
 *
 * The same signal `isBeatScripted` reads, one format later and for the same
 * reason: `footage.service.ts` and `render.service.ts` must reach an identical
 * grouping without either of them being able to see the channel's
 * `footageStyle`, and the cues are the only thing both of them have.
 *
 * `every`, not `some`. A script where half the cues carry a shot tag is a parse
 * that went wrong, and grouping half of it one way and half the other produces
 * a video whose cutting rhythm changes in the middle for no reason a viewer
 * could name.
 */
function isShotScripted(anchored: readonly AnchoredCue[]): boolean {
  return anchored.length > 0 && anchored.every((cue) => Boolean(cue.shot));
}
```

- [ ] **Step 2: Widen the early return in `planStoryBeats`**

The existing early return already produces exactly the right answer — one beat
per cue, `BEAT_MIN_SECONDS` deliberately not applied. Widen its condition and
extend its comment rather than adding a second branch that does the same thing:

```ts
  // One picture per cue, and none of the grouping below.
  //
  // [existing comment about the single-insight format, kept verbatim]
  //
  // The long-form list format arrives at the same place from the other end. It
  // is eight minutes rather than forty-five seconds, but its writer is asked
  // for ~40 sections rather than the ~55 an ordinary explainer produces, and it
  // tags each one `still` or `motion` — so the shot count IS the section count
  // and grouping it again by seconds would undo the decision the writer was
  // asked to make. `BEAT_MIN_SECONDS` does not apply here either: 480s over 40
  // shots is 12s a picture, deliberately below a floor written for bedtime
  // stories.
  if (isBeatScripted(anchored) || isShotScripted(anchored)) {
```

- [ ] **Step 3: Tests**

- 40 shot-tagged cues over 480 seconds produce 40 beats of one section each.
- Cues with **no** shot tag and no beat produce exactly what they do today —
  copy an existing assertion rather than writing a new one.
- A mix (some tagged, some not) falls through to the seconds-based grouping.
  Assert this deliberately: the failure it prevents is a video whose cutting
  rate changes halfway.
- `MAX_BEATS` is **not** applied on this path, and a comment says why: the
  writer's count is the count, and a cap that silently dropped shot 41 would
  leave the last minutes of narration with no picture.

**Needs a key?** No.

---

### Task 6: The long-form list script style

**Files:**
- Modify: `src/lib/script-styles.ts`, `src/lib/script-styles.test.ts`
- Create: `src/lib/longform-script.ts`, `src/lib/longform-script.test.ts`
- Modify: `src/services/script.service.ts`

**Interfaces:**
- Consumes: `CueMeta.shot`.
- Produces: a `SCRIPT` catalogue entry; `checkLongformScript`.

**Why:** the existing `countdown` style already produces a seven-entry list at
six minutes with per-section cues. What it cannot do is tell the collector which
sections want motion, or hit 40 sections rather than 40-at-22-words-each-which-
happens-to-be-40. This is a sibling of `countdown`, not a replacement, and it is
mostly the same prompt.

- [ ] **Step 1: The catalogue entry**

`id: "longform-list"`, `targetSeconds: 480`, `targetLength: "About 8 minutes"`,
`count` defaulting to `7`. Reuse `VOICE_RULES`, `SOURCING_RULES` and
`CUE_RULES` verbatim — they are properties of the renderer, and a style that
reworded them would be describing a different pipeline. Add one block:

```
SHOTS — this format decides its own pictures, so each section carries one more field than usual.
- Write about 40 sections. That is roughly 30 words each across eight minutes, and it is deliberately fewer and longer than an ordinary explainer's.
- Tag every section `still` or `motion`.
- `motion` means the thing you are describing genuinely moves and a camera could have filmed it: a crowd, traffic, water, a machine running, hands working, weather. It will be filled from a stock library.
- `still` is everything else, and it is the default. It will be drawn.
- Keep `motion` to about one section in five, and spread them out. Two motion shots in a row read as a different video spliced in.
- Never tag a section `motion` for a thing no camera has filmed — a historical event, an abstraction, a diagram. There is no such footage, and the section will end up drawn anyway.
```

Plus one rule inside the visual block, which is the entire dual-aspect feature
(spec, Part 7):

```
- The subject sits in the middle of the frame, with the sides carrying context rather than content. Vertical Shorts are cut from this video by keeping the centre 9:16 of each picture, so anything important near an edge is lost.
```

- [ ] **Step 2: `starterSubjects`**

Five list subjects the format is genuinely good at, phrased as a subject rather
than an instruction — `AutomationService.deriveTitle` takes the first sentence
verbatim, and `{{topic}}` is substituted as written.

- [ ] **Step 3: The pre-spend gate**

`src/lib/longform-script.ts`, modelled on `insight-script.ts`: pure, no Prisma,
no `server-only`, its own tests. What it checks, and only what it can check
cheaply and certainly:

```ts
/** The narration a section carries. Under twenty and the video is being cut
 *  faster than the pictures can hold; over forty and one picture is covering
 *  two ideas. */
export const MIN_WORDS_PER_SECTION = 20;
export const MAX_WORDS_PER_SECTION = 40;

/** How many sections an eight-minute list runs to. Forty is `MAX_BEATS`, whose
 *  own comment already prices it at about $2 of generated stills — the first
 *  format with a reason to reach that ceiling. */
export const MIN_SECTIONS = 32;
export const MAX_SECTIONS = 44;

/** The share of sections that may be filled from a stock library.
 *
 *  A cap in code and not only in the prompt, because a prompt is a request. A
 *  model that tags everything `motion` would turn an eight-minute video into a
 *  stock reel, which is the exact thing generated stills exist to avoid; the
 *  excess falls back to stills in cue order rather than failing the script. */
export const MAX_MOTION_SHARE = 0.35;
```

plus `BANNED_PHRASES` reused from `insight-script.ts` — it is exported for
precisely this reason, and re-listing it would let a copy rot.

`checkLongformScript` returns `{ ok, errors }` with whole-sentence errors safe
to append to a retry prompt verbatim, matching `validateInsightScript`'s
contract. Run it in `script.service.ts` before persisting, retry once with the
errors appended, and give up loudly on the second failure — the same loop the
insight format already uses.

- [ ] **Step 4: Parse `shot` out of the model's answer**

In `script.service.ts`, wherever the structured sections become `ScriptCue[]`,
carry `shot` through beside `beat` and `emphasis`. Apply `MAX_MOTION_SHARE`
here rather than in the collector: the cap is a property of the script, and a
script whose cues have already been trimmed is one the renderer and the
collector will agree about without either of them re-deciding.

- [ ] **Step 5: Tests**

- `script-styles.test.ts` already pins that a style's `targetSeconds` agrees
  with its own `duration` default. The new entry must pass it unchanged.
- `longform-script.test.ts`: a 40-section script with 8 `motion` tags passes; 20
  sections fails with a countable error; 20 `motion` tags out of 40 is trimmed
  to 14 rather than rejected; a banned phrase fails, asserted by importing
  `BANNED_PHRASES` rather than restating it.

**Needs a key?** No.

---

### Task 7: The mixed collector

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/footage-styles.ts`, `src/lib/beat-storage.ts`, `src/services/footage.service.ts`, `src/services/render.service.ts`
- Create: `prisma/migrations/20260818090000_add_mixed_footage_style/migration.sql`

**Interfaces:**
- Consumes: `CueMeta.shot`, `planStoryBeats`.
- Produces: `FootageStyle.MIXED`; `beats/beat-NNN.mp4` beside `beats/beat-NNN.png`.

**Why this shape:** `planRender` already sets `still: isStillImagePath(clipPath)`
and `buildSegmentArgs` already spreads `-loop 1` or `-stream_loop -1` from it.
**A mixed timeline already renders.** The only obstacles are a collector that
produces one and a query that can see it.

- [ ] **Step 1: The enum value and its migration**

```prisma
enum FootageStyle {
  LIVE_ACTION
  CARTOON
  ILLUSTRATED
  CINEMATIC
  /// Generated stills for most shots and stock clips for the ones the script
  /// tagged `motion`. The only style whose pictures come from more than one
  /// source in one video.
  MIXED
}
```

```sql
ALTER TYPE "FootageStyle" ADD VALUE 'MIXED';
```

`isGeneratedFootage(style)` must return **true** for `MIXED` — the enum forces
that decision at compile time, which is the point of it being a function over
the enum rather than a second list. `needsCharacterSheet` returns false.

- [ ] **Step 2: Two more path helpers**

`src/lib/beat-storage.ts`:

```ts
/**
 * Beat `index`'s stock clip, filed under the SAME prefix as the stills.
 *
 * One prefix and not two, and it is the whole design. `render.service.ts`
 * recognises a generated video by asking what is under `beats/`; a second
 * prefix would mean a second question, and a video that answered yes to both
 * would have two competing picture plans with nothing to reconcile them.
 * Everything downstream keys off the EXTENSION instead — `isStillImagePath` in
 * ffmpeg-command.ts already decides `-loop 1` versus `-stream_loop -1` from it,
 * which is why the renderer needs no other change to play a mixed timeline.
 */
export function beatClipPath(videoId: string, index: number): string {
  return storagePath(videoId, "beats", `beat-${String(index).padStart(3, "0")}.mp4`);
}

/** Which of the two a beat actually got, from the paths already on disk.
 *  Returns null for a beat with neither, which the renderer refuses on. */
export function beatAssetPath(
  present: ReadonlySet<string>,
  videoId: string,
  index: number,
): string | null {
  const still = beatImagePath(videoId, index);
  if (present.has(still)) return still;
  const clip = beatClipPath(videoId, index);
  if (present.has(clip)) return clip;
  return null;
}
```

- [ ] **Step 3: The collector**

Add `MIXED: { kind: "MIXED" }` to `FOOTAGE_SEARCH_PLAN` and a `{ readonly kind:
"MIXED" }` arm to `FootagePlan`. The collection loop is the existing generated
loop with one branch at the top of each beat:

```ts
      // A beat covers exactly one cue on this path (see `isShotScripted`), so
      // "what did the writer ask for" has a single answer per beat. A beat
      // covering several cues cannot, which is why the mixed plan is only
      // reachable from a shot-scripted script.
      const wantsMotion = beat.sectionIndices.length === 1
        && anchored[beat.sectionIndices[0]].shot === "motion";
```

For a `motion` beat, search the channel's stock providers with the beat's own
cue and store the download at `beatClipPath`. **The fallback is a still**:

```ts
      // A motion shot with no clip becomes a drawn one rather than a gap.
      //
      // Same stance `collectPerCue` already takes when a section's own search
      // comes back empty: a thinner stock library should make the video
      // slightly more expensive, never leave a hole in it. The opposite
      // fallback — a still shot filled with stock — is deliberately NOT
      // offered: the stills carry the video's look, and substituting stock into
      // one is how a channel starts looking like every other channel.
```

Skip a beat whose asset already exists, exactly as the illustrated loop does, so
collecting again retries only what failed.

- [ ] **Step 4: Widen the renderer's query — the one-line change**

`src/services/render.service.ts:309`:

```ts
    const beatAssets = await prisma.asset.findMany({
      where: {
        // Both kinds, because a mixed video's slots are stills and clips under
        // one prefix (see `beatClipPath`). `illustrated` below stays a single
        // boolean and means what it always meant — "this video's pictures are
        // beats, not sections" — and everything after it is unchanged, because
        // `planRender` asks the path's extension how to open each one.
        kind: { in: ["IMAGE", "VIDEO"] },
        deletedAt: null,
        storagePath: { startsWith: beatPrefix(videoId) },
      },
      orderBy: { storagePath: "asc" },
      select: { storagePath: true },
    });
```

and resolve each beat's path through `beatAssetPath` rather than assuming
`beatImagePath`. The missing-beat guard below it, the `beatSeconds` timing, the
transitions, the concat list and the captions are all untouched.

- [ ] **Step 5: Tests**

- `footage.service.test.ts`: a `MIXED` collection over 10 cues, 2 tagged
  `motion`, generates 8 images and downloads 2 clips, all under `beats/`.
- A `motion` beat whose stock search returns nothing is drawn instead, and the
  progress line says so.
- Re-running collection with 9 of 10 beats present touches only the tenth.
- `render.service.test.ts`: a video with 8 PNGs and 2 MP4s under `beats/`
  renders; `planRender` receives `still: true` for the PNGs and `false` for the
  MP4s. **A video with only PNGs produces byte-for-byte the argv it does today.**
- A beat with neither file is refused with the existing message.

**Needs a key?** No. Pexels and Pixabay are already configured platform-level.

---

### Task 8: Shorts from a beat-collected video

**Files:**
- Modify: `src/services/shorts.service.ts`, `src/services/shorts.service.test.ts`
- Modify: `src/lib/shorts-plan.ts`

**Interfaces:**
- Consumes: `beatAssetPath`, `planStoryBeats`.
- Produces: shorts that work on `ILLUSTRATED` / `CINEMATIC` / `MIXED` videos.

**Why:** they do not work at all today. `requireSectionClips` builds its wanted
list from `sectionClipPath` (`videos/{id}/clips/section-NNN.mp4`) and queries
`kind: "VIDEO"`; a generated video's pictures are `kind: "IMAGE"` at
`beats/beat-NNN.png`. Every short on every generated video fails with *"This
video's footage is no longer in storage"* — a message about an unrecoverable
state, for what is actually an unimplemented path. The "seven derived Shorts"
in the operator's spec is almost entirely this task.

- [ ] **Step 1: Ask for the right assets**

Split `requireSectionClips` into a beat-aware pair. The membership check is the
same shape; only the paths and the `kind` differ. Keep the *"generate shorts
before publishing"* branch — `reclaimClipStorage` still deletes `clips/`, and
although it leaves `beats/` alone, a mixed video's motion slots are `kind:
"VIDEO"` under `beats/` and the reclaim's `clips/` prefix filter is what spares
them. Say so in a comment; it is not obvious and it is one prefix away from
being false.

- [ ] **Step 2: Map a window onto beats**

`planShortSlots` currently walks `windows` — one per section — and merges slots
under a floor. For a beat-collected video the picture unit is a beat covering
one or more sections. Add a beat-aware entry point that reduces the section
windows to beat windows first (start of the beat's first section, start of the
next beat's first section) and then reuses the existing merge logic unchanged.

For a shot-scripted long-form video, a beat *is* a section, so this path is the
identity — which is worth a comment, because it means the interesting case is
the four-minute illustrated bedtime story where a beat spans three sections and
a 12-second short may sit entirely inside one beat.

- [ ] **Step 3: Tests**

- A generated video with 40 beats yields a short composed from the right subset.
- A short whose whole window falls inside one beat composes as a single slot.
- A stock video's slot plan is **unchanged** — copy an existing assertion.
- A `PUBLISHED` generated video still refuses, with the reclaim message.

**Needs a key?** No.

---

### Task 9: Seven shorts

**Files:**
- Modify: `src/actions/shorts.action.ts`, `src/schemas/`, `src/features/videos/components/shorts-panel.tsx`

**Why this is the smallest task in the plan:** `shortsService.generate(userId,
videoId, count = DEFAULT_SHORT_COUNT)` **already takes a count.**
`generateShortsAction` simply never passes one, and `DEFAULT_SHORT_COUNT = 3`.
Eight minutes at 12–60 seconds a short is 84–420 seconds of non-overlapping
window out of 480, which the `windowsOverlap` rule accommodates comfortably.

- [ ] **Step 1: Accept a count**

Add a validated `count` to the action's input — a bounded integer, server-side,
in the codebase's existing schema style. Bound it at the top: each short is one
`generateObject` call's worth of judgement and seven worker renders, and an
unbounded number is an unbounded queue.

- [ ] **Step 2: Offer it in the panel**

The Generate button becomes a small count selector. Default stays **3** —
changing a default changes what every existing operator gets on their next
click, and seven shorts off a four-minute video is six near-identical uploads
that `windowsOverlap` will mostly reject anyway.

- [ ] **Step 3: Note what is deliberately not done**

Shorts generation stays **manual**. `scheduleService` and `autoPublishService`
never call `shortsService`, `autoPublishService.executeClaim` publishes without
`includeShorts`, and automating generation would put seven uploads on a real
channel from a run nobody watched. `ReleaseCadence` already drips *banked*
shorts, which is the automated half and the safe half. Leave the split alone.

- [ ] **Step 4: Tests**

- The action rejects a count outside its bounds.
- `generate` with `count: 7` over a 480-second narration returns up to 7
  non-overlapping windows.
- Omitting the count still produces 3.

**Needs a key?** No.

---

### Task 10: The motion tier — NEEDS A fal.ai KEY, AND IS RECOMMENDED AGAINST

**Do not start this task without a decision from the operator.** The spec's
Part 5 argues it out of v1, with numbers:

- It is **84–97% of the video's cash cost for 25% of its runtime.** 192 billed
  seconds a video after `render-manifest.ts`'s own 1.6× reject multiplier, at
  $0.03–0.25 a second, against $1.50 for all thirty-two stills.
- It fights the cutting rhythm. `MAX_CLIP_SECONDS = 5.0`; a still holds 12–25
  seconds. A generated clip in a 12-second slot is `-stream_loop -1` playing the
  same motion three times.
- **There is no provider.** `GOOGLE_VEO`, `RUNWAY`, `KLING`, `REPLICATE`,
  `PIKA`, `LUMA` appear in exactly three places each — the enum,
  `provider-labels.ts`, `provider.schema.ts`. No adapter, no service, no call
  site. Everything image-shaped in this app goes through `createGateway` from
  the `ai` package, and **the gateway does not carry a video model.**
- The genre does not use it: 52% of the benchmark channel's sampled frame pairs
  are pixel-identical, and `story-beats.ts` already records the same finding for
  the neighbouring genre.

If it is built anyway, this is what it is, and none of it is small:

- [ ] A `VideoProvider` interface and a fal.ai adapter — a **poll-for-result**
      API, unlike every provider in this codebase, so it needs a job record and
      a worker tick rather than an `await`.
- [ ] `ProviderCredential` wiring for whichever `AiProviderType` slot is used,
      through `providerCredentialService.resolveKey`.
- [ ] A manifest stage: `checkManifest` before a single billed second, seeds
      persisted so one bad clip is re-rolled alone, `billedSeconds` shown to the
      operator before they commit.
- [ ] A per-video spend ceiling, refused rather than warned. This is the first
      thing in Framecast that can spend $50 on one video by accident.
- [ ] A decision about slot length that does not make the stills look wrong.
- [ ] `ProviderUsage` rows, which Task 1 established the pattern for.

**Needs a key?** Yes — and the operator does not have one. Every other task in
this plan runs on keys that already exist.

---

## Verification: one real video

- [ ] **A dry run first.** Generate the script only, on staging. Confirm: ~40
      sections, ~8 tagged `motion`, the gate passed, every cue anchored, seven
      list entries. This costs about four cents and spends nothing on pictures.
- [ ] **Confirm the plan before footage.** 40 beats from 40 cues (not 24 from
      the seconds grouping), one asset path per beat, `kenburns` resolving.
      Stop here if any of it is wrong. Nothing above this line has drawn a
      picture.
- [ ] **Collect.** Watch the per-beat progress lines: 32 drawn, 8 downloaded,
      and the token counts from Task 1 beside each price. **The sum of those
      prices against the gateway invoice is the second half of Task 1's
      measurement.**
- [ ] **Render, and time it.** The segment pass is 1.7× what it was; record
      what that is in real minutes on the VPS.
- [ ] **Watch it.** The judgement is not "did it render". It is: does the
      picture move, or does it stutter? Do the eight stock clips read as part of
      the same video or as a different video spliced in? Does one picture every
      twelve seconds hold, or does it feel like a slideshow?
- [ ] **Cut seven shorts, then watch one.** The 9:16 centre crop of a 1536×1024
      still is a 1.875× upscale of 576×1024 pixels. Decide whether that is
      acceptable before this becomes the channel's Shorts strategy.
- [ ] **Do not publish it.** This is a look, not a release.

---

## What will most likely go wrong

**The zoompan filter string is subtly wrong and nobody sees it.** `zoompan`
silently accepts an expression that evaluates to a constant, and the result is a
static picture — which is what already ships, so it looks like nothing changed.
Task 3's frozen-pair count is the only check that catches it; do not skip it in
favour of watching the video, because 76% frozen and 100% frozen look similar at
a glance.

**`isShotScripted` fires on a script it should not.** It is an `every`, so one
untagged cue turns 40 slots back into 24 and the video costs 40% less and looks
worse. If the collected picture count is not what the dry run predicted, that is
the first place to look.

**The stock clips do not intercut.** Eight Pexels clips among thirty-two
generated stills in one fixed grade is exactly the seam `CINEMATIC_STYLE_BIBLE`
exists to prevent, and no prompt can grade a clip that was filmed by somebody
else. If it reads badly, the fix is fewer motion tags, not a colour filter.

**The image price is $0.047 and the operator budgeted on $0.006.** Then this
video costs $1.60 rather than $0.25 and every number in the spec's right-hand
column is wrong. This is why Task 1 is first.

**Beat images accumulate forever.** `reclaimClipStorage` filters `kind: "VIDEO"`
under `clips/`, so a stills-dominant format leaves 32 PNGs a video on a 40GB
disk permanently. Not in scope here, deliberately, but it is a retention
question this format creates and somebody should own it before it is discovered
as a full disk.
