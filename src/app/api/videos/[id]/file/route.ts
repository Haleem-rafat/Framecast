import { NextResponse, type NextRequest } from "next/server";

import { getRenderFile } from "@/lib/blob-render-storage";
import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/server/session";

/**
 * Streams a video's finished render out of Vercel Blob (see
 * blob-render-storage.ts) so `video-preview.tsx` can play it and the
 * download link can save it.
 *
 * This route takes a video **id**, never a Blob url or pathname directly —
 * the url is always resolved server-side from `RenderJob.outputUrl`. A
 * route that accepted a Blob url straight from the client would let anyone
 * who obtained one (a leaked link, a browser devtools peek) read the store
 * with this route's own credentials, bypassing the ownership check below.
 *
 * Range handling is Blob's, not this route's own: the incoming `Range`
 * header is forwarded to `getRenderFile` untouched (see its doc comment for
 * why partial vs. full is detected via `content-range`, not `statusCode`).
 * This route used to hand-parse RFC 7233 itself against local disk; that
 * parsing no longer exists.
 *
 * Still Node, not Edge — not because of `fs` (this route no longer touches
 * it) but because Prisma's query engine requires the Node runtime.
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
  // doesn't exist at all. The latest successful RenderJob's outputUrl is
  // fetched in the same query rather than derived from videoId — unlike the
  // local-disk pathname this route used to use, a Blob url is not
  // reconstructable from the video id alone (see blob-render-storage.ts).
  const video = await prisma.video.findFirst({
    where: { id: videoId, userId: session.user.id, deletedAt: null },
    select: {
      id: true,
      renderJobs: {
        where: { status: "SUCCEEDED" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { outputUrl: true },
      },
    },
  });

  if (!video) {
    return errorResponse(new NotFoundError("Video"));
  }

  const outputUrl = video.renderJobs[0]?.outputUrl;
  if (!outputUrl) {
    // Never rendered (or no *successful* render yet) — a file-serving route's
    // ordinary 404, not the 409 `RenderFileMissingError` publish.service.ts
    // and the video detail page use for the same underlying condition.
    return errorResponse(new NotFoundError("Video render"));
  }

  const rangeHeader = request.headers.get("range");

  let file;
  try {
    file = await getRenderFile(video.id, outputUrl, rangeHeader);
  } catch (error) {
    return errorResponse(error);
  }

  if (!file) {
    // The RenderJob row says a render exists; the blob it points at doesn't
    // (deleted from the store, wrong environment's token, ...). Same 404 as
    // "never rendered" above — from this route's caller's point of view,
    // both mean "there is nothing to play right now."
    return errorResponse(new NotFoundError("Video render"));
  }

  const headers: Record<string, string> = {
    "content-type": file.contentType,
    "content-length": String(file.contentLength),
    "accept-ranges": "bytes",
  };

  if (file.contentRange) {
    headers["content-range"] = file.contentRange;
    return new NextResponse(file.stream, { status: 206, headers });
  }

  return new NextResponse(file.stream, { status: 200, headers });
}
