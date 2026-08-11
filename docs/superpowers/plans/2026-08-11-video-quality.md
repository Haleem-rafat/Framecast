# Video Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a rendered Framecast video look and sound produced — clips that
move, narration at a fixed loudness over a ducked music bed, crossfades with
sound effects, styled captions, and correctly pronounced proper nouns.

**Architecture:** Every setting added here is a field on one `VideoStyle` value
object with a `DEFAULT_STYLE` constant, threaded from `RenderService` into the
ffmpeg argument builders and the TTS call. The two-pass render structure is
preserved exactly: pass one normalises one clip at a time, pass two joins with
the concat demuxer. Transitions are short standalone stub files interleaved
into the concat list, never an `xfade` graph across the timeline.

**Tech Stack:** TypeScript, Next.js 15, Prisma 7, Vitest, ffmpeg (spawned with
an argument array), Jamendo API, ElevenLabs pronunciation dictionaries.

**Spec:** `docs/superpowers/specs/2026-08-11-video-quality-design.md`

## Global Constraints

- Verify with `pnpm verify` (`lint`, `typecheck`, `test`). Individual tests run
  with `npx vitest run <path> -t "<name>"`.
- Tests create throwaway users via `src/test/fixtures.ts`
  (`createTestUser` / `deleteTestUser`). Never `prisma.user.findFirstOrThrow`.
- ffmpeg is always spawned with an argument array, never a shell string.
- Loudness target is −14 LUFS, a module constant, never a `VideoStyle` field.
- Every feature here degrades rather than blocking: no music, no SFX, no
  dictionary, or a failed stub must still produce a publishable video. The one
  exception is a total-duration mismatch, which fails loudly.
- Existing behaviour that must not change: segment normalisation stays one
  decoder at a time, and pass two stays on the concat demuxer.
- Files under `src/services/providers/` follow the shape in
  `stock-footage.provider.ts`: an interface in `types.ts`, a class, an exported
  singleton, `ProviderError` with a retryable flag.

### Dependency on the script-matched footage plan

This plan is written against the **current** `ffmpeg-command.ts` signatures, so
it can be executed today. `docs/superpowers/plans/2026-08-11-script-matched-footage.md`
Task 5 changes `planRender` to take a `durations: number[]` array. Whichever
lands second must reconcile the two: `planRender` ends up taking both
`durations: number[]` and `transitionSeconds`. Task 5 below is written so that
its per-segment duration handling is already array-shaped internally, which
makes that reconciliation a signature change rather than a rewrite.

---

### Task 1: The VideoStyle value object

**Files:**
- Create: `src/lib/video-style.ts`
- Test: `src/lib/video-style.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VideoStyle`, `MotionStyle`, `CaptionStyle`, `AudioStyle`,
  `TransitionStyle`, `VoiceStyle`, and `DEFAULT_STYLE: VideoStyle`. Every later
  task reads from this object rather than adding its own constants.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";

import { DEFAULT_STYLE } from "@/lib/video-style";

