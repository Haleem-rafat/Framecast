import { ValidationError } from "@/lib/errors";

export interface RenderInput {
  clipPaths: string[];
  audioPath: string;
  srtPath: string;
  outputPath: string;
  /** Cut the result to exactly this, so video and narration cannot drift. */
  durationSeconds: number;
  clipSeconds?: number;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_CLIP_SECONDS = 12;

/**
 * FFmpeg's filter graph parser treats `:` and `'` as syntax, so a path inside
 * `subtitles=` has to be escaped even though the shell never sees it — args are
 * passed to spawn as an array.
 */
function escapeForFilter(path: string): string {
  return path.replace(/([\\:'[\],; ])/g, "\\$1");
}

export function buildRenderArgs(input: RenderInput): string[] {
  if (input.clipPaths.length === 0) {
    throw new ValidationError("Cannot render without at least one clip.");
  }

  const clipSeconds = input.clipSeconds ?? DEFAULT_CLIP_SECONDS;
  const args: string[] = ["-y"];

  for (const clip of input.clipPaths) {
    // Loop each clip so a short one still fills its slot rather than freezing.
    // `-stream_loop -1` alone makes the input infinite — with no input-level
    // `-t`, FFmpeg opens and decodes every input as an unbounded stream, and
    // with dozens of clips that grows memory until the OS kills the process
    // (observed live: 38 clips, killed after 9.5s with no stderr at all — see
    // render-oom-report.md). The `trim=duration=…` below only bounds each
    // clip's *output*, which is too late to stop that growth. The input-level
    // `-t` here is what actually caps memory; `trim` stays too, as a second,
    // cheap guarantee that a clip never contributes more than its slot even
    // if the input bound were ever relaxed.
    //
    // This does mean there are now two `-t` flags in the final arg list — one
    // per clip input, plus the output one below. `args.indexOf("-t")` will
    // find the wrong one; tests must use `lastIndexOf` (the output `-t`,
    // pushed last, is always the last occurrence).
    args.push("-stream_loop", "-1", "-t", String(clipSeconds), "-i", clip);
  }

  args.push("-i", input.audioPath);

  // Trim each looped clip to its slot, then scale to fill, centre-crop the
  // overflow, and force a constant frame rate so the concat filter does not
  // have to reconcile mismatched timebases.
  const perClip = input.clipPaths
    .map(
      (_, i) =>
        `[${i}:v]trim=duration=${clipSeconds},setpts=PTS-STARTPTS,` +
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT},fps=30,setsar=1[v${i}]`,
    )
    .join(";");

  const concatInputs = input.clipPaths.map((_, i) => `[v${i}]`).join("");
  const audioIndex = input.clipPaths.length;

  const filter =
    `${perClip};${concatInputs}concat=n=${input.clipPaths.length}:v=1:a=0[vcat];` +
    `[vcat]subtitles=${escapeForFilter(input.srtPath)}[vout]`;

  args.push(
    "-filter_complex", filter,
    // The filter graph decodes every clip in parallel, and each worker thread
    // carries its own frame buffers. Unbounded, FFmpeg sizes its pool to the
    // host's core count — on the render container that meant far more memory
    // than its 1GB allows, on top of the per-input decoders. Two threads per
    // stage still saturates the container's 2 vCPU.
    "-filter_threads", "2",
    "-filter_complex_threads", "2",
    "-map", "[vout]",
    "-map", `${audioIndex}:a`,
    "-c:v", "libx264",
    // `veryfast` rather than `medium`: x264's slower presets widen the
    // lookahead and reference buffers, which is memory the container does not
    // have. It costs perhaps 10% file size at the same CRF and roughly halves
    // encode time — a good trade for stock footage under captions.
    "-preset", "veryfast",
    "-threads", "2",
    "-crf", "22",
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
  );

  return args;
}
