import type { VideoFormat } from "@/generated/prisma/enums";
import { ValidationError } from "@/lib/errors";
import type {
  AudioStyle,
  CaptionStyle,
  MotionStyle,
  TransitionStyle,
} from "@/lib/video-style";

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * The pixels each format is composed at, and the only place in this codebase
 * that decides them.
 *
 * `VERTICAL` used to be two private constants further down this file, used
 * exclusively to crop a 9:16 clip out of a finished 16:9 render. It is a
 * first-class output now: a vertical video's clips are normalised straight
 * into this frame in pass one, so the picture is composed at 1080x1920 rather
 * than being the centre 608 columns of a landscape frame upscaled 1.78x.
 */
export const FRAME_SIZES: Record<VideoFormat, FrameSize> = {
  LANDSCAPE: { width: 1920, height: 1080 },
  VERTICAL: { width: 1080, height: 1920 },
};

/** The frame `format` is composed at. `undefined` means landscape, which is
 *  what every caller written before formats existed passes — so their argv is
 *  byte-for-byte what it was. */
export function frameSize(format?: VideoFormat): FrameSize {
  return FRAME_SIZES[format ?? "LANDSCAPE"];
}

const FPS = 30;

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

/** Decoding, not encoding, and deliberately lower. This is the pool that was
 *  unbounded — see the comment at its use site in `buildSegmentArgs`. One
 *  thread is enough for a single clip and removes the frame-buffer pool
 *  entirely as a memory variable, whatever resolution the clip arrives at. */
const DECODER_THREADS = "1";

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
  /** How long a slot this clip fills — one script section's worth of
   *  narration, so the picture cuts where the sentence does. Short clips loop
   *  to fill it.
   *
   *  Required, and it used to default to a flat twelve seconds. That default
   *  is what the per-section timing model replaced: `planRender` demands a
   *  duration per clip and is the only thing that constructs a SegmentInput,
   *  so nothing could reach the fallback any more — and a silent twelve
   *  seconds is the worst possible value to fall back to, since a slot of the
   *  wrong length does not look wrong, it looks like a finished video whose
   *  picture runs ahead of its words. */
  clipSeconds: number;
  /** Position in the play order. Selects the pan direction, so an unchanged
   *  video re-rendered produces identical arguments. */
  index?: number;
  motion?: MotionStyle;
  /** What frame this clip is normalised into. Optional, and absent means
   *  landscape: `planRender` does not set it, so the segment argv for every
   *  video that existed before formats did is unchanged. RenderService spreads
   *  the video's own format in at the call site, beside `motion`. */
  format?: VideoFormat;
  /** True when `clipPath` is a single picture rather than a video.
   *
   *  One argument's difference, and it is not optional: `-stream_loop -1`
   *  asks the demuxer to rewind a stream, and a PNG has no stream to rewind —
   *  FFmpeg reads its one frame, hits EOF and produces a segment a single
   *  frame long, whatever `-t` says. `-loop 1` is the image2 demuxer's own
   *  equivalent and is what makes a still fill a twenty-second slot.
   *
   *  Set by `planRender` from the path's extension rather than passed down
   *  from the caller, so nothing between here and RenderService has to carry
   *  the fact around and get it wrong. Absent/false emits exactly the argv
   *  every stock-footage render has always produced. */
  still?: boolean;
}

/** Extensions FFmpeg reads through the image2 demuxer, and therefore the paths
 *  that need `-loop 1`.
 *
 *  A closed list rather than "not .mp4": a path this does not recognise is
 *  treated as video, which is what every clip in every render before
 *  illustrated footage existed actually is. Getting it wrong in that direction
 *  costs nothing; getting it wrong the other way would silently turn a stock
 *  clip into a one-frame segment. */
