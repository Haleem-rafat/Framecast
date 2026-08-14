import { NextResponse, type NextRequest } from "next/server";

import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getShortFile, statShortFile } from "@/lib/shorts-storage";
import { getSession } from "@/server/session";

/**
 * Streams one finished short off local disk so `shorts-panel.tsx` can play it.
 *
 * The exact counterpart of `/api/videos/[id]/file` (see that route for the full
 * reasoning) and it repeats that route's two load-bearing properties:
 *
 *   - The location is resolved server-side from `Short.outputPath`, never taken
 *     from the client. A route accepting a location directly would let anyone
 *     who obtained one read arbitrary files under RENDER_ROOT.
 *   - Ownership is checked through the parent video before a single byte is
 *     served, so a short belonging to someone else is indistinguishable from
 *     one that does not exist.
 *
 * Node runtime, not Edge — Prisma's query engine requires it.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string; shortId: string }>;
}

function errorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    return NextResponse.json(error.serialize(), { status: error.httpStatus });
  }
  throw error;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSession();
  if (!session) {
    return errorResponse(new UnauthorizedError());
  }

  const { id: videoId, shortId } = await params;

  // Both ids are in the `where`, not just the short's: a short id alone would
  // serve correctly, but pairing them means a tampered URL that mixes one
  // video's id with another's short resolves to nothing rather than quietly
  // ignoring the mismatch.
  const short = await prisma.short.findFirst({
    where: {
      id: shortId,
      videoId,
      video: { userId: session.user.id, deletedAt: null },
    },
    select: { outputPath: true },
  });

  if (!short?.outputPath) {
    return errorResponse(new NotFoundError("Short"));
  }

  let file;
  try {
    file = await getShortFile(short.outputPath, request.headers.get("range"));
  } catch (error) {
    return errorResponse(error);
  }

  if (file === null) {
    // The row says a file exists; the disk disagrees. A plain 404 rather than
    // render-storage's typed `RenderFileMissingError`: a short is regenerated
    // from the panel, not recovered, so there is no distinct operator action
    // worth naming here.
    return errorResponse(new NotFoundError("Short file"));
  }

  if (file === "unsatisfiable") {
    const stat = await statShortFile(short.outputPath);
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