describe("DEFAULT_STYLE", () => {
  it("pans far enough to be visible but not so far the crop starves", () => {
    // The crop window is the full frame; the source is scaled by this factor,
    // so the pannable margin is (scale - 1) of the frame. Below ~1.05 the move
    // is invisible; above ~1.3 the effective resolution drops noticeably.
    expect(DEFAULT_STYLE.motion.scale).toBeGreaterThan(1.05);
    expect(DEFAULT_STYLE.motion.scale).toBeLessThanOrEqual(1.3);
  });

  it("keeps the music bed well under the narration", () => {
    expect(DEFAULT_STYLE.audio.musicGainDb).toBeLessThan(-12);
  });

  it("uses a transition short enough to read as a cut, not a dissolve", () => {
    expect(DEFAULT_STYLE.transitions.durationSeconds).toBeLessThanOrEqual(1);
    expect(DEFAULT_STYLE.transitions.durationSeconds).toBeGreaterThan(0);
  });

  it("pins a voice seed so an unchanged video re-renders identically", () => {
    expect(Number.isInteger(DEFAULT_STYLE.voice.seed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/video-style.test.ts`
Expected: FAIL — cannot resolve `@/lib/video-style`

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Everything about how a video looks and sounds that is a choice rather than a
 * constraint.
 *
 * Deliberately not a database column yet. The destination is a per-channel
 * style — that is the whole "what varies per user is data" direction — but
 * persisting it now would mean a migration, validation and an editor UI before
 * a single improved render exists. Because every setting is already a field on
 * this one object, that change is later a migration plus a loader, with no
 * rewrite of the render code.
 *
 * The loudness target is NOT here. YouTube normalises playback to about
 * -14 LUFS, so a channel that "prefers" -9 simply gets turned down. Exposing it
 * would offer a choice that does not exist.
 */

export interface MotionStyle {
  enabled: boolean;
  /** The source is scaled by this factor so the crop window has room to move.
   *  The pannable margin is (scale - 1) of the frame. */
  scale: number;
}

export interface CaptionStyle {
  /** Must be installed in the worker image — libass falls back silently. */
  fontName: string;
  fontSize: number;
  /** libass &HBBGGRR, not #RRGGBB. */
  primaryColour: string;
  outlineColour: string;
  outline: number;
  shadow: number;
  marginV: number;
}

export interface AudioStyle {
  musicGainDb: number;
  sfxGainDb: number;
  duckThreshold: number;
  duckRatio: number;
  duckAttackMs: number;
  duckReleaseMs: number;
}

export interface TransitionStyle {
  enabled: boolean;
  durationSeconds: number;
}

export interface VoiceStyle {
  stability: number;
  style: number;
  speed: number;
  /** Fixed so a re-render of unchanged text produces the same narration. */
  seed: number;
}

export interface VideoStyle {
  motion: MotionStyle;
  captions: CaptionStyle;
  audio: AudioStyle;
  transitions: TransitionStyle;
  voice: VoiceStyle;
}

export const DEFAULT_STYLE: VideoStyle = {
  motion: { enabled: true, scale: 1.15 },
  captions: {
    fontName: "DejaVu Sans",
    fontSize: 22,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    outline: 2,
    shadow: 1,
    marginV: 60,
  },
  audio: {
    musicGainDb: -20,
    sfxGainDb: -8,
    duckThreshold: 0.03,
    duckRatio: 8,
    duckAttackMs: 20,
    duckReleaseMs: 300,
  },
  transitions: { enabled: true, durationSeconds: 0.5 },
  voice: { stability: 0.5, style: 0.3, speed: 1.0, seed: 20260811 },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/video-style.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/video-style.ts src/lib/video-style.test.ts
git commit -m "feat: one object for every video style choice"
```

---

### Task 2: Motion in the segment pass

**Files:**
- Modify: `src/lib/ffmpeg-command.ts` (`SegmentInput`, `buildSegmentArgs`)
- Test: `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Consumes: `MotionStyle` from Task 1.
- Produces: `SegmentInput` gains `motion?: MotionStyle` and `index?: number`.
  `buildSegmentArgs` emits a pan when motion is enabled. Task 5 constructs
  `SegmentInput` and must set `index`.

**Why pan and not zoom:** a `crop` filter's output size must be constant, so an
animated crop can translate the window but cannot resize it. Zoom needs
`zoompan`, which visibly judders unless the source is pre-upscaled far past the
output — memory this worker does not have. Pan is smooth, costs one extra scale
on a decoder that is already open, and removes the slideshow feel. Zoom is
deferred.

- [ ] **Step 1: Write the failing test**

```typescript
describe("buildSegmentArgs with motion", () => {
  const base = { clipPath: "/tmp/a.mp4", outputPath: "/tmp/segment-0.mp4", clipSeconds: 8 };
  const motion = { enabled: true, scale: 1.15 };

  it("scales past the frame so the crop window has room to travel", () => {
    const filter = valueOf(buildSegmentArgs({ ...base, index: 0, motion }), "-vf") ?? "";

    // 1920 * 1.15 = 2208, 1080 * 1.15 = 1242.
    expect(filter).toContain("scale=2208:1242");
    expect(filter).toContain("crop=2208:1242");
  });

  it("ends on a full-frame crop that moves with t", () => {
    const filter = valueOf(buildSegmentArgs({ ...base, index: 0, motion }), "-vf") ?? "";

    expect(filter).toContain("crop=w=1920:h=1080");
    expect(filter).toContain("t/8");
  });

  it("cycles direction by index so neighbours never move alike", () => {
    const filters = [0, 1, 2, 3, 4].map(
      (index) => valueOf(buildSegmentArgs({ ...base, index, motion }), "-vf") ?? "",
    );

    expect(filters[0]).not.toBe(filters[1]);
    expect(filters[1]).not.toBe(filters[2]);
    expect(filters[2]).not.toBe(filters[3]);
    // Four directions, so index 4 repeats index 0 — and a re-render of the
    // same video must produce byte-identical args.
    expect(filters[4]).toBe(filters[0]);
  });

  it("falls back to the plain normalising chain when motion is off", () => {
    const filter =
      valueOf(buildSegmentArgs({ ...base, index: 0, motion: { enabled: false, scale: 1.15 } }), "-vf") ?? "";

    expect(filter).toContain("scale=1920:1080");
    expect(filter).not.toContain("t/8");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts -t "with motion"`
Expected: FAIL — `SegmentInput` has no `index` or `motion`

- [ ] **Step 3: Write the implementation**

In `src/lib/ffmpeg-command.ts`, import the type and extend the input:

```typescript
import type { MotionStyle } from "@/lib/video-style";

export interface SegmentInput {
  clipPath: string;
  outputPath: string;
  /** How long a slot this clip fills. Short clips loop to fill it. */
  clipSeconds?: number;
  /** Position in the play order. Selects the pan direction, so the same video
   *  re-rendered produces identical arguments. */
  index?: number;
  motion?: MotionStyle;
}

/**
 * Four directions, cycled by segment index. A crop window can translate but not
 * resize — its output size must be constant — so these are pans, not zooms.
 * `t/<seconds>` runs 0 to 1 across the segment; the offset expressions turn
 * that into a full traverse of the margin the upscale created.
 */
const PAN_EXPRESSIONS = [
  { x: "(in_w-out_w)*T", y: "(in_h-out_h)/2" },
  { x: "(in_w-out_w)*(1-T)", y: "(in_h-out_h)/2" },
  { x: "(in_w-out_w)/2", y: "(in_h-out_h)*T" },
  { x: "(in_w-out_w)/2", y: "(in_h-out_h)*(1-T)" },
];

function buildVideoFilter(input: SegmentInput, clipSeconds: number): string {
  const motion = input.motion;

  if (!motion?.enabled) {
    return (
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},fps=${FPS},setsar=1`
    );
  }

  const scaledWidth = Math.round(WIDTH * motion.scale);
  const scaledHeight = Math.round(HEIGHT * motion.scale);
  const pan = PAN_EXPRESSIONS[(input.index ?? 0) % PAN_EXPRESSIONS.length];
  const progress = `t/${clipSeconds}`;

  return (
    `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,` +
    `crop=${scaledWidth}:${scaledHeight},fps=${FPS},` +
    `crop=w=${WIDTH}:h=${HEIGHT}:` +
    `x='${pan.x.replace(/T/g, progress)}':` +
    `y='${pan.y.replace(/T/g, progress)}',` +
    `setsar=1`
  );
}
```

Then replace the `-vf` value in `buildSegmentArgs` with
`buildVideoFilter(input, clipSeconds)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts`
Expected: PASS — including the pre-existing "normalises to the frame size"
test, which covers the motion-off path.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts
git commit -m "feat: pan each clip instead of holding it still"
```

---

### Task 3: Caption styling

**Files:**
- Modify: `src/lib/ffmpeg-command.ts` (`AssembleInput`, `buildAssembleArgs`)
- Modify: `worker/Dockerfile`
- Test: `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Consumes: `CaptionStyle` from Task 1.
- Produces: `AssembleInput` gains `captions?: CaptionStyle`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("buildAssembleArgs with caption styling", () => {
  const captions = {
    fontName: "DejaVu Sans",
    fontSize: 22,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    outline: 2,
    shadow: 1,
    marginV: 60,
  };

  it("passes the chosen face and metrics to libass", () => {
    const args = buildAssembleArgs({ ...assembleBase, captions });
    const joined = args.join(" ");

    expect(joined).toContain("force_style=");
    expect(joined).toContain("FontName=DejaVu Sans");
    expect(joined).toContain("FontSize=22");
    expect(joined).toContain("MarginV=60");
  });

  it("still escapes the subtitle path when a style is present", () => {
    const args = buildAssembleArgs({
      ...assembleBase,
      srtPath: "/tmp/my captions.srt",
      captions,
    });

    expect(args.join(" ")).toContain("my\\ captions.srt");
  });

  it("omits force_style entirely when no style is given", () => {
    expect(buildAssembleArgs(assembleBase).join(" ")).not.toContain("force_style");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts -t "caption styling"`
Expected: FAIL — `AssembleInput` has no `captions`

- [ ] **Step 3: Write the implementation**

In `src/lib/ffmpeg-command.ts`:

```typescript
import type { CaptionStyle, MotionStyle } from "@/lib/video-style";

/**
 * libass reads `force_style` as comma-separated `Key=Value` pairs. The value is
 * built here rather than by the caller so the escaping rules stay in the one
 * file that already knows them.
 */
function buildForceStyle(style: CaptionStyle): string {
  return [
    `FontName=${style.fontName}`,
    `FontSize=${style.fontSize}`,
    `PrimaryColour=${style.primaryColour}`,
    `OutlineColour=${style.outlineColour}`,
    `Outline=${style.outline}`,
    `Shadow=${style.shadow}`,
    `MarginV=${style.marginV}`,
  ].join(",");
}

export function buildSubtitleFilter(srtPath: string, captions?: CaptionStyle): string {
  const escaped = escapeForFilter(srtPath);
  if (!captions) {
    return `subtitles=${escaped}`;
  }
  return `subtitles=${escaped}:force_style='${buildForceStyle(captions)}'`;
}
```

Add `captions?: CaptionStyle` to `AssembleInput`, and use
`buildSubtitleFilter(input.srtPath, input.captions)` in the `-filter_complex`
value.

- [ ] **Step 4: Add the font to the worker image**

In `worker/Dockerfile`, alongside the existing ffmpeg install, add the font
package. A face named in `force_style` but absent from the image falls back
silently to the default, so the feature would look like it simply did not work:

```dockerfile
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
```

Adjust to match the image's actual package manager and existing ffmpeg line
rather than adding a second install step.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts worker/Dockerfile
git commit -m "feat: style the captions instead of taking libass's default"
```

---

### Task 4: The audio mix

**Files:**
- Modify: `src/lib/ffmpeg-command.ts` (`AssembleInput`, `buildAssembleArgs`)
- Test: `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Consumes: `AudioStyle` from Task 1.
- Produces: `AssembleInput` gains `musicPath?: string`, `sfxPath?: string`,
  `audio?: AudioStyle`. Input indices are fixed: 0 concat, 1 narration,
  2 music when present, then SFX.

- [ ] **Step 1: Write the failing test**

```typescript
describe("buildAssembleArgs audio chain", () => {
  const audio = {
    musicGainDb: -20,
    sfxGainDb: -8,
    duckThreshold: 0.03,
    duckRatio: 8,
    duckAttackMs: 20,
    duckReleaseMs: 300,
  };

  it("normalises the narration to the platform target", () => {
    const graph = valueOf(buildAssembleArgs({ ...assembleBase, audio }), "-filter_complex") ?? "";
    expect(graph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11");
  });

  it("ducks the music under the narration", () => {
    const graph =
      valueOf(
        buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" }),
        "-filter_complex",
      ) ?? "";

    expect(graph).toContain("sidechaincompress");
    // The narration feeds both the mix and the ducking key, so it must split.
    expect(graph).toContain("asplit");
  });

  it("never lets amix renormalise the levels", () => {
    const graph =
      valueOf(
        buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" }),
        "-filter_complex",
      ) ?? "";

    // amix's default divides by input count, silently undoing the loudnorm
    // above it. This flag is the whole reason the mix holds its level.
    expect(graph).toContain("normalize=0");
  });

  it("loops the music and relies on -t to end the render", () => {
    const args = buildAssembleArgs({ ...assembleBase, audio, musicPath: "/tmp/music.mp3" });

    // -stream_loop makes that input infinite, so the output -t is what stops
    // ffmpeg. It must sit immediately before the music input.
    const loopIndex = args.indexOf("-stream_loop");
    expect(loopIndex).toBeGreaterThan(-1);
    expect(args[loopIndex + 2]).toBe("-i");
    expect(args[loopIndex + 3]).toBe("/tmp/music.mp3");
    expect(valueOf(args, "-t")).toBe("428");
  });

  it("mixes three streams when music and effects are both present", () => {
    const graph =
      valueOf(
        buildAssembleArgs({
          ...assembleBase,
          audio,
          musicPath: "/tmp/music.mp3",
          sfxPath: "/tmp/sfx.m4a",
        }),
        "-filter_complex",
      ) ?? "";

    expect(graph).toContain("amix=inputs=3");
  });

  it("maps narration straight through when there is neither music nor effects", () => {
    const args = buildAssembleArgs(assembleBase);
    expect(args).toContain("1:a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts -t "audio chain"`
Expected: FAIL — `AssembleInput` has no `audio`

- [ ] **Step 3: Write the implementation**

In `src/lib/ffmpeg-command.ts`:

```typescript
/** YouTube normalises playback to about this. Not a style choice — see
 *  video-style.ts's doc comment. */
const LOUDNESS_TARGET = "loudnorm=I=-14:TP=-1.5:LRA=11";

interface AudioChain {
  /** Extra input arguments, in the order they must appear before the filters. */
  inputArgs: string[];
  /** Filter graph fragments, joined with `;` by the caller. */
  filters: string[];
  /** What `-map` should reference for audio. */
  audioMap: string;
}

/**
 * Builds the audio half of pass two.
 *
 * Input indices are positional and fixed: 0 is the concat list, 1 the
 * narration, then music, then the SFX track. Anything absent shifts the
 * following index down, which is why the index is tracked rather than assumed.
 */
function buildAudioChain(input: AssembleInput): AudioChain {
  const audio = input.audio;

  // Nothing to mix and no style: keep the original passthrough exactly.
  if (!audio) {
    return { inputArgs: [], filters: [], audioMap: "1:a" };
  }

  const inputArgs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];
  let nextIndex = 2;

  const needsKey = Boolean(input.musicPath);
  filters.push(
    needsKey
      ? `[1:a]${LOUDNESS_TARGET},asplit=2[narr][key]`
      : `[1:a]${LOUDNESS_TARGET}[narr]`,
  );
  mixLabels.push("[narr]");

  if (input.musicPath) {
    // Infinite input; the output -t below is what terminates the render.
    inputArgs.push("-stream_loop", "-1", "-i", input.musicPath);
    filters.push(`[${nextIndex}:a]volume=${audio.musicGainDb}dB[bed]`);
    filters.push(
      `[bed][key]sidechaincompress=threshold=${audio.duckThreshold}:` +
        `ratio=${audio.duckRatio}:attack=${audio.duckAttackMs}:` +
        `release=${audio.duckReleaseMs}[duck]`,
    );
    mixLabels.push("[duck]");
    nextIndex += 1;
  }

  if (input.sfxPath) {
    inputArgs.push("-i", input.sfxPath);
    filters.push(`[${nextIndex}:a]volume=${audio.sfxGainDb}dB[sfx]`);
    mixLabels.push("[sfx]");
    nextIndex += 1;
  }

  if (mixLabels.length === 1) {
    filters.push(`[narr]alimiter=limit=0.95[aout]`);
  } else {
    filters.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0,` +
        `alimiter=limit=0.95[aout]`,
    );
  }

  return { inputArgs, filters, audioMap: "[aout]" };
}
```

Extend `AssembleInput` with `musicPath?: string`, `sfxPath?: string`,
`audio?: AudioStyle`, then rebuild `buildAssembleArgs` so it places the audio
inputs after the narration input, joins `[0:v]…[vout]` with the audio filters
using `;`, and maps `chain.audioMap` instead of the hardcoded `1:a`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts`
Expected: PASS — including the pre-existing "maps the narration" test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts
git commit -m "feat: master the narration and mix music beneath it"
```

---

### Task 5: Transition stubs

**Files:**
- Modify: `src/lib/ffmpeg-command.ts` (`planRender`, `RenderPlan`, new `buildTransitionArgs`)
- Test: `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Consumes: `TransitionStyle` from Task 1.
- Produces: `planRender(clipPaths, segmentDir, clipSeconds, transitions?)`
  returning `RenderPlan` with `segments`, `playOrder`,
  `trims: SegmentTrim[]` (index-aligned with `playOrder`, where
  `SegmentTrim = { inpoint?: number; outpoint?: number }`), `trimmedSeconds`,
  and `transitions: TransitionJob[]` where
  `TransitionJob = { fromPath: string; toPath: string; outputPath: string; durationSeconds: number; startSeconds: number }`.
  Also `buildTransitionArgs(job): string[]` and a widened
  `concatListLine(segmentPath, trim?)`. Task 7 runs the jobs between the
  segment pass and the assemble pass.

**How the trim is actually applied.** The concat demuxer plays whole files, so
a trim cannot be expressed by listing segments alone — it needs the demuxer's
own `inpoint` / `outpoint` directives, which follow their `file` line. Pass two
re-encodes, so the frame-accuracy caveat that applies to `-c copy` does not
bite here.

**The arithmetic, stated once.** With `D` the transition length and segment `i`
owing an outgoing boundary, each segment except the last is generated `D`
seconds longer than its slot. A stub consumes the tail `D` of one segment and
the head `D` of the next. Total then telescopes back to the sum of the slots:
the first segment contributes `d₀`, each middle one `dᵢ − D`, the last
`d_last − D`, and the `k−1` stubs add `(k−1)D`. A test asserts this rather than
trusting the derivation.

- [ ] **Step 1: Write the failing test**

```typescript
describe("planRender with transitions", () => {
  const transitions = { enabled: true, durationSeconds: 0.5 };

  it("puts one stub between each adjacent pair", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"], "/tmp", 8, transitions);
    expect(plan.transitions).toHaveLength(2);
  });

  it("preserves the total duration exactly", () => {
    const clipSeconds = 8;
    const paths = ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"];
    const plan = planRender(paths, "/tmp", clipSeconds, transitions);

    // Segment source lengths, minus the halves the stubs consume, plus the
    // stubs themselves, must equal what the narration expects. A shortfall
    // here is what drifts the picture out of sync with the words.
    const segmentTotal = plan.playOrder.reduce(
      (sum, _path, index) => sum + plan.trimmedSeconds[index],
      0,
    );
    const stubTotal = plan.transitions.length * transitions.durationSeconds;

    expect(segmentTotal + stubTotal).toBeCloseTo(paths.length * clipSeconds, 5);
  });

  it("asks for extra source on every segment but the last", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", 8, transitions);
    expect(plan.segments[0].clipSeconds).toBeCloseTo(8.5, 5);
    expect(plan.segments[1].clipSeconds).toBeCloseTo(8, 5);
  });

  it("plans no transitions for a single segment", () => {
    const plan = planRender(["/tmp/a.mp4"], "/tmp", 8, transitions);
    expect(plan.transitions).toHaveLength(0);
  });

  it("plans no transitions when they are disabled", () => {
    const plan = planRender(["/tmp/a.mp4", "/tmp/b.mp4"], "/tmp", 8, {
      enabled: false,
      durationSeconds: 0.5,
    });
    expect(plan.transitions).toHaveLength(0);
  });
});

describe("concatListLine with a trim", () => {
  it("emits the demuxer's own in/out directives after the file line", () => {
    const line = concatListLine("/tmp/segment-1.mp4", { inpoint: 0.5, outpoint: 8 });

    // The demuxer plays whole files unless told otherwise; these directives
    // are the only way to drop the half-second a stub already covers.
    expect(line).toBe("file '/tmp/segment-1.mp4'\ninpoint 0.5\noutpoint 8");
  });

  it("emits a bare file line when nothing is trimmed", () => {
    expect(concatListLine("/tmp/segment-0.mp4")).toBe("file '/tmp/segment-0.mp4'");
  });
});

describe("buildTransitionArgs", () => {
  it("crossfades exactly two inputs and nothing else", () => {
    const args = buildTransitionArgs({
      fromPath: "/tmp/segment-0.mp4",
      toPath: "/tmp/segment-1.mp4",
      outputPath: "/tmp/stub-0.mp4",
      durationSeconds: 0.5,
      startSeconds: 7.5,
    });

    // Two decoders at a time is the whole point — this is why xfade is never
    // applied across the timeline.
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.join(" ")).toContain("xfade=transition=fade:duration=0.5");
    expect(args.at(-1)).toBe("/tmp/stub-0.mp4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts -t "transitions"`
Expected: FAIL — `planRender` takes three arguments; `buildTransitionArgs` is
not exported

- [ ] **Step 3: Write the implementation**

```typescript
import type { TransitionStyle } from "@/lib/video-style";

export interface TransitionJob {
  fromPath: string;
  toPath: string;
  outputPath: string;
  durationSeconds: number;
  /** Offset into `fromPath` where the crossfade begins. */
  startSeconds: number;
}

export interface SegmentTrim {
  inpoint?: number;
  outpoint?: number;
}

export interface RenderPlan {
  segments: SegmentInput[];
  playOrder: string[];
  transitions: TransitionJob[];
  /** Index-aligned with `playOrder`. What the concat demuxer must skip at each
   *  end because a stub already covers it. */
  trims: SegmentTrim[];
  /** How much of each play-order entry survives after the stubs take their
   *  share. Index-aligned with `playOrder`. */
  trimmedSeconds: number[];
}

/**
 * A concat-demuxer list entry. That parser treats `'` as a delimiter and its
 * escape is closing, escaping, reopening the quote — a backslash inside the
 * quotes would be read literally. `inpoint`/`outpoint` are directives that
 * apply to the `file` line above them.
 */
export function concatListLine(segmentPath: string, trim?: SegmentTrim): string {
  const lines = [`file '${segmentPath.replace(/'/g, "'\\''")}'`];
  if (trim?.inpoint !== undefined) {
    lines.push(`inpoint ${trim.inpoint}`);
  }
  if (trim?.outpoint !== undefined) {
    lines.push(`outpoint ${trim.outpoint}`);
  }
  return lines.join("\n");
}

/**
 * A stub is a standalone crossfade file, not a filter across the timeline.
 * `xfade` holds both inputs open, which is exactly the shape that OOM-killed
 * the worker at thirty-eight clips — but two decoders for half a second is
 * affordable, and the concat demuxer then reads stub and segment alike, one
 * file at a time.
 */
export function buildTransitionArgs(job: TransitionJob): string[] {
  return [
    "-y",
    "-ss", String(job.startSeconds),
    "-t", String(job.durationSeconds),
    "-i", job.fromPath,
    "-t", String(job.durationSeconds),
    "-i", job.toPath,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=${job.durationSeconds}:offset=0[vout]`,
    "-map", "[vout]",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", SEGMENT_CRF,
    "-pix_fmt", "yuv420p",
    "-threads", THREADS,
    job.outputPath,
  ];
}
```

Rewrite `planRender` to accept a fourth `transitions?: TransitionStyle`
argument:

```typescript
export function planRender(
  clipPaths: string[],
  segmentDir: string,
  clipSeconds = DEFAULT_CLIP_SECONDS,
  transitions?: TransitionStyle,
): RenderPlan {
  if (clipPaths.length === 0) {
    throw new ValidationError("Cannot render without at least one clip.");
  }

  const count = clipPaths.length;
  const D = transitions?.enabled ? transitions.durationSeconds : 0;
  const hasStubs = D > 0 && count > 1;

  const segmentPathOf = new Map<string, string>();
  const segments: SegmentInput[] = [];
  const sourceSecondsOf: number[] = [];

  clipPaths.forEach((clipPath, index) => {
    // Every segment but the last donates its tail to the outgoing stub, so it
    // must be generated that much longer. Without this the timeline shrinks by
    // D per boundary and the picture drifts off the narration.
    const sourceSeconds = hasStubs && index < count - 1 ? clipSeconds + D : clipSeconds;
    sourceSecondsOf.push(sourceSeconds);

    // A repeated clip is normalised once. The first slot to claim it fixes its
    // source length, so a repeat that needs a different length gets its own
    // segment rather than silently reusing a shorter one.
    const key = `${clipPath}@${sourceSeconds}`;
    if (!segmentPathOf.has(key)) {
      const outputPath = `${segmentDir}/segment-${segments.length}.mp4`;
      segmentPathOf.set(key, outputPath);
      segments.push({
        clipPath,
        outputPath,
        clipSeconds: sourceSeconds,
        index: segments.length,
      });
    }
  });

  const playOrder = clipPaths.map(
    (clipPath, index) => segmentPathOf.get(`${clipPath}@${sourceSecondsOf[index]}`)!,
  );

  if (!hasStubs) {
    return {
      segments,
      playOrder,
      transitions: [],
      trims: playOrder.map(() => ({})),
      trimmedSeconds: playOrder.map(() => clipSeconds),
    };
  }

  const trims: SegmentTrim[] = [];
  const trimmedSeconds: number[] = [];
  const jobs: TransitionJob[] = [];

  playOrder.forEach((segmentPath, index) => {
    const source = sourceSecondsOf[index];
    const dropsHead = index > 0;
    const dropsTail = index < count - 1;

    trims.push({
      inpoint: dropsHead ? D : undefined,
      outpoint: dropsTail ? source - D : undefined,
    });
    trimmedSeconds.push(source - (dropsHead ? D : 0) - (dropsTail ? D : 0));

    if (dropsTail) {
      jobs.push({
        fromPath: segmentPath,
        toPath: playOrder[index + 1],
        outputPath: `${segmentDir}/stub-${index}.mp4`,
        durationSeconds: D,
        startSeconds: source - D,
      });
    }
  });

  return { segments, playOrder, transitions: jobs, trims, trimmedSeconds };
}
```

Note what the dedup key change fixes: the original keyed on `clipPath` alone,
but a clip used both mid-timeline and last now needs two different source
lengths. Keying on both keeps "normalise each distinct clip once" true for
every case where it still applies.

Note the existing dedup: `planRender` normalises each *distinct* clip once, so
two play-order entries can share a segment file. A stub references segment
files by path, which is safe because the stub reads from a fixed offset.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts
git commit -m "feat: crossfade between clips without a timeline-wide graph"
```

---

### Task 6: The Jamendo music provider

**Files:**
- Modify: `src/services/providers/types.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Create: `src/services/providers/music.provider.ts`
- Test: `src/services/providers/music.provider.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MusicTrack { externalId, url, title, artistName, licenseUrl, durationSeconds }`,
  `MusicProvider { search(query: string, count: number): Promise<MusicTrack[]> }`,
  and the singleton `jamendoProvider`. Task 7 consumes both.

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { JamendoProvider } from "@/services/providers/music.provider";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const track = {
  id: "1",
  name: "Test",
  artist_name: "Artist",
  license_ccurl: "https://creativecommons.org/licenses/by/3.0/",
  duration: 180,
  audiodownload: "https://example.test/1.mp3",
  audiodownload_allowed: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JamendoProvider", () => {
  it("excludes non-commercial licences from the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [track] }));
    vi.stubGlobal("fetch", fetchMock);

    await new JamendoProvider().search("calm ambient", 3);

    // ccnc is unusable on a channel meant to be monetised, so it is excluded
    // at the query rather than filtered afterwards.
    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("ccnc")).toBe("false");
  });

  it("skips a track whose artist has disabled downloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ results: [{ ...track, audiodownload_allowed: false }] }),
      ),
    );

    expect(await new JamendoProvider().search("calm", 3)).toEqual([]);
  });

  it("returns the attribution fields the description needs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ results: [track] })));

    const [result] = await new JamendoProvider().search("calm", 3);

    expect(result.artistName).toBe("Artist");
    expect(result.title).toBe("Test");
    expect(result.licenseUrl).toContain("creativecommons.org");
  });

  it("marks a 5xx as retryable and a 400 as not", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(new JamendoProvider().search("calm", 3)).rejects.toMatchObject({
      retryable: true,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 400 })));
    await expect(new JamendoProvider().search("calm", 3)).rejects.toMatchObject({
      retryable: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/providers/music.provider.test.ts`
Expected: FAIL — cannot resolve `@/services/providers/music.provider`

- [ ] **Step 3: Add the environment key**

In `src/config/env.ts`, beside the stock footage keys:

```typescript
  /** Jamendo music search. Platform-level, like the stock footage keys. */
  JAMENDO_CLIENT_ID: z.string().min(1).optional(),
```

Add `JAMENDO_CLIENT_ID=` to `.env.example` under the same grouping.

- [ ] **Step 4: Write the implementation**

Add to `src/services/providers/types.ts`:

```typescript
export interface MusicTrack {
  externalId: string;
  url: string;
  title: string;
  artistName: string;
  licenseUrl: string;
  durationSeconds: number;
}

export interface MusicProvider {
  search(query: string, count: number): Promise<MusicTrack[]>;
}
```

Create `src/services/providers/music.provider.ts` following
`stock-footage.provider.ts`'s shape: throw `ProviderError("JAMENDO", …, false)`
when `env.JAMENDO_CLIENT_ID` is missing; build
`https://api.jamendo.com/v3.0/tracks` with `client_id`, `format=json`,
`limit`, `search=<query>`, `audioformat=mp32`, `include=musicinfo` and
`ccnc=false`; treat 429 and 5xx as retryable; and map results to `MusicTrack`,
skipping any entry where `audiodownload_allowed` is not `true` or
`audiodownload` is empty. Export `const jamendoProvider: MusicProvider = new JamendoProvider()`.

`ProviderError.provider` is a plain `string`, so "JAMENDO" needs no enum member
for the error path — the enum change in Task 7 is only for `Asset.provider`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/providers/music.provider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/providers/music.provider.ts src/services/providers/music.provider.test.ts src/services/providers/types.ts src/config/env.ts .env.example
git commit -m "feat: find commercially usable music on Jamendo"
```

---

### Task 7: Collect music and wire the render together

**Files:**
- Modify: `prisma/schema.prisma` (`AiProviderType`)
- Modify: `src/lib/storage.ts` (`StorageKind`)
- Create: `src/services/music.service.ts`
- Modify: `src/services/render.service.ts`
- Test: `src/services/music.service.test.ts`, `src/services/render.service.test.ts`

**Interfaces:**
- Consumes: `jamendoProvider`, `MusicTrack` (Task 6); `planRender`,
  `buildTransitionArgs`, `buildSegmentArgs`, `buildAssembleArgs` (Tasks 2–5);
  `DEFAULT_STYLE` (Task 1).
- Produces: `musicService.collect(videoId: string, query: string): Promise<string | null>`
  returning the storage path of the stored `MUSIC` asset, or `null` when no
  usable track was found. Task 9 reads the stored asset for attribution.

- [ ] **Step 1: Write the failing test**

Create `src/services/music.service.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { MusicService } from "@/services/music.service";
import type { MusicTrack } from "@/services/providers/types";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts). Assets carry no videoId column — they are scoped by
// their `videos/{videoId}/` storage prefix — so a throwaway uuid is a
// sufficient tenant here and no Video row is needed. Jamendo is never called:
// the provider is injected, matching VoiceOverService's own injection shape.
vi.setConfig({ testTimeout: 15_000 });

const track: MusicTrack = {
  externalId: "1",
  url: "https://example.test/1.mp3",
  title: "Test",
  artistName: "Artist",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  durationSeconds: 180,
};

let videoId: string;

beforeEach(() => {
  videoId = randomUUID();
});

afterEach(async () => {
  await prisma.asset.deleteMany({
    where: { storagePath: { startsWith: `videos/${videoId}/` } },
  });
  vi.restoreAllMocks();
});

describe("MusicService.collect", () => {
  it("returns null rather than throwing when the provider fails", async () => {
    const service = new MusicService({
      search: async () => {
        throw new ProviderError("JAMENDO", "down", true);
      },
    });

    // Music is an enhancement. A Jamendo outage must not block a video that is
    // otherwise ready to render.
    expect(await service.collect(videoId, "calm ambient")).toBeNull();
  });

  it("returns null when the search finds nothing usable", async () => {
    const service = new MusicService({ search: async () => [] });
    expect(await service.collect(videoId, "calm ambient")).toBeNull();
  });

  it("returns null when the download fails, leaving no asset behind", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    const service = new MusicService({ search: async () => [track] });

    expect(await service.collect(videoId, "calm ambient")).toBeNull();
    expect(
      await prisma.asset.count({
        where: { storagePath: { startsWith: `videos/${videoId}/` } },
      }),
    ).toBe(0);
  });

  it("stores the credit so publishing needs no second Jamendo call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.from("audio"))));
    const service = new MusicService({ search: async () => [track] });

    await service.collect(videoId, "calm ambient");
    const asset = await prisma.asset.findFirst({
      where: { kind: "MUSIC", storagePath: { startsWith: `videos/${videoId}/` } },
      select: { prompt: true, provider: true, externalId: true },
    });

    expect(asset?.provider).toBe("JAMENDO");
    expect(asset?.externalId).toBe("1");
    expect(asset?.prompt).toContain("Artist");
  });

  it("reuses the stored track instead of fetching twice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.from("audio"))));
    const search = vi.fn().mockResolvedValue([track]);
    const service = new MusicService({ search });

    const first = await service.collect(videoId, "calm ambient");
    const second = await service.collect(videoId, "calm ambient");

    // A re-render must not silently swap the music under a video the operator
    // has already reviewed.
    expect(second).toBe(first);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/music.service.test.ts`
Expected: FAIL — cannot resolve `@/services/music.service`

- [ ] **Step 3: Extend the schema and storage kinds**

In `prisma/schema.prisma`, add `JAMENDO` to `AiProviderType` beside the stock
footage members, with a comment matching theirs — platform-level, used only to
tag `Asset.provider`. Then:

```bash
pnpm db:migrate --name add_jamendo_provider
```

In `src/lib/storage.ts`, extend the union:

```typescript
export type StorageKind = "audio" | "clips" | "captions" | "music" | "output";
```

- [ ] **Step 4: Write the service**

Create `src/services/music.service.ts`:

```typescript
import "server-only";

import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { jamendoProvider } from "@/services/providers/music.provider";
import type { MusicProvider, MusicTrack } from "@/services/providers/types";

/** Overfetch so a track whose download 404s is not the end of the attempt. */
const SEARCH_COUNT = 5;

/**
 * Recorded on the Asset at collection time so `publish.service.ts` can credit
 * the track from stored state — the same reasoning as `PIXABAY_CREDIT`, which
 * exists because attribution that depends on the operator remembering is not
 * attribution.
 */
export function musicCredit(track: Pick<MusicTrack, "title" | "artistName" | "licenseUrl">): string {
  return `Music: "${track.title}" by ${track.artistName} (${track.licenseUrl})`;
}

export class MusicService {
  constructor(private readonly provider: MusicProvider = jamendoProvider) {}

  /**
   * Returns the storage path of this video's music bed, or `null` when it will
   * render without one.
   *
   * Never throws. Music is an enhancement to a video that is already
   * publishable, and a Jamendo outage must not turn a renderable video into a
   * failed one.
   */
  async collect(videoId: string, query: string): Promise<string | null> {
    // Assets carry no videoId column — the storage prefix is the scoping key,
    // the same convention render.service.ts already queries by.
    const existing = await prisma.asset.findFirst({
      where: {
        kind: "MUSIC",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    if (existing) {
      return existing.storagePath;
    }

    let tracks: MusicTrack[];
    try {
      tracks = await this.provider.search(query, SEARCH_COUNT);
    } catch {
      return null;
    }

    for (const track of tracks) {
      let audio: Buffer;

      try {
        const response = await fetch(track.url);
        if (!response.ok) {
          continue;
        }
        audio = Buffer.from(await response.arrayBuffer());
      } catch {
        continue;
      }

      const path = storagePath(videoId, "music", "bed.mp3");
      await putObject(path, audio, "audio/mpeg");

      await prisma.asset.create({
        data: {
          kind: "MUSIC",
          storagePath: path,
          mimeType: "audio/mpeg",
          provider: "JAMENDO",
          externalId: track.externalId,
          prompt: musicCredit(track),
        },
      });

      return path;
    }

    return null;
  }
}

export const musicService = new MusicService();
```

- [ ] **Step 5: Wire the render**

In `src/services/render.service.ts`, add the imports:

```typescript
import { buildTransitionArgs, planRender } from "@/lib/ffmpeg-command";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { musicService } from "@/services/music.service";
```

Add `title: true` to the `prisma.video.findFirst` select — it is the music
search query. Then replace the segment/assemble block:

```typescript
      const style = DEFAULT_STYLE;
      const clipPaths = ensureCoverage(downloadedClipPaths, durationSeconds);
      const outputPath = path.join(tempDir, "video.mp4");

      const plan = planRender(clipPaths, tempDir, CLIP_SECONDS, style.transitions);

      for (const [index, segment] of plan.segments.entries()) {
        onProgress(`normalising clip ${index + 1} of ${plan.segments.length}`);

        await this.runFfmpeg(
          buildSegmentArgs({ ...segment, motion: style.motion }),
          job.id,
          null,
          () => {},
          shouldCancel,
        );
      }

      // A stub that fails to build becomes a hard cut. Half a second of
      // dissolve is never worth failing a finished render for — but a
      // cancellation arrives through the same rejection, and swallowing that
      // would keep encoding after the operator asked to stop.
      const stubPathByIndex = new Map<number, string>();
      for (const [index, transition] of plan.transitions.entries()) {
        onProgress(`building transition ${index + 1} of ${plan.transitions.length}`);

        try {
          await this.runFfmpeg(
            buildTransitionArgs(transition),
            job.id,
            null,
            () => {},
            shouldCancel,
          );
          stubPathByIndex.set(index, transition.outputPath);
        } catch (error) {
          if (shouldCancel?.()) {
            throw error;
          }
          onProgress(`transition ${index + 1} could not be built; using a hard cut`);
        }
      }

      const concatEntries: string[] = [];
      plan.playOrder.forEach((segmentPath, index) => {
        const stubPath = stubPathByIndex.get(index);
        // A dropped stub means nothing covers this boundary, so the segment
        // must keep the tail it would otherwise have donated.
        const trim = stubPath ? plan.trims[index] : { ...plan.trims[index], outpoint: undefined };
        concatEntries.push(concatListLine(segmentPath, trim));
        if (stubPath) {
          concatEntries.push(concatListLine(stubPath));
        }
      });

      const concatListPath = path.join(tempDir, "segments.txt");
      await writeFile(concatListPath, `${concatEntries.join("\n")}\n`);

      // Music is fetched, never generated, and a video that has none simply
      // renders without it — see MusicService.collect's doc comment.
      let musicPath: string | undefined;
      const musicStoragePath = await musicService.collect(videoId, video.title);
      if (musicStoragePath) {
        musicPath = path.join(tempDir, "music.mp3");
        await writeFile(musicPath, await getObject(musicStoragePath));
      }

      onProgress(
        `assembling ${plan.playOrder.length} segment(s) with narration, ` +
          `captions${musicPath ? " and music" : ""}`,
      );

      await this.runFfmpeg(
        buildAssembleArgs({
          concatListPath,
          audioPath,
          srtPath,
          outputPath,
          durationSeconds,
          musicPath,
          audio: style.audio,
          captions: style.captions,
        }),
        job.id,
        durationSeconds,
        onProgress,
        shouldCancel,
      );
```

Using the video's title as the music query is a first approximation — it is
the same signal footage collection started from. A mood field on `VideoStyle`
would be better and is the natural follow-on once real videos have been
scored.

- [ ] **Step 6: Run the full suite**

Run: `pnpm verify`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/storage.ts src/services/music.service.ts src/services/music.service.test.ts src/services/render.service.ts src/services/render.service.test.ts
git commit -m "feat: score each video with a ducked music bed"
```

---

### Task 8: The sound effects track

**Files:**
- Create: `src/lib/sfx-track.ts`
- Create: `src/lib/sfx-track.test.ts`
- Modify: `src/services/render.service.ts`
- Add: SFX pack files under `public/sfx/` (`whoosh-1.mp3`, `whoosh-2.mp3`,
  `whoosh-3.mp3`, `stinger.mp3`, `swell.mp3`)

**Interfaces:**
- Consumes: `plan.transitions` (Task 5) for boundary times.
- Produces: `buildSfxTrackArgs({ cues, durationSeconds, outputPath }): string[]`
  where `cues: { path: string; atSeconds: number }[]`, and
  `planSfxCues(boundarySeconds: number[], durationSeconds: number): SfxCue[]`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("planSfxCues", () => {
  it("never repeats a sound on adjacent boundaries", () => {
    const cues = planSfxCues([8, 16, 24, 32], 60);
    const whooshes = cues.filter((cue) => cue.path.includes("whoosh"));

    for (let i = 1; i < whooshes.length; i += 1) {
      expect(whooshes[i].path).not.toBe(whooshes[i - 1].path);
    }
  });

  it("opens with a stinger and closes with a swell", () => {
    const cues = planSfxCues([8], 60);

    expect(cues[0].atSeconds).toBe(0);
    expect(cues[0].path).toContain("stinger");
    expect(cues.at(-1)?.path).toContain("swell");
  });

  it("is deterministic for the same input", () => {
    expect(planSfxCues([8, 16], 60)).toEqual(planSfxCues([8, 16], 60));
  });
});

describe("buildSfxTrackArgs", () => {
  it("delays each effect to its cue and mixes them into one track", () => {
    const args = buildSfxTrackArgs({
      cues: [
        { path: "/tmp/a.mp3", atSeconds: 0 },
        { path: "/tmp/b.mp3", atSeconds: 8 },
      ],
      durationSeconds: 60,
      outputPath: "/tmp/sfx.m4a",
    });

    const graph = args[args.indexOf("-filter_complex") + 1];
    // adelay is in milliseconds.
    expect(graph).toContain("adelay=8000");
    expect(graph).toContain("amix=inputs=2");
    expect(graph).toContain("normalize=0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sfx-track.test.ts`
Expected: FAIL — cannot resolve `@/lib/sfx-track`

- [ ] **Step 3: Write the implementation**

Create `src/lib/sfx-track.ts`:

```typescript
import path from "node:path";

/**
 * The effects are mixed into one full-length track here rather than passed to
 * the assemble pass as separate inputs. Fifty boundaries would otherwise mean
 * fifty extra inputs to pass two — audio decoders are far cheaper than video
 * ones, but adding pressure to this particular worker without needing to is
 * how the original OOM happened.
 */

export interface SfxCue {
  path: string;
  atSeconds: number;
}

export interface SfxTrackInput {
  cues: SfxCue[];
  durationSeconds: number;
  outputPath: string;
}

/** Three whooshes is enough that rotation never repeats on adjacent cuts. */
const WHOOSHES = ["whoosh-1.mp3", "whoosh-2.mp3", "whoosh-3.mp3"];
const STINGER = "stinger.mp3";
const SWELL = "swell.mp3";

/** How long before the end the closing swell starts. */
const SWELL_LEAD_SECONDS = 3;

/** Bundled, not fetched — a sound reused across a thousand videos is a licence
 *  settled once. See public/sfx/README.md for provenance. */
export function sfxPackDir(): string {
  return path.join(process.cwd(), "public", "sfx");
}

export function planSfxCues(boundarySeconds: number[], durationSeconds: number): SfxCue[] {
  const dir = sfxPackDir();

  const cues: SfxCue[] = [{ path: path.join(dir, STINGER), atSeconds: 0 }];

  // Selection is by index, never random: the same video re-rendered must
  // produce the same track.
  boundarySeconds.forEach((atSeconds, index) => {
    cues.push({ path: path.join(dir, WHOOSHES[index % WHOOSHES.length]), atSeconds });
  });

  cues.push({
    path: path.join(dir, SWELL),
    atSeconds: Math.max(0, durationSeconds - SWELL_LEAD_SECONDS),
  });

  return cues;
}

export function buildSfxTrackArgs(input: SfxTrackInput): string[] {
  const args = ["-y"];

  for (const cue of input.cues) {
    args.push("-i", cue.path);
  }

  // adelay takes milliseconds; `all=1` applies the delay to every channel
  // rather than only the first, which would otherwise skew a stereo effect.
  const delays = input.cues
    .map((cue, index) => `[${index}:a]adelay=${Math.round(cue.atSeconds * 1000)}:all=1[d${index}]`)
    .join(";");
  const labels = input.cues.map((_cue, index) => `[d${index}]`).join("");

  args.push(
    "-filter_complex",
    `${delays};${labels}amix=inputs=${input.cues.length}:normalize=0[aout]`,
    "-map", "[aout]",
    "-t", String(Math.round(input.durationSeconds)),
    "-c:a", "aac",
    "-b:a", "128k",
    input.outputPath,
  );

  return args;
}
```

- [ ] **Step 4: Add the pack**

Place five short royalty-free files under `public/sfx/`. Record their source
and licence in a `public/sfx/README.md` — the licence is settled once, here,
rather than per render.

- [ ] **Step 5: Wire the render**

In `render.service.ts`, after the concat list is written and before the
assemble pass:

```typescript
      // Where each surviving stub lands on the finished timeline — the sum of
      // everything played before it, stubs included.
      const boundarySeconds: number[] = [];
      let elapsedSeconds = 0;
      plan.playOrder.forEach((_segmentPath, index) => {
        elapsedSeconds += plan.trimmedSeconds[index];
        if (stubPathByIndex.has(index)) {
          boundarySeconds.push(elapsedSeconds);
          elapsedSeconds += style.transitions.durationSeconds;
        }
      });

      let sfxPath: string | undefined;
      try {
        const candidate = path.join(tempDir, "sfx.m4a");
        await this.runFfmpeg(
          buildSfxTrackArgs({
            cues: planSfxCues(boundarySeconds, durationSeconds),
            durationSeconds,
            outputPath: candidate,
          }),
          job.id,
          null,
          () => {},
          shouldCancel,
        );
        sfxPath = candidate;
      } catch (error) {
        // Same rule as a failed stub: an enhancement never fails a render, but
        // a cancellation must still propagate.
        if (shouldCancel?.()) {
          throw error;
        }
        onProgress("sound effects could not be built; continuing without them");
      }
```

Then add `sfxPath` to the `buildAssembleArgs` call.

- [ ] **Step 6: Run the full suite**

Run: `pnpm verify`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/sfx-track.ts src/lib/sfx-track.test.ts public/sfx src/services/render.service.ts
git commit -m "feat: put a sound behind every cut"
```

---

### Task 9: Music attribution in the description

**Files:**
- Modify: `src/services/publish.service.ts` (`buildDescription`)
- Test: `src/services/publish.service.test.ts`

**Interfaces:**
- Consumes: the `MUSIC` asset written by Task 7.
- Produces: `buildDescription(scriptContent, musicCredit?: string): string`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("buildDescription", () => {
  it("credits the music alongside the Pixabay credit", () => {
    const description = buildDescription("SOURCES\n- one", 'Music: "Test" by Artist (CC BY 3.0)');

    expect(description).toContain("Pixabay");
    expect(description).toContain('Music: "Test" by Artist');
  });

  it("omits the music line when a video has no music", () => {
    expect(buildDescription("SOURCES\n- one")).not.toContain("Music:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/publish.service.test.ts -t "credits the music"`
Expected: FAIL — `buildDescription` takes one argument

- [ ] **Step 3: Write the implementation**

`buildDescription` is currently module-private — export it, the way
`extractSourcesSection` beside it already is, so the test can reach it:

```typescript
export function buildDescription(
  scriptContent: string | null | undefined,
  /** Written by MusicService at collection time. Absent when the video
   *  rendered without music. */
  musicCredit?: string | null,
): string {
  const sources = scriptContent ? extractSourcesSection(scriptContent) : "";
  return [sources, PIXABAY_CREDIT, musicCredit].filter(Boolean).join("\n\n");
}
```

In `publish()`, load the video's `MUSIC` asset by storage prefix — the same
scoping key `render.service.ts` already queries by — and pass its stored credit:

```typescript
    // Unconditional, like PIXABAY_CREDIT above it: the credit is derived from
    // what the render actually used, not from the operator remembering.
    const musicAsset = await prisma.asset.findFirst({
      where: {
        kind: "MUSIC",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { prompt: true },
    });

    const description = buildDescription(
      video.script?.activeVersion?.content,
      musicAsset?.prompt,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/publish.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/publish.service.ts src/services/publish.service.test.ts
git commit -m "feat: credit the music the video actually used"
```

---

### Task 10: Voice settings and pronunciation

**Files:**
- Modify: `prisma/schema.prisma` (`Channel`)
- Modify: `src/services/providers/types.ts` (`SpeechSynthesisInput`)
- Modify: `src/services/providers/elevenlabs.provider.ts`
- Create: `src/services/pronunciation.service.ts`
- Modify: `src/services/voiceover.service.ts`
- Test: `src/services/providers/elevenlabs.provider.test.ts`, `src/services/pronunciation.service.test.ts`

**Interfaces:**
- Consumes: `VoiceStyle` from Task 1.
- Produces: `SpeechSynthesisInput` gains `voice?: VoiceStyle` and
  `dictionaryLocators?: { id: string; versionId: string }[]`;
  `pronunciationService.ensureDictionary(userId, channelId, scriptText): Promise<{ id: string; versionId: string } | null>`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("ElevenLabsProvider request body", () => {
  it("sends voice settings and a fixed seed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ElevenLabsProvider().synthesize({
      text: "Hello",
      voiceId: "v1",
      apiKey: "k",
      voice: { stability: 0.5, style: 0.3, speed: 1, seed: 20260811 },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voice_settings.stability).toBe(0.5);
    expect(body.seed).toBe(20260811);
  });

  it("sends dictionary locators and never markup in the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ElevenLabsProvider().synthesize({
      text: "Ada Lovelace",
      voiceId: "v1",
      apiKey: "k",
      dictionaryLocators: [{ id: "d1", versionId: "v1" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The alignment describes this exact string, and captions.ts turns that
    // alignment straight into SRT. Markup here would corrupt the captions.
    expect(body.text).toBe("Ada Lovelace");
    expect(body.pronunciation_dictionary_locators).toHaveLength(1);
  });

  it("omits both when the caller gives neither", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ElevenLabsProvider().synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voice_settings).toBeUndefined();
    expect(body.pronunciation_dictionary_locators).toBeUndefined();
  });
});

describe("PronunciationService", () => {
  it("returns null when the dictionary call fails", async () => {
    // Narration must still be synthesised; a missing dictionary only costs
    // pronunciation quality.
    expect(await serviceWithFailingApi.ensureDictionary(userId, channelId, "text")).toBeNull();
  });

  it("uses alias rules, which every ElevenLabs model honours", async () => {
    const captured = await captureRulesFor("Ada Lovelace wrote for the Analytical Engine.");
    expect(captured.every((rule) => rule.type === "alias")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/providers/elevenlabs.provider.test.ts`
Expected: FAIL — `SpeechSynthesisInput` has no `voice`

- [ ] **Step 3: Extend the schema**

Add to `Channel` in `prisma/schema.prisma`:

```prisma
  /// ElevenLabs pronunciation dictionary for this channel. Entries accumulate
  /// as scripts introduce new proper nouns, so a correction made once never
  /// recurs on this channel.
  pronunciationDictionaryId        String?
  pronunciationDictionaryVersionId String?
```

Then `pnpm db:migrate --name add_channel_pronunciation_dictionary`.

- [ ] **Step 4: Extend the provider**

Add `voice?: VoiceStyle` and `dictionaryLocators?: { id: string; versionId: string }[]`
to `SpeechSynthesisInput`. In `elevenlabs.provider.ts`, include
`voice_settings`, `seed` and `pronunciation_dictionary_locators` in the body
only when supplied, so existing callers send an unchanged request.

- [ ] **Step 5: Write the pronunciation service**

Create `src/services/pronunciation.service.ts`:

```typescript
import "server-only";

import { prisma } from "@/lib/prisma";
import { ELEVENLABS_API_BASE } from "@/services/providers/elevenlabs.provider";

export interface DictionaryLocator {
  id: string;
  versionId: string;
}

interface AliasRule {
  string_to_replace: string;
  type: "alias";
  alias: string;
}

/** Sentence-initial capitals are ordinary words, so only capitalised tokens
 *  that follow another word are candidates. */
const CANDIDATE = /(?<=[a-z,;:]\s)([A-Z][a-zA-Z'’-]{2,})/g;

/**
 * Pronunciation is fixed with a server-side dictionary rather than SSML in the
 * text. `SpeechProvider.synthesize` calls the with-timestamps endpoint and
 * `lib/captions.ts` turns the returned character alignment straight into SRT —
 * markup injected into `text` would land in the very stream that alignment
 * describes, corrupting the captions to fix the audio.
 *
 * Rules are aliases, never phonemes. Phoneme support is model-dependent (Flash
 * v2 takes SSML phonemes, v3 takes IPA, Multilingual v2 supports only aliases)
 * and `ELEVENLABS_MODEL_ID` is environment-configured, so a model change must
 * not be able to silently degrade pronunciation.
 */
export class PronunciationService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Returns the channel's dictionary locator, or `null` when narration should
   * be synthesised without one. Never throws: a missing dictionary costs
   * pronunciation quality, and that must not block a video.
   */
  async ensureDictionary(
    apiKey: string,
    channelId: string,
    scriptText: string,
    proposeAliases: (terms: string[]) => Promise<AliasRule[]>,
  ): Promise<DictionaryLocator | null> {
    try {
      const channel = await prisma.channel.findFirst({
        where: { id: channelId, deletedAt: null },
        select: {
          pronunciationDictionaryId: true,
          pronunciationDictionaryVersionId: true,
        },
      });

      if (!channel) {
        return null;
      }

      const terms = [...new Set(scriptText.match(CANDIDATE) ?? [])];
      const rules = terms.length > 0 ? await proposeAliases(terms) : [];

      // Nothing new to teach it — reuse whatever the channel already has.
      if (rules.length === 0) {
        return channel.pronunciationDictionaryId && channel.pronunciationDictionaryVersionId
          ? {
              id: channel.pronunciationDictionaryId,
              versionId: channel.pronunciationDictionaryVersionId,
            }
          : null;
      }

      const locator = channel.pronunciationDictionaryId
        ? await this.addRules(apiKey, channel.pronunciationDictionaryId, rules)
        : await this.createDictionary(apiKey, channelId, rules);

      if (!locator) {
        return null;
      }

      await prisma.channel.update({
        where: { id: channelId },
        data: {
          pronunciationDictionaryId: locator.id,
          pronunciationDictionaryVersionId: locator.versionId,
        },
      });

      return locator;
    } catch {
      return null;
    }
  }

  private async createDictionary(
    apiKey: string,
    channelId: string,
    rules: AliasRule[],
  ): Promise<DictionaryLocator | null> {
    const response = await this.fetchImpl(
      `${ELEVENLABS_API_BASE}/pronunciation-dictionaries/add-from-rules`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `framecast-${channelId}`, rules }),
      },
    );

    return this.readLocator(response);
  }

  private async addRules(
    apiKey: string,
    dictionaryId: string,
    rules: AliasRule[],
  ): Promise<DictionaryLocator | null> {
    const response = await this.fetchImpl(
      `${ELEVENLABS_API_BASE}/pronunciation-dictionaries/${dictionaryId}/add-rules`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      },
    );

    return this.readLocator(response, dictionaryId);
  }

  private async readLocator(
    response: Response,
    knownId?: string,
  ): Promise<DictionaryLocator | null> {
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { id?: string; version_id?: string };
    const id = body.id ?? knownId;

    return id && body.version_id ? { id, versionId: body.version_id } : null;
  }
}

export const pronunciationService = new PronunciationService();
```

`proposeAliases` is injected rather than called directly so the LLM round trip
is substitutable in tests. `voiceover.service.ts` supplies the real one below.

Rules are aliases, never phonemes. `ELEVENLABS_MODEL_ID` is environment-
configured and can change without touching this code; phoneme support is
model-dependent (Flash v2 takes SSML phonemes, v3 takes IPA, Multilingual v2
supports only aliases), while alias replacement works everywhere. A model
change therefore cannot silently degrade pronunciation.

- [ ] **Step 6: Wire the voiceover service**

In `voiceover.service.ts`, add `project: { select: { channelId: true } }` to the
video select, then before the `synthesize` call:

```typescript
      // A null locator is not an error — it means this narration is
      // synthesised without pronunciation help, which is exactly what happens
      // today. Nothing here may prevent the narration being generated.
      const channelId = video.project?.channelId;
      const locator = channelId
        ? await pronunciationService.ensureDictionary(
            apiKey,
            channelId,
            content,
            (terms) => proposeAliases(terms, userId),
          )
        : null;
```

And extend the call itself:

```typescript
      const synthesized = await this.provider.synthesize({
        text: content,
        voiceId,
        apiKey,
        voice: DEFAULT_STYLE.voice,
        dictionaryLocators: locator ? [{ id: locator.id, versionId: locator.versionId }] : undefined,
      });
```

`proposeAliases` asks the existing text provider for a respelling of each term
and parses its JSON reply, returning `[]` on anything unexpected:

```typescript
/** Aliases only — see PronunciationService's doc comment for why phonemes are
 *  deliberately not used. */
async function proposeAliases(
  terms: string[],
  userId: string,
): Promise<{ string_to_replace: string; type: "alias"; alias: string }[]> {
  const result = await gatewayProvider.generateScript({
    prompt:
      "For each term, give a plain-English respelling that a text-to-speech " +
      "engine will pronounce correctly. Reply with JSON only: " +
      `[{"term":"...","respelling":"..."}]. Terms: ${terms.join(", ")}`,
    apiKey: (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ?? undefined,
  });

  try {
    const parsed = JSON.parse(result.content) as { term?: string; respelling?: string }[];
    return parsed
      .filter((entry) => entry.term && entry.respelling && entry.term !== entry.respelling)
      .map((entry) => ({
        string_to_replace: entry.term!,
        type: "alias" as const,
        alias: entry.respelling!,
      }));
  } catch {
    // A model that answered with prose instead of JSON costs pronunciation
    // quality, never the narration itself.
    return [];
  }
}
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm verify`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add prisma src/services/providers src/services/pronunciation.service.ts src/services/pronunciation.service.test.ts src/services/voiceover.service.ts
git commit -m "feat: say proper nouns correctly and pace the voice"
```

---

## Verification

After Task 10, render one real video end to end and confirm by watching it:

- Each clip moves; adjacent clips move in different directions.
- Cuts dissolve rather than jump, with a sound on each.
- Narration sits at a consistent level with music audibly ducking beneath it.
- Captions are in the chosen face, not Arial.
- The video's length matches the narration, with no drift at the end.
- The description credits both Pixabay and the music track.

Run `pnpm verify` and confirm the render worker's container still completes a
full-length render without being OOM-killed — that is the constraint every
decision in this plan was shaped by.
