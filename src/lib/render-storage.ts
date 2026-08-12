import "server-only";

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { env } from "@/config/env";
import { ConflictError, InternalError, ValidationError } from "@/lib/errors";
import { parseRangeHeader } from "@/lib/http-range";

/**
 * Finished renders live on the local disk of the machine that produced them.
 *
 * They previously lived in Vercel Blob, because the worker ran on Railway and
 * the app on Vercel and neither could read the other's disk. Both now run on
 * one VPS, which removes the reason — and removes the metered transfer that
 * suspended the Blob store mid-render, destroying eleven minutes of encoding
 * at the moment it tried to save itself.
 *
 * `RenderJob.outputUrl` no longer holds a URL. It holds a path relative to
 * RENDER_ROOT, e.g. `renders/<uuid>.mp4`. Parameters are named `location`
 * rather than `url` so no reader assumes it can be fetched.
 */
const RENDER_PREFIX = "renders";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOT = resolve(env.RENDER_ROOT);

/** Deterministic on `videoId` alone, so a second render for the same video
 * overwrites the first rather than accumulating orphans on a 40GB disk. */
export function renderPath(videoId: string): string {
  if (!UUID_PATTERN.test(videoId)) {
    throw new ValidationError(`Unsafe render video id: "${videoId}"`);
  }

  return `${RENDER_PREFIX}/${videoId}.mp4`;
}

function resolveRender(location: string): string {
  const absolute = resolve(join(ROOT, location));

  if (!absolute.startsWith(ROOT + sep)) {
    throw new ValidationError(`Unsafe render location: "${location}"`);
  }

  return absolute;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Thrown by callers — not by this module, whose reads return `null` — when a
 * `RenderJob.outputUrl` points at a file that is not there: a render made on
 * a machine that no longer exists, a manual deletion, or a render reclaimed
 * after publish. A named business condition ("this needs re-rendering"), not
 * an unexpected failure.
 */
export class RenderFileMissingError extends ConflictError {
  constructor(readonly videoId: string) {
    super("This video's render is no longer available and needs to be re-rendered.");
  }
}

/**
 * What `writeRenderFile` accepts. Not `Buffer` alone: `render.service.ts`
 * hands this a `fs.createReadStream(outputPath)` for the finished MP4, not a
 * buffered file — a real render is ~170MB, and a Buffer-only signature would
 * force that whole file into the memory of a 4GB VPS just to hand it off
 * again a moment later. A `Buffer` is still accepted directly for the small
 * fixtures this module's own tests write, and because forcing every caller
 * through a stream for a few dozen bytes would be its own kind of waste.
 */
export type RenderFileSource = Buffer | Readable;

/**
 * Writes `source` to the deterministic path for `videoId` and returns that
 * path (relative to `RENDER_ROOT`) to persist on `RenderJob.outputUrl`. A
 * `Buffer` is written directly; a stream is piped straight to disk via
 * `pipeline` so a large render is never held in memory whole (see
 * `RenderFileSource`'s doc comment).
 */
export async function writeRenderFile(
  videoId: string,
  source: RenderFileSource,
): Promise<string> {
  const location = renderPath(videoId);
  const absolute = resolveRender(location);

  try {
    await mkdir(dirname(absolute), { recursive: true });

    if (Buffer.isBuffer(source)) {
      await writeFile(absolute, source);
    } else {
      await pipeline(source, createWriteStream(absolute));
    }
  } catch (error) {
    throw new InternalError(
      `Could not write the render for video ${videoId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return location;
}

export interface RenderFileStat {
  sizeBytes: number;
}

/** Stats the render at `location`. Returns `null` when it isn't there rather
 * than throwing — callers that need the typed, non-fatal
 * `RenderFileMissingError` (see its doc comment) construct it themselves
 * from this `null`. */
export async function statRenderFile(location: string): Promise<RenderFileStat | null> {
  try {
    return { sizeBytes: (await stat(resolveRender(location))).size };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export interface RenderFileContent {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** The whole file's size, not the size of a partial range. */
  sizeBytes: number;
  /** Bytes actually in `stream`: the range's length when `contentRange` is
   * set, the whole file's size otherwise. */
  contentLength: number;
  /** The `Content-Range` value to send back, e.g. `"bytes 5-9/26"`, or null
   * for a full response. Detect a partial response by this, not by size. */
  contentRange: string | null;
}

/**
 * Opens the render at `location`, honouring `rangeHeader` if present.
 *
 * Three outcomes the caller must distinguish: `null` when the file is not
 * there (a 404 or a `RenderFileMissingError`), the string `"unsatisfiable"`
 * when a range starts past the end (a 416, which browsers do provoke by
 * seeking a video that was re-rendered shorter), and content otherwise. Blob
 * used to answer an unsatisfiable range itself; a filesystem cannot, which is
 * why `parseRangeHeader` (Task 1) exists to do that job locally now.
 */
export async function getRenderFile(
  videoId: string,
  location: string,
  rangeHeader?: string | null,
): Promise<RenderFileContent | null | "unsatisfiable"> {
  const absolute = resolveRender(location);

  let sizeBytes: number;
  try {
    sizeBytes = (await stat(absolute)).size;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new InternalError(
      `Could not stat the render for video ${videoId}: ` +
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

/** Deletes the render. A no-op when it is already gone, because a retried
 * publish reclaims a render that the first attempt already deleted. */
export async function deleteRenderFile(location: string): Promise<void> {
  await rm(resolveRender(location), { force: true });
}
