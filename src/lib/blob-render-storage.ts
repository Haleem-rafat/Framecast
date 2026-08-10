import "server-only";

import { BlobNotFoundError, del, get, head, put } from "@vercel/blob";

import { ConflictError, InternalError, ValidationError } from "@/lib/errors";

/**
 * Finished renders live in Vercel Blob (`framecast-renders`, private access)
 * instead of local disk (see git history for `local-render-storage.ts`, this
 * module's predecessor) or Supabase Storage. Two constraints ruled those
 * out: a real 7-minute 1080p render is ~170MB, well past Supabase Storage's
 * free-tier 50MB object cap (see storage.ts's `BUCKET_FILE_SIZE_LIMIT_BYTES`),
 * and local disk is unreachable from anywhere but the machine that wrote it —
 * the render worker runs in a container on Railway, the app runs on Vercel,
 * and neither can read a file that only exists on the operator's Mac.
 *
 * Narration, clips and captions are unaffected — they're small and still
 * live in Supabase Storage (src/lib/storage.ts) because the worker (already
 * a different machine from the app) has always needed to read them remotely.
 *
 * `RenderJob.outputUrl` now stores the Blob `url` `put()` returns, not a
 * relative filesystem path. Every read/stat/delete below takes that URL, not
 * a `videoId` — unlike the pathname (deterministic on `videoId` alone, see
 * `renderBlobPathname`), the URL is not reconstructed from the video id at
 * call sites. Store what `put()` returns; don't rebuild it.
 */
const RENDER_BLOB_PREFIX = "renders";

/** `videoId` is a `Video.id` UUID, but this validates it anyway rather than
 * trusting it — same discipline `storagePath` (storage.ts) applies to
 * Supabase keys and `localRenderPath` applied to filesystem paths. A caller
 * passing anything other than a bare UUID is a bug, not something to
 * quietly sanitise into working. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one deterministic pathname this module hands out for a *write* —
 * reads/stats/deletes go by the stored URL instead (see the module doc
 * comment). Deterministic on `videoId` alone, combined with `put()`'s
 * `addRandomSuffix: false`, so a second render for the same video overwrites
 * the first rather than accumulating orphaned blobs. */
export function renderBlobPathname(videoId: string): string {
  if (!UUID_PATTERN.test(videoId)) {
    throw new ValidationError(`Unsafe render video id: "${videoId}"`);
  }

  return `${RENDER_BLOB_PREFIX}/${videoId}.mp4`;
}

/**
 * Thrown by callers (not by this module's own functions — see `getRenderFile`
 * and `statRenderFile` below, which return `null` instead) when a
 * `RenderJob.outputUrl` points at a blob that isn't there — a render made
 * against a different store, manual deletion, or (before this module existed)
 * a render that only ever lived on a now-irrelevant local disk. The route and
 * `publish.service.ts` surface this instead of a raw fetch failure: it's an
 * expected, named business condition ("this needs to be re-rendered"), not an
 * unexpected failure.
 */
export class RenderFileMissingError extends ConflictError {
  constructor(readonly videoId: string) {
    super("This video's render is no longer available and needs to be re-rendered.");
  }
}

/** Accepts anything `@vercel/blob`'s `put()` accepts as a body — derived from
 * `put`'s own parameter type rather than re-declared, so this can't drift
 * from the real signature. `@vercel/blob` doesn't export the `PutBody` type
 * itself. */
type RenderFileSource = Parameters<typeof put>[1];

/**
 * Uploads the finished render's bytes for `videoId` and returns the blob
 * `url` to persist on `RenderJob.outputUrl`. `multipart: true` because a
 * single-shot PUT of a ~170MB file is fragile; `addRandomSuffix: false` plus
 * `allowOverwrite: true` because a retried render must land at the same
 * pathname, not accumulate a new blob per attempt.
 */
export async function writeRenderFile(
  videoId: string,
  source: RenderFileSource,
): Promise<string> {
  const written = await put(renderBlobPathname(videoId), source, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "video/mp4",
    multipart: true,
  });

  return written.url;
}

export interface RenderFileStat {
  sizeBytes: number;
}

/** Stats the render at `url` via `head()`. Returns `null` when it isn't
 * there rather than throwing — callers that need the typed, non-fatal
 * `RenderFileMissingError` (see its doc comment) construct it themselves
 * from this `null`, the same way `get()` (below) already returns `null` for
 * a missing blob at the SDK level. */
export async function statRenderFile(url: string): Promise<RenderFileStat | null> {
  try {
    const meta = await head(url);
    return { sizeBytes: meta.size };
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return null;
    }
    throw error;
  }
}

export interface RenderFileContent {
  /** Already a Web `ReadableStream<Uint8Array>` — pass straight through to a
   * `NextResponse` body, no `Readable.toWeb` conversion needed (unlike the
   * local-disk version this module replaced). */
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** The full blob's size in bytes — not the size of a partial range, which
   * `contentLength` (below) already gives. */
  sizeBytes: number;
  /** Bytes actually in `stream`: the partial chunk's size when `contentRange`
   * is set, the whole file's size otherwise. Read straight off Blob's own
   * `content-length` response header rather than re-derived from
   * `contentRange` — the verified behaviour is that header already reflects
   * whichever one applies (e.g. `"5"` for a `bytes=5-9` request). */
  contentLength: number;
  /** The `content-range` header Blob returned, e.g. `"bytes 5-9/26"` — present
   * exactly when `rangeHeader` was forwarded and Blob honoured it. Detect a
   * partial response this way, not via `statusCode`: per the API's verified
   * behaviour, `get()` reports `statusCode: 200` even for a partial read. */
  contentRange: string | null;
}

/**
 * Fetches the render at `url`, forwarding `rangeHeader` (the browser's raw
 * `Range` header, if any) straight through to Blob rather than parsing it —
 * Blob already implements RFC 7233 range semantics server-side. Returns
 * `null` when the blob is missing, the same "recognisable, non-fatal"
 * contract `statRenderFile` follows (see its doc comment); `videoId` is
 * carried through only to name the video in the error this throws for a
 * response shape genuinely unexpected, not to look anything up.
 */
export async function getRenderFile(
  videoId: string,
  url: string,
  rangeHeader?: string | null,
): Promise<RenderFileContent | null> {
  const result = await get(url, {
    access: "private",
    headers: rangeHeader ? { Range: rangeHeader } : undefined,
  });

  if (!result) {
    return null;
  }

  if (result.statusCode !== 200) {
    // Only reachable if a caller ever adds `ifNoneMatch` (this module never
    // does) — a 304 with no body. Not the same condition as "the render is
    // missing"; an InternalError here keeps that meaning specific to `null`.
    throw new InternalError(
      `Unexpected Blob response (${result.statusCode}) reading the render for video ${videoId}.`,
    );
  }

  const contentLengthHeader = result.headers.get("content-length");

  return {
    stream: result.stream,
    contentType: result.blob.contentType,
    sizeBytes: result.blob.size,
    contentLength: contentLengthHeader ? Number(contentLengthHeader) : result.blob.size,
    contentRange: result.headers.get("content-range"),
  };
}

/** Deletes the render at `url`. Not currently called by any app code path —
 * no feature deletes a finished render today — but kept alongside
 * write/stat/get for the same reason `storage.ts` keeps a full CRUD surface:
 * tests need it for cleanup, and a future "delete this video's render"
 * action shouldn't have to invent it from scratch. */
export async function deleteRenderFile(url: string): Promise<void> {
  await del(url);
}
