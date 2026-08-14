import "server-only";

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";
import { parseRangeHeader } from "@/lib/http-range";

/**
 * Finished shorts live beside finished renders, on the local disk of the
 * machine that produced them, under `RENDER_ROOT/shorts/<shortId>.mp4`.
 *
 * They go here rather than through `storage.ts` for the reason that module's
 * own `OBJECT_SIZE_LIMIT_BYTES` comment already gives about renders: `putObject`
 * takes a `Buffer` and refuses anything past 50MB. A minute of 1080x1920 at the
 * final CRF lands in the tens of megabytes — under the cap most of the time,
 * which is the worst possible relationship to have with a hard limit — and
 * buffering it whole would put it in the memory of a worker capped at 640MB for
 * no reason, when the encoder has already written it to a file that can simply
 * be streamed.
 *
 * It deliberately does not reuse `render-storage.ts`'s `writeRenderFile`
 * either: that function's path is deterministic on the VIDEO id, by design, so
 * that a re-render overwrites its predecessor. A video has many shorts at once,
 * so they are keyed on the short's own id instead. The confinement check below
 * is the same shape as that module's, and for the same reason — it is the one
 * thing between a database-supplied path and an arbitrary filesystem read.
 */
const SHORTS_PREFIX = "shorts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOT = resolve(env.RENDER_ROOT);

/** Deterministic on `shortId`, so re-rendering one short overwrites its own
 *  file rather than accumulating orphans on a 40GB disk. */
export function shortPath(shortId: string): string {
  if (!UUID_PATTERN.test(shortId)) {
    throw new ValidationError(`Unsafe short id: "${shortId}"`);
  }

  return `${SHORTS_PREFIX}/${shortId}.mp4`;
}

/** Confines `location` to `ROOT`. Checks `ROOT + sep`, not bare `ROOT`, so a
 *  sibling directory that merely shares the prefix (`${ROOT}-evil/x.mp4`) is
 *  refused too and not only a literal `..`. */
function resolveShort(location: string): string {
  const absolute = resolve(join(ROOT, location));

  if (!absolute.startsWith(ROOT + sep)) {
    throw new ValidationError(`Unsafe short location: "${location}"`);
  }

  return absolute;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Copies the encoder's output file into place and returns the location to
 * persist on `Short.outputPath`.
 *
 * Written to a temp file and `rename`d, exactly as `writeRenderFile` does:
 * `shortPath` is deterministic, so a re-render targets the path the previous
 * successful attempt still points at, and writing in place would truncate it
 * for the duration of the copy while `getShortFile` happily served the partial
 * result as a normal 200.
 */
export async function writeShortFile(shortId: string, sourcePath: string): Promise<string> {
  const location = shortPath(shortId);
  const absolute = resolveShort(location);
  const tempPath = `${absolute}.tmp-${randomUUID()}`;
  const source: Readable = createReadStream(sourcePath);

  try {
    await mkdir(dirname(absolute), { recursive: true });
    await pipeline(source, createWriteStream(tempPath));
    await rename(tempPath, absolute);
  } catch (error) {
    if (!source.destroyed) {
      source.destroy();
    }
    await rm(tempPath, { force: true }).catch(() => {
      // Best-effort: the write error below is what the caller needs to see.
    });
    throw new InternalError(
      `Could not write the short ${shortId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return location;
}

/** Stats the short at `location`, or null when it is not there. */
export async function statShortFile(location: string): Promise<{ sizeBytes: number } | null> {
  try {
    return { sizeBytes: (await stat(resolveShort(location))).size };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export interface ShortFileContent {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  sizeBytes: number;
  contentLength: number;
  contentRange: string | null;
}

/**
 * Opens the short at `location`, honouring `rangeHeader`. Same three outcomes
 * `getRenderFile` has, and the caller must distinguish all three: `null` when
 * the file is gone, `"unsatisfiable"` when the range starts past the end (a
 * 416 — browsers provoke this by seeking a clip that was re-rendered shorter),
 * and content otherwise.
 */
export async function getShortFile(
  location: string,
  rangeHeader?: string | null,
): Promise<ShortFileContent | null | "unsatisfiable"> {
  const absolute = resolveShort(location);

  let sizeBytes: number;
  try {
    sizeBytes = (await stat(absolute)).size;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new InternalError(
      `Could not stat the short at ${location}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const range = parseRangeHeader(rangeHeader, sizeBytes);

  if (range === "unsatisfiable") {
    return "unsatisfiable";
  }

  const nodeStream = range
    ? createReadStream(absolute, { start: range.start, end: range.end })
    : createReadStream(absolute);

  return {
    stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
    contentType: "video/mp4",
    sizeBytes,
    contentLength: range ? range.end - range.start + 1 : sizeBytes,
    contentRange: range ? `bytes ${range.start}-${range.end}/${sizeBytes}` : null,
  };
}

/** Deletes a short's file. A no-op when it is already gone — regeneration
 *  reclaims files whose rows may point at something a previous failed attempt
 *  never finished writing. */
export async function deleteShortFile(location: string): Promise<void> {
  await rm(resolveShort(location), { force: true });
}
