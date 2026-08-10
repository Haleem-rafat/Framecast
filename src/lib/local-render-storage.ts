import "server-only";

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Finished renders live on local disk instead of Supabase Storage — Supabase's
 * free tier caps an object at 50MB, and a real 1080p render comes in around
 * 170MB. See docs/superpowers/specs/2026-08-10-render-worker-design.md's
 * "Known conflicts" section for the tradeoff this creates with the render
 * worker.
 *
 * Narration, clips and captions are unaffected — they're small and still live
 * in Supabase Storage (src/lib/storage.ts) because the worker (running on a
 * different machine) will still need to read them.
 *
 * `RenderJob.outputUrl` stores the *relative* path `localRenderPath` returns
 * (e.g. `.framecast/renders/<videoId>.mp4`), not an absolute filesystem path.
 * Deliberately:
 *
 * 1. Every entry point that writes or reads it — `next dev`/`next start`, the
 *    render CLI (`pnpm render`), the render worker — is launched via a
 *    `package.json` script, and pnpm/npm always run those with `cwd` set to
 *    the package root. "Relative to the repo root" is therefore a stable,
 *    documented base, not a guess — see `absolutePath` below, the one place
 *    that assumption is used.
 * 2. A relative path survives the repo being checked out somewhere else (a
 *    fresh clone, a different machine, a CI runner). An absolute path baked
 *    into the database would silently go stale the moment that happens —
 *    either pointing at nothing, or worse, at an unrelated file that happens
 *    to exist at the same absolute path on the new machine.
 *
 * The tradeoff this doesn't remove: the file itself is still tied to
 * whichever machine wrote it. A relative *path* is portable; the *bytes*
 * are not. That's the real limitation recorded in the design doc, not
 * something this path choice can paper over.
 */
export const RENDER_STORAGE_DIR = path.join(".framecast", "renders");

/** `videoId` is a `Video.id` UUID, but this validates it anyway rather than
 * trusting it — the same discipline `storagePath` (storage.ts) applies to
 * Supabase keys. A caller passing anything other than a bare UUID is a bug
 * (or, on the route handler, a directory-traversal attempt), not something to
 * quietly sanitise into working. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one deterministic filename this module hands out — same shape as
 * `storagePath(videoId, "output", "video.mp4")` used to be, just rooted under
 * `RENDER_STORAGE_DIR` instead of a Supabase prefix. Deterministic on
 * `videoId` alone (no random component), so nothing needs to remember a path
 * separately from the video it belongs to. */
export function localRenderPath(videoId: string): string {
  if (!UUID_PATTERN.test(videoId)) {
    throw new ValidationError(`Unsafe render video id: "${videoId}"`);
  }

  return path.join(RENDER_STORAGE_DIR, `${videoId}.mp4`);
}

/** The only place a relative render path is turned into an absolute one for
 * actual file I/O — see this module's doc comment for why `process.cwd()` is
 * a safe base here. Nothing outside this module should construct this path
 * itself. */
function absolutePath(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Thrown by every read below when the file a `RenderJob.outputUrl` points at
 * isn't where it should be — a cleaned checkout, a render done on a machine
 * that no longer has it, manual disk cleanup. Both the preview route and
 * `publish.service.ts` surface this instead of a raw `ENOENT`: it's an
 * expected, named business condition ("this needs to be re-rendered"), not an
 * unexpected failure.
 */
export class RenderFileMissingError extends ConflictError {
  constructor(readonly videoId: string) {
    super(`This video's render is no longer on disk and needs to be re-rendered.`);
  }
}

/** Writes the render's bytes for `videoId`, creating `RENDER_STORAGE_DIR` if
 * this is the first render on this machine. Returns the relative path to
 * store on `RenderJob.outputUrl`. */
export async function writeRenderFile(videoId: string, body: Buffer): Promise<string> {
  const relativePath = localRenderPath(videoId);
  const fullPath = absolutePath(relativePath);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, body);

  return relativePath;
}

export interface RenderFileStat {
  /** Only ever used for local `fs` calls (streaming, reading) — never sent to
   * the browser or stored anywhere. */
  absolutePath: string;
  sizeBytes: number;
}

/** Stats the render file for `videoId`. Throws `RenderFileMissingError`
 * (never a raw `ENOENT`) when it isn't on disk. */
export async function statRenderFile(videoId: string): Promise<RenderFileStat> {
  const fullPath = absolutePath(localRenderPath(videoId));

  try {
    const stats = await stat(fullPath);
    return { absolutePath: fullPath, sizeBytes: stats.size };
  } catch (error) {
    if (isEnoent(error)) {
      throw new RenderFileMissingError(videoId);
    }
    throw error;
  }
}

/** Reads the whole render into memory — used by `publish.service.ts`, which
 * needs the full buffer to hand to YouTube's upload. The preview route uses
 * `createRenderReadStream` instead so a 170MB file is never buffered whole
 * just to serve it to a `<video>` tag. */
export async function readRenderFile(videoId: string): Promise<Buffer> {
  const { absolutePath: fullPath } = await statRenderFile(videoId);

  try {
    return await readFile(fullPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new RenderFileMissingError(videoId);
    }
    throw error;
  }
}

/** A Node `Readable` over the render's bytes (optionally a byte range), for
 * the preview route to stream without buffering the whole file. Callers must
 * `statRenderFile` first — this only opens the stream, it doesn't re-check
 * existence, so a file removed between the two calls surfaces as a stream
 * `error` event rather than `RenderFileMissingError`. */
export function createRenderReadStream(
  videoId: string,
  range?: { start: number; end: number },
): ReturnType<typeof createReadStream> {
  const fullPath = absolutePath(localRenderPath(videoId));
  return range ? createReadStream(fullPath, range) : createReadStream(fullPath);
}
