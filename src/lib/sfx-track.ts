import path from "node:path";

/**
 * The effects are mixed into one full-length track here rather than handed to
 * the assemble pass as separate inputs.
 *
 * Fifty boundaries would otherwise mean fifty extra inputs to pass two. Audio
 * decoders are far cheaper than video ones, so that would probably survive —
 * but adding pressure to this particular worker without needing to is how the
 * original OOM happened, and pass two now mixes exactly three audio streams
 * regardless of how many cuts the video has.
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

/** Three is enough that rotation never repeats on adjacent cuts. */
const WHOOSHES = ["whoosh-1.mp3", "whoosh-2.mp3", "whoosh-3.mp3"];
const STINGER = "stinger.mp3";
const SWELL = "swell.mp3";

/** How long before the end the closing swell starts. */
const SWELL_LEAD_SECONDS = 3;

/**
 * Bundled, not fetched. A whoosh reused across a thousand videos is a licence
 * settled once — fetching one per render would add latency, a failure mode and
 * a per-clip licence check for a file that never varies. See
 * public/sfx/README.md for how these were produced.
 */
export function sfxPackDir(): string {
  return path.join(process.cwd(), "public", "sfx");
}

export function planSfxCues(boundarySeconds: number[], durationSeconds: number): SfxCue[] {
  const dir = sfxPackDir();

  const cues: SfxCue[] = [{ path: path.join(dir, STINGER), atSeconds: 0 }];

  // Selection is by index, never random: the same video re-rendered must
  // produce the same track, byte for byte.
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

  const delays = input.cues
    .map(
      (cue, index) =>
        `[${index}:a]adelay=${Math.round(cue.atSeconds * 1000)}:all=1[d${index}]`,
    )
    .join(";");
  const labels = input.cues.map((_cue, index) => `[d${index}]`).join("");

  args.push(
    "-filter_complex",
    // `normalize=0` for the same reason the assemble pass sets it: the default
    // divides by input count, which here would quietly drop every effect's
    // level as the video gained more cuts.
    `${delays};${labels}amix=inputs=${input.cues.length}:normalize=0[aout]`,
    "-map", "[aout]",
    "-t", String(Math.round(input.durationSeconds)),
    "-c:a", "aac",
    "-b:a", "128k",
    input.outputPath,
  );

  return args;
}
