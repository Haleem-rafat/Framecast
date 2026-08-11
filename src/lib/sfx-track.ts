import path from "node:path";

/**
 * The effects are mixed into one full-length track here rather than handed to
 * the assemble pass as separate inputs.
 *
 * Fifty boundaries would otherwise mean fifty extra inputs to pass two. Audio
 * decoders are far cheaper than video ones, so that would probably survive —
 * but adding pressure to *that* pass without needing to is how the original
 * OOM happened, and it now mixes exactly three audio streams regardless of
 * how many cuts the video has.
 *
 * The per-cue cost was moved here, not removed: this pass opens one input per
 * cue. That is the trade — one short, audio-only FFmpeg run holding N cheap
 * decoders, instead of the video pass holding them alongside its own. Keeping
 * the cue count small (see MIN_WHOOSH_GAP_SECONDS) is therefore worth
 * something here too, though the reason to do it is that the video sounds
 * better, not that the encoder needs it.
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
 * The shortest gap allowed between two whooshes.
 *
 * A whoosh marks a change of subject. It stops meaning that the moment it
 * becomes predictable, and a viewer hears a rhythm instead of an accent.
 *
 * There was no need for this rule when a cut was a cut every twelve seconds
 * against a twelve-clip cap: eleven whooshes across a seven-minute video, all
 * of them audible as punctuation. Per-section cutting changed the input
 * without changing this file — a section is roughly one or two sentences, so
 * boundaries now arrive every eight seconds or so and a seven-minute video
 * offered about forty-nine of them. Nobody chose that and nobody has heard
 * it; it is the two features meeting, not either one's intent.
 *
 * Thirty seconds is picked to land the density back where the shipped version
 * actually was — at most fourteen whooshes in seven minutes against the old
 * eleven — rather than at some number that merely sounds restrained. It is a
 * minimum gap rather than "every Nth cut" because the ear responds to elapsed
 * time, not to cut ordinals: with per-section cutting, every third cut is
 * eight seconds apart in a dense passage and forty in a slow one, and only one
 * of those two is a metronome.
 *
 * The cues that survive still sit exactly on real cuts. Thinning drops
 * effects; it never invents a boundary that the picture does not have.
 */
export const MIN_WHOOSH_GAP_SECONDS = 30;

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

  // Seeded with the opening stinger's own position rather than -Infinity: the
  // stinger is an effect the viewer hears at 0, and a whoosh three seconds
  // later reads as part of it rather than as a new accent.
  let lastWhooshAt = 0;
  // Counted over the whooshes actually kept, not over the boundaries offered,
  // so the rotation still guarantees no two audible whooshes in a row are the
  // same file — thinning would otherwise be able to select every third
  // boundary and hand back the same sound each time.
  let kept = 0;

  for (const atSeconds of boundarySeconds) {
    if (atSeconds - lastWhooshAt < MIN_WHOOSH_GAP_SECONDS) {
      continue;
    }

    // Selection is by index, never random: the same video re-rendered must
    // produce the same track, byte for byte.
    cues.push({ path: path.join(dir, WHOOSHES[kept % WHOOSHES.length]), atSeconds });
    lastWhooshAt = atSeconds;
    kept += 1;
  }

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
