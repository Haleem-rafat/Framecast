import { NextResponse, type NextRequest } from "next/server";

import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getObject, objectContentType } from "@/lib/storage";
import { getSession } from "@/server/session";

/**
 * Streams a video's narration audio so the detail page can play it.
 *
 * This replaces a Supabase signed URL. That URL carried its own
 * authorisation, which meant anyone who obtained one — a leaked link, a peek
 * in devtools — could read the object for an hour with no session at all.
 * Resolving the object here from the video id, behind the same ownership
 * check every service in this codebase performs, is strictly stronger, and it
 * removes the expiry the page's own comments apologised for.
 *
 * Narration is a few megabytes, so it is read whole rather than streamed with
 * range support. The render, which is ~170MB, gets that treatment in
 * `/api/videos/[id]/file`.
 *
 * Node runtime, not Edge: Prisma's query engine requires it.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session) {
      throw new UnauthorizedError();
    }

    const { id: videoId } = await params;

    // A video that belongs to someone else must look exactly like one that
    // does not exist, so ownership is part of the query rather than a
    // separate check that could be forgotten.
    //
    // `VoiceOver.videoId` is unique — one narration per video — and
    // `audioUrl` holds a storage path despite its name. This is the same
    // row the video page reads as `video.voiceOver?.audioUrl` to decide
    // whether to render the narration card at all.
    const voiceOver = await prisma.voiceOver.findFirst({
      where: {
        videoId,
        video: { userId: session.user.id, deletedAt: null },
      },
      select: { audioUrl: true },
    });

    if (!voiceOver?.audioUrl) {
      throw new NotFoundError("Video narration");
    }

    const [body, contentType] = await Promise.all([
      getObject(voiceOver.audioUrl),
      objectContentType(voiceOver.audioUrl),
    ]);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType ?? "audio/mpeg",
        "Content-Length": String(body.byteLength),
        // The operator's unpublished work: never cached by a shared proxy.
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json(error.serialize(), { status: error.httpStatus });
    }
    throw error;
  }
}
