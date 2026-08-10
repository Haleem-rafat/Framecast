import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse, type NextRequest } from "next/server";

import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { statRenderFile } from "@/lib/local-render-storage";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/server/session";

/**
 * Streams a video's finished render off local disk (see
 * local-render-storage.ts) so `video-preview.tsx` can play it and the
 * download link can save it — the local-disk replacement for what used to be
 * a Supabase signed URL.
 *
 * This route takes a video **id**, never a path — the filesystem path is
 * always derived server-side from the id via `statRenderFile` /
 * `localRenderPath`. A route that accepted a path directly would be a
 * directory-traversal hole; there is deliberately no parameter here that
 * could become one.
 *
 * Needs Node's `fs` module for streaming, so this route cannot run on the
 * Edge runtime.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function errorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    return NextResponse.json(error.serialize(), { status: error.httpStatus });
  }
  throw error;
}

/** Parses a single-range `Range: bytes=start-end` header per RFC 7233.
 * Returns `null` for anything this route doesn't support (multi-range,
 * malformed) so the caller falls back to serving the whole file — the same
 * "range headers are advisory" behaviour real HTTP servers use. Returns
 * `undefined` for an unsatisfiable range so the caller can respond 416. */
function parseRange(
  header: string,
  sizeBytes: number,
): { start: number; end: number } | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") {
    return null;
  }

  let start: number;
  let end: number;

  if (startStr === "") {
    // A suffix range ("bytes=-500") means "the last 500 bytes."
    const suffixLength = Number(endStr);
    start = Math.max(sizeBytes - suffixLength, 0);
    end = sizeBytes - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? sizeBytes - 1 : Number(endStr);
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    start >= sizeBytes
  ) {
    return undefined;
  }

  return { start, end: Math.min(end, sizeBytes - 1) };
}

function toWebStream(nodeStream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(nodeStream) as unknown as ReadableStream;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  // Require a session before anything else — an unauthenticated request never
  // learns whether a video with this id even exists.
  const session = await getSession();
  if (!session) {
    return errorResponse(new UnauthorizedError());
  }

  const { id: videoId } = await params;

  // Confirm the video belongs to *this* user before serving a single byte.
  // Same ownership check every service in this codebase does
  // (`findFirst({ where: { id, userId, deletedAt: null } })`) — a video id
  // that exists but belongs to someone else must look identical to one that
  // doesn't exist at all.
  const video = await prisma.video.findFirst({
    where: { id: videoId, userId: session.user.id, deletedAt: null },
    select: { id: true },
  });

  if (!video) {
    return errorResponse(new NotFoundError("Video"));
  }

  let fileStat;
  try {
    fileStat = await statRenderFile(videoId);
  } catch (error) {
    return errorResponse(error);
  }

  const { absolutePath, sizeBytes } = fileStat;
  const rangeHeader = request.headers.get("range");

  if (!rangeHeader) {
    const stream = toWebStream(createReadStream(absolutePath));
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(sizeBytes),
        "accept-ranges": "bytes",
      },
    });
  }

  const range = parseRange(rangeHeader, sizeBytes);

  if (range === undefined) {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${sizeBytes}` },
    });
  }

  if (range === null) {
    // Unsupported range shape — fall back to the whole file rather than
    // failing a request the client can still make progress with.
    const stream = toWebStream(createReadStream(absolutePath));
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(sizeBytes),
        "accept-ranges": "bytes",
      },
    });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  const stream = toWebStream(createReadStream(absolutePath, { start, end }));

  return new NextResponse(stream, {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-length": String(chunkSize),
      "content-range": `bytes ${start}-${end}/${sizeBytes}`,
      "accept-ranges": "bytes",
    },
  });
}
