import { ValidationError } from "@/lib/errors";
import type {
  AudioStyle,
  CaptionStyle,
  MotionStyle,
  TransitionStyle,
} from "@/lib/video-style";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DEFAULT_CLIP_SECONDS = 12;

/**
 * Rendering happens in two passes, and the reason is memory.
 *
 * The single-pass version opened every clip at once and joined them with the
 * `concat` filter, which is what a filter graph is for — but a filter graph
 * holds all of its inputs open simultaneously. On the worker's 1GB container
 * that was fatal: thirty-eight live h264 decoders, several of them 1440p, and
 * the kernel killed FFmpeg before it emitted a frame.
 *
 * Opening each distinct file once and `split`ting it for the repeats cut the
 * decoders to twelve and still died. `split` requires its outputs to be
 * consumed roughly in step, and `concat` does the opposite — it finishes
 * segment one before it touches segment thirteen, so every frame in between
 * has to be buffered. Fewer decoders, unbounded buffering, same result.
 *
 * So neither pass uses a filter graph to join anything:
 *
 *   1. `buildSegmentArgs` normalises ONE clip into a standalone segment file.
 *      One decoder, one encoder, nothing else held open.
 *   2. `buildAssembleArgs` joins those segments with the concat *demuxer*,
 *      which reads files strictly in sequence — one decoder at a time,
 *      whatever the video's length — then burns in captions and muxes the
 *      narration.
 *
 * Memory is now flat in the number of clips and in the video's duration. The
 * cost is that the picture is encoded twice; pass one runs at a much finer CRF
 * than the final so that what the second pass sees is visually the source.
 */

/** Segment quality. Well above the final CRF because these frames get encoded
 *  a second time and generational loss compounds — this is the generation to
 *  spend bytes on. They are temp files, deleted with the render directory. */
const SEGMENT_CRF = "18";
const FINAL_CRF = "22";

/** The container has 2 vCPU. Unbounded, x264 and the filter threads size their
 *  pools to the host's core count, which on a 15-core machine meant buffer
 *  pools far past what this container allows. */
const THREADS = "2";

/**
 * FFmpeg's filter graph parser treats `:` and `'` as syntax, so a path inside
 * `subtitles=` has to be escaped even though the shell never sees it — args are
 * passed to spawn as an array.
 */
