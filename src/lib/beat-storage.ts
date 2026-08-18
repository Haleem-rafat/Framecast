import "server-only";

import { storagePath } from "@/lib/storage";

/**
 * Where a beat-collected video's pictures live — drawn or downloaded.
 *
 * Its own module, small as it is, because both `footage.service.ts` (which
 * writes them) and `render.service.ts` (which reads them back) need it, and
 * neither should have to import the other to get it: the footage service pulls
 * in the image provider and the render service pulls in FFmpeg and the
 * composer, so a path helper that lived in either would drag one whole subtree
 * into the other's callers. Two copies of the string is the alternative, and
 * that is two chances for the renderer to look one directory away from where
 * collection stored the picture.
 */

/**
 * Beat `index`'s illustration, zero-padded to three digits so play order is
 * lexicographic — a query ordered by `storagePath` is already in the order the
 * pictures are shown, exactly as `sectionClipPath` arranges for clips.
 */
export function beatImagePath(videoId: string, index: number): string {
  return storagePath(videoId, "beats", `beat-${String(index).padStart(3, "0")}.png`);
}

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
 *
 * Same zero padding as `beatImagePath`, so a query ordered by `storagePath` is
 * still in play order however the two kinds interleave: `beat-003.mp4` sorts
 * between `beat-002.png` and `beat-004.png` because the digits decide before
 * the extension is ever reached.
 */
export function beatClipPath(videoId: string, index: number): string {
  return storagePath(videoId, "beats", `beat-${String(index).padStart(3, "0")}.mp4`);
}

/**
 * Which of the two a beat actually got, from the paths already on disk.
 *
 * The still first, and the order is not arbitrary: a beat can only hold one
 * picture, and if a collection ever left both behind — a `motion` shot drawn as
 * a fallback on one run and downloaded on a later one — the drawn one is the
 * one that was already paid for and the one whose look matches the rest of the
 * video. Preferring it makes that state resolve the same way every render
 * rather than depending on which query came back first.
 *
 * Returns null for a beat with neither, which the renderer refuses on rather
 * than sliding every later picture forward into the gap.
 */
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

/**
 * The prefix every one of a video's beat pictures lives under, of either kind.
 *
 * A prefix of its own rather than PNGs filed among the clips, and that is
 * load-bearing: it is how `render.service.ts` recognises a beat-collected video
 * at all. `kind: "IMAGE"` under `videos/{id}/` would also match every thumbnail
 * the video has ever had — and now that a beat can also be an MP4, a query
 * under `videos/{id}/` for `kind: "VIDEO"` would sweep up every section clip a
 * stock video ever collected.
 */
export function beatPrefix(videoId: string): string {
  return `videos/${videoId}/beats/`;
}
