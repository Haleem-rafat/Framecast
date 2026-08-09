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
    // Duration is capped inside the filter graph below (via `trim`), not with
    // an input-level `-t` — that would collide with the output `-t` below and
    // make it ambiguous which one callers are looking at.
    args.push("-stream_loop", "-1", "-i", clip);
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
    "-map", "[vout]",
    "-map", `${audioIndex}:a`,
    "-c:v", "libx264",
    "-preset", "medium",
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
