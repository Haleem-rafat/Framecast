import { NextResponse, type NextRequest } from "next/server";

import { getRenderFile, RenderFileMissingError, statRenderFile } from "@/lib/render-storage";
import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/server/session";

/**
 * Streams a video's finished render off local disk (see render-storage.ts)
 * so `video-preview.tsx` can play it and the download link can save it.
 *
 * This route takes a video **id**, never a render location directly — the
 * location is always resolved server-side from `RenderJob.outputUrl`. A
 * route that accepted a render location straight from the client would let
 * anyone who obtained one (a leaked link, a browser devtools peek) read
 * arbitrary files under RENDER_ROOT, bypassing the ownership check below.
 *
 * Range handling is this route's again, via render-storage.ts, not Blob's:
 * a filesystem doesn't implement RFC 7233 the way Blob's `get()` did, so
 * `getRenderFile` parses the incoming `Range` header itself (see
 * `parseRangeHeader`) and this route must handle all three outcomes it can
 * return — content, `null` (missing), and `"unsatisfiable"` (416).
 *
 * Still Node, not Edge — not because of `fs` alone but because Prisma's
 * query engine requires the Node runtime.
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
  // fetched in the same query rather than derived from videoId — a render's
  // location is stored, not reconstructed, so a video that was never
  // rendered has none to derive.
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

  if (file === null) {
    // The RenderJob row says a render exists; the file it points at doesn't
    // (deleted from disk, reclaimed, a machine that no longer exists, ...).
    // A named, non-fatal condition — "this needs re-rendering" — not the
    // plain 404 "never rendered" gets above, so it's surfaced the same way
    // publish.service.ts and the video detail page already surface it.
    return errorResponse(new RenderFileMissingError(video.id));
  }

  // A seek past the end of a file that was re-rendered shorter. RFC 7233
  // requires 416 with the real size so the player can recover, rather than
  // a 200 carrying bytes nobody asked for. Blob used to answer this itself;
  // a filesystem can't, so `statRenderFile` is what supplies the size here.
  if (file === "unsatisfiable") {
    const stat = await statRenderFile(outputUrl);
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat?.sizeBytes ?? 0}` },
    });
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