function escapeForFilter(path: string): string {
  return path.replace(/([\\:'[\],; ])/g, "\\$1");
}

export interface SegmentTrim {
  inpoint?: number;
  outpoint?: number;
}

/**
 * A concat-demuxer list entry. That parser treats `'` as a delimiter and its
 * escape is closing, escaping, reopening the quote — a backslash inside the
 * quotes would be read literally.
 */
export function concatListLine(segmentPath: string, trim?: SegmentTrim): string {
  const lines = [`file '${segmentPath.replace(/'/g, "'\\''")}'`];

  // The demuxer plays whole files unless told otherwise, and these directives
  // apply to the `file` line above them. They are the only way to drop the
  // overlap a transition stub already covers.
  if (trim?.inpoint !== undefined) {
    lines.push(`inpoint ${trim.inpoint}`);
  }
  if (trim?.outpoint !== undefined) {
    lines.push(`outpoint ${trim.outpoint}`);
  }

  return lines.join("\n");
}

export interface SegmentInput {
  clipPath: string;
  outputPath: string;
  /** How long a slot this clip fills. Short clips loop to fill it. */
  clipSeconds?: number;
  /** Position in the play order. Selects the pan direction, so an unchanged
   *  video re-rendered produces identical arguments. */
  index?: number;
  motion?: MotionStyle;
}

/**
 * Four directions, cycled by segment index.
 *
 * These are pans, not zooms. A `crop` filter's output size must be constant, so
 * an animated crop can translate its window but cannot resize it — zoom needs
 * `zoompan`, which computes per-frame scaling against integer pixel positions
 * and judders visibly unless the input is pre-upscaled far past the output.
 * That is memory this worker does not have (see the two-pass rationale above).
 *
 * `T` is substituted with `t/<seconds>`, which runs 0 to 1 across the segment,
 * so each expression traverses exactly the margin the upscale created.
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
    `x='${pan.x.replaceAll("T", progress)}':` +
    `y='${pan.y.replaceAll("T", progress)}',` +
    `setsar=1`
  );
}

/**
 * Pass one: one clip in, one normalised segment out.
 *
 * Every segment leaves here at the same resolution, frame rate, pixel format
 * and timebase, because the concat demuxer in pass two joins streams without
 * re-encoding and cannot reconcile inputs that disagree.
 *
 * The input-level `-t` is load-bearing rather than a convenience:
 * `-stream_loop -1` alone makes the input infinite, and FFmpeg will decode an
 * unbounded stream until something stops it.
 */
export function buildSegmentArgs(input: SegmentInput): string[] {
  const clipSeconds = input.clipSeconds ?? DEFAULT_CLIP_SECONDS;

  return [
    "-y",
    "-stream_loop", "-1",
    "-t", String(clipSeconds),
    "-i", input.clipPath,
    // A stock clip's own audio is never used — the narration is the only
    // sound. Dropping it keeps the segments smaller and spares pass two a
    // stream it would only have to ignore.
    "-an",
    "-vf",
    buildVideoFilter(input, clipSeconds),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", SEGMENT_CRF,
    "-pix_fmt", "yuv420p",
    "-threads", THREADS,
    input.outputPath,
  ];
}

/**
 * libass reads `force_style` as comma-separated `Key=Value` pairs. Built here
 * rather than by the caller so the filter-graph escaping rules stay in the one
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

export interface AssembleInput {
  /** A concat-demuxer list naming the segments in playing order. The same
   *  segment may appear repeatedly; the demuxer reopens it each time rather
   *  than holding one copy open for the whole run. */
  concatListPath: string;
  audioPath: string;
  srtPath: string;
  outputPath: string;
  /** Cut the result to exactly this, so video and narration cannot drift. */
  durationSeconds: number;
  captions?: CaptionStyle;
  musicPath?: string;
  sfxPath?: string;
  audio?: AudioStyle;
}

/** YouTube normalises playback to about this, so it is a platform fact rather
 *  than a style choice — see video-style.ts's doc comment. */
const LOUDNESS_TARGET = "loudnorm=I=-14:TP=-1.5:LRA=11";

interface AudioChain {
  /** Extra input arguments, in the order they must precede the filters. */
  inputArgs: string[];
  /** Filter graph fragments, joined with `;` by the caller. */
  filters: string[];
  /** What `-map` should reference for audio. */
  audioMap: string;
}

/**
 * The audio half of pass two.
 *
 * Input indices are positional and fixed: 0 is the concat list, 1 the
 * narration, then music, then the SFX track. Anything absent shifts everything
 * after it down, which is why the index is tracked rather than assumed.
 *
 * Audio filters cost almost nothing in memory, so none of this threatens the
 * budget that shaped the two-pass design above.
 */
function buildAudioChain(input: AssembleInput): AudioChain {
  const audio = input.audio;

  // No style and nothing to mix: keep the original passthrough exactly.
  if (!audio) {
    return { inputArgs: [], filters: [], audioMap: "1:a" };
  }

  const inputArgs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];
  let nextIndex = 2;

  // The narration is needed twice when music is present — once in the mix and
  // once as the key the ducking listens to.
  filters.push(
    input.musicPath
      ? `[1:a]${LOUDNESS_TARGET},asplit=2[narr][key]`
      : `[1:a]${LOUDNESS_TARGET}[narr]`,
  );
  mixLabels.push("[narr]");

  if (input.musicPath) {
    // `-stream_loop -1` makes this input infinite, so the output `-t` below
    // stops being a drift guard and becomes what terminates the render.
    // `-shortest` cannot be relied on against an endless input.
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

  // `normalize=0` is load-bearing: amix's default divides by input count,
  // halving levels and silently undoing the loudnorm above.
  filters.push(
    mixLabels.length === 1
      ? `[narr]alimiter=limit=0.95[aout]`
      : `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0,` +
          `alimiter=limit=0.95[aout]`,
  );

  return { inputArgs, filters, audioMap: "[aout]" };
}

/**
 * Pass two: segments in, finished video out.
 *
 * The picture side runs one filter, `subtitles`, which needs a re-encode —
 * there is no way to burn text into a picture without one. Everything
 * expensive that used to live in the graph is gone. The audio side mixes at
 * most three streams; see `buildAudioChain`.
 */
export function buildAssembleArgs(input: AssembleInput): string[] {
  const chain = buildAudioChain(input);
  const videoFilter = `[0:v]${buildSubtitleFilter(input.srtPath, input.captions)}[vout]`;

  return [
    "-y",
    // `-safe 0` because the list holds absolute paths, which the demuxer
    // rejects by default.
    "-f", "concat",
    "-safe", "0",
    "-i", input.concatListPath,
    "-i", input.audioPath,
    ...chain.inputArgs,
    "-filter_complex", [videoFilter, ...chain.filters].join(";"),
    "-filter_threads", THREADS,
    "-filter_complex_threads", THREADS,
    "-map", "[vout]",
    "-map", chain.audioMap,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-threads", THREADS,
    "-crf", FINAL_CRF,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-t", String(Math.round(input.durationSeconds)),
    // Machine-readable progress on stdout so the runner can report a real
    // percentage instead of a decorative one.
    "-progress", "pipe:1",
    "-nostats",
    input.outputPath,
  ];
}

export interface TransitionJob {
  fromPath: string;
  toPath: string;
  outputPath: string;
  durationSeconds: number;
  /** Offset into `fromPath` where the crossfade begins. */
  startSeconds: number;
}

export interface RenderPlan {
  /** One entry per distinct clip — pass one runs these in turn. */
  segments: SegmentInput[];
  /** Segment output paths in playing order, repeats included. */
  playOrder: string[];
  /** One per adjacent pair. Empty when transitions are off or there is only
   *  one entry to play. */
  transitions: TransitionJob[];
  /** Index-aligned with `playOrder`. What the concat demuxer must skip at each
   *  end because a stub already covers it. */
  trims: SegmentTrim[];
  /** Index-aligned with `playOrder`. What survives after the stubs take their
   *  share — the numbers that must sum, with the stubs, to the narration. */
  trimmedSeconds: number[];
}

/**
 * A crossfade between two adjacent segments, as a standalone file.
 *
 * `xfade` holds both inputs open, which is exactly the shape that OOM-killed
 * the worker at thirty-eight clips — but two decoders for half a second is
 * affordable, and pass two then reads stub and segment alike, one file at a
 * time. Applying `xfade` across the whole timeline would reintroduce a failure
 * mode already paid for once.
 */
export function buildTransitionArgs(job: TransitionJob): string[] {
  return [
    "-y",
    // Before `-i`, so this seeks the input rather than decoding from zero and
    // discarding everything up to the crossfade.
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

/**
 * Works out what pass one must produce, and in what order pass two plays it.
 *
 * `clipPaths` is a sequence, not a set: RenderService repeats the collected
 * clips until they cover the narration, so a 7-minute video with twelve clips
 * asks for the same twelve three times over. Each distinct file is normalised
 * once; the repeats are extra lines in the concat list, costing a file open
 * rather than a decode.
 */
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
  const overlap = transitions?.enabled ? transitions.durationSeconds : 0;
  const hasStubs = overlap > 0 && count > 1;

  const segmentPathOf = new Map<string, string>();
  const segments: SegmentInput[] = [];
  const sourceSecondsOf: number[] = [];

  clipPaths.forEach((clipPath, index) => {
    // Every segment but the last donates its tail to an outgoing stub, so it
    // must be generated that much longer. Without this the timeline comes out
    // `overlap` short per boundary and the picture drifts off the narration.
    const sourceSeconds = hasStubs && index < count - 1 ? clipSeconds + overlap : clipSeconds;
    sourceSecondsOf.push(sourceSeconds);

    // Keyed on both path and length, not path alone: a clip used mid-timeline
    // and again as the last entry needs two different source lengths, and
    // reusing the shorter one would silently truncate the longer slot.
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
      inpoint: dropsHead ? overlap : undefined,
      outpoint: dropsTail ? source - overlap : undefined,
    });
    trimmedSeconds.push(source - (dropsHead ? overlap : 0) - (dropsTail ? overlap : 0));

    if (dropsTail) {
      jobs.push({
        fromPath: segmentPath,
        toPath: playOrder[index + 1],
        outputPath: `${segmentDir}/stub-${index}.mp4`,
        durationSeconds: overlap,
        startSeconds: source - overlap,
      });
    }
  });

  return { segments, playOrder, transitions: jobs, trims, trimmedSeconds };
}
