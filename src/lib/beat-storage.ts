import "server-only";

import { storagePath } from "@/lib/storage";

/**
 * Where an illustrated video's pictures live.
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
 * The prefix every one of a video's beat images lives under.
 *
 * A prefix of its own rather than PNGs filed among the clips, and that is
 * load-bearing: it is how `render.service.ts` recognises an illustrated video
 * at all. `kind: "IMAGE"` under `videos/{id}/` would also match every thumbnail
 * the video has ever had.
 */
export function beatPrefix(videoId: string): string {
  return `videos/${videoId}/beats/`;
}