const STILL_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export function isStillImagePath(clipPath: string): boolean {
  const lower = clipPath.toLowerCase();
  return STILL_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
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
  // `force_original_aspect_ratio=increase` then `crop` covers the frame and
  // keeps its centre, whichever way round the frame is: a 16:9 stock clip
  // normalised into a vertical frame is scaled until it is 1920 tall (3413
  // wide) and the middle 1080 columns are kept. That is a real centre crop of
  // the SOURCE, which is what "composed natively at 9:16" means — as opposed
  // to cropping a finished landscape render, which crops a picture that was
  // already framed for a different shape and then upscales what is left.
  const { width, height } = frameSize(input.format);

  if (!motion?.enabled) {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},fps=${FPS},setsar=1`
    );
  }

  const scaledWidth = Math.round(width * motion.scale);
  const scaledHeight = Math.round(height * motion.scale);
  const pan = PAN_EXPRESSIONS[(input.index ?? 0) % PAN_EXPRESSIONS.length];
  const progress = `t/${clipSeconds}`;

  return (
    `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,` +
    `crop=${scaledWidth}:${scaledHeight},fps=${FPS},` +
    `crop=w=${width}:h=${height}:` +
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
  const clipSeconds = input.clipSeconds;

  return [
    "-y",
    // An INPUT-side thread limit, and the position matters. `-threads` below
    // sits after `-i`, so it only ever capped the encoder — the h264 decoder
    // was left to size its own pool from the host's core count. Frame-threaded
    // h264 holds roughly a frame buffer per thread: ~3MB each at 1080p, ~12MB
    // at 4K. On a many-core host that is hundreds of megabytes of decoder
    // buffers inside a 1GB container, which is what SIGKILLed a render on a
    // 3840x2160 clip at frame 19, before it produced a single output byte.
    "-threads", DECODER_THREADS,
    // A still and a clip fill their slot by different mechanisms — see
    // `SegmentInput.still`. `-framerate` accompanies `-loop 1` because the
    // image2 demuxer otherwise emits at its own 25fps default and the `fps=30`
    // filter downstream would be interpolating 500 identical frames up to 600
    // for no reason; asking the demuxer for 30 in the first place is the same
    // picture for less work. Spread from an array so a video clip's argv is
    // byte-for-byte the two tokens it has always been.
    ...(input.still
      ? ["-loop", "1", "-framerate", String(FPS)]
      : ["-stream_loop", "-1"]),
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
 * A caption style that also pins a horizontal safe area.
 *
 * Both fields are OPTIONAL, and that is what keeps this shared with the
 * landscape render without changing it: `verticalCaptionStyle` is the only
 * thing in the codebase that sets them, so a landscape style leaves them
 * undefined, the two `MarginL`/`MarginR` pairs are never emitted, and the
 * `force_style` string a landscape render produces is byte-for-byte what it
 * was. See `verticalCaptionStyle` for why a short needs them and a 1920px-wide
 * frame with no overlay UI on it does not.
 */
export interface SafeAreaCaptionStyle extends CaptionStyle {
  marginL?: number;
  marginR?: number;
}

/**
 * libass reads `force_style` as comma-separated `Key=Value` pairs. Built here
 * rather than by the caller so the filter-graph escaping rules stay in the one
 * file that already knows them.
 */
function buildForceStyle(style: SafeAreaCaptionStyle): string {
  const pairs = [
    `FontName=${style.fontName}`,
    `FontSize=${style.fontSize}`,
    `PrimaryColour=${style.primaryColour}`,
    `OutlineColour=${style.outlineColour}`,
    `Outline=${style.outline}`,
    `Shadow=${style.shadow}`,
    `MarginV=${style.marginV}`,
  ];

  // Appended rather than interleaved so that a style without them produces the
  // exact string this function has always produced. libass reads the pairs as a
  // set, so the order is ours to choose.
  if (style.marginL !== undefined) {
    pairs.push(`MarginL=${style.marginL}`);
  }
  if (style.marginR !== undefined) {
    pairs.push(`MarginR=${style.marginR}`);
  }

  return pairs.join(",");
}

export function buildSubtitleFilter(srtPath: string, captions?: SafeAreaCaptionStyle): string {
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
  /** Where in `audioPath` this composition starts, in seconds.
   *
   *  Absent for a whole video — the narration is the timeline. Set only when
   *  composing a WINDOW of one: a short is a run of sections out of the middle
   *  of a narration, and the words it is cut to start partway through the same
   *  MP3 the full render reads from beginning to end. Emitted as an input-side
   *  `-ss` before `-i`, so FFmpeg seeks the file rather than decoding and
   *  discarding everything before the window; absent it emits nothing at all,
   *  which is what keeps a full render's argv unchanged. */
  audioStartSeconds?: number;
  srtPath: string;
  outputPath: string;
  /** Cut the result to exactly this, so video and narration cannot drift. */
  durationSeconds: number;
  /** `SafeAreaCaptionStyle`, not `CaptionStyle`, because a vertical
   *  composition needs the horizontal safe area `verticalCaptionStyle`
   *  supplies. A landscape style leaves those two fields undefined and the
   *  `force_style` string is byte-for-byte what it was — see
   *  `SafeAreaCaptionStyle`'s own comment. */
  captions?: SafeAreaCaptionStyle;
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

  // `aformat` is not cosmetic. `amix` adopts the channel layout of its first
  // input, and ElevenLabs returns mono narration — so without this the whole
  // video came out mono, silently downmixing the stereo music bed and effects
  // that the mix exists to add.
  const narration = `[1:a]${LOUDNESS_TARGET},aformat=channel_layouts=stereo`;

  // The narration is needed twice when music is present — once in the mix and
  // once as the key the ducking listens to.
  filters.push(
    input.musicPath ? `${narration},asplit=2[narr][key]` : `${narration}[narr]`,
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
    // Before `-i`, so this seeks rather than decodes-and-discards, and after
    // the concat input so it applies to the narration alone. Spread from an
    // array so a full render — which passes nothing — emits exactly the two
    // tokens it always did.
    ...(input.audioStartSeconds !== undefined
      ? ["-ss", String(input.audioStartSeconds)]
      : []),
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
    // Not rounded. A whole video's length is `VoiceOver.durationSeconds`, an
    // integer column, so this is the same token it has always been for every
    // render — but a WINDOW of a narration is a run of sentences and lands on
    // a fraction, and rounding that would produce a clip up to half a second
    // longer or shorter than the window the operator is shown beside it.
    "-t", String(input.durationSeconds),
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
 * `durations` is the timing model, one entry per clip path: how long that clip
 * holds the screen. RenderService derives them from where each script section
 * falls in the narration's alignment, so a clip plays for exactly as long as
 * its section is spoken. A video with no cues gets an equal share each — the
 * same shape, computed differently — which is why this function knows nothing
 * about cues at all.
 *
 * `clipPaths` is a sequence, not a set: the same file may legitimately fill
 * more than one slot (a fallback pool handing one clip to two sections). Each
 * distinct file at a given length is normalised once; the repeats are extra
 * lines in the concat list, costing a file open rather than a decode.
 *
 * Both the length mismatch and the per-entry checks below are hard failures
 * rather than clamps. A wrong duration does not look wrong — it looks like a
 * finished video whose picture is a few seconds ahead of the words from some
 * point onward, which nobody spots until it is published.
 */
export function planRender(
  clipPaths: string[],
  segmentDir: string,
  durations: number[],
  transitions?: TransitionStyle,
): RenderPlan {
  if (clipPaths.length === 0) {
    throw new ValidationError("Cannot render without at least one clip.");
  }

  if (durations.length !== clipPaths.length) {
    throw new ValidationError(
      `Cannot render: ${clipPaths.length} clip(s) but ${durations.length} duration(s). ` +
        "Every clip needs the length of the section it plays under.",
    );
  }

  const count = clipPaths.length;
  const overlap = transitions?.enabled ? transitions.durationSeconds : 0;
  const hasStubs = overlap > 0 && count > 1;

  durations.forEach((seconds, index) => {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new ValidationError(
        `Cannot render: clip ${index + 1} was given a length of ${seconds}s.`,
      );
    }

    // A crossfade eats `overlap` from the end of the section before it and the
    // start of the section after it. A section shorter than that would be
    // asked to give away more than it has: its outpoint (`seconds`) would land
    // before its inpoint (`overlap`), and the concat demuxer reads that
    // backwards range as an empty entry — every later section then plays early
    // against the narration. Refusing is the only outcome that cannot ship a
    // mistimed video.
    if (hasStubs && seconds <= overlap) {
      throw new ValidationError(
        `Cannot render: clip ${index + 1} is ${seconds}s, shorter than the ` +
          `${overlap}s transition it has to make room for.`,
      );
    }
  });

  const segmentPathOf = new Map<string, string>();
  const segments: SegmentInput[] = [];
  const sourceSecondsOf: number[] = [];

  clipPaths.forEach((clipPath, index) => {
    const clipSeconds = durations[index];

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
        // Derived here rather than passed in, so the one place that knows a
        // clip path is also the one place that decides how FFmpeg opens it.
        // False for every stock clip, which is what keeps their argv
        // unchanged — see `SegmentInput.still`.
        still: isStillImagePath(clipPath),
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
      trimmedSeconds: [...durations],
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
