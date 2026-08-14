import { NextResponse, type NextRequest } from "next/server";

import { ConflictError, isAppError, UnauthorizedError } from "@/lib/errors";
import { getObject, objectContentType, objectSizeBytes } from "@/lib/storage";
import { getSession } from "@/server/session";
import { studioService } from "@/services/studio.service";

/**
 * Streams one thumbnail version's bytes so the gallery can show it.
 *
 * `ThumbnailVersion.imageUrl` holds a storage path, not a URL — it resolves
 * only through `src/lib/storage.ts`, and handing it to the browser would be
 * meaningless even if it were safe. This is the same arrangement
 * `/api/videos/[id]/narration` uses for audio, and for the same reason: the
 * object is resolved server-side behind the session, so there is no signed URL
 * to leak and no expiry to apologise for.
 *
 * Ownership is enforced in `StudioService.getThumbnailImagePath`, which scopes
 * the lookup through the version's video. A version belonging to another
 * operator therefore 404s exactly like one that does not exist.
 *
 * It lives under the page it serves rather than in `/api` because it exists
 * only for that page — the version id in the path is only ever obtained from
 * the gallery's own payload.
 *
 * Node runtime, not Edge: Prisma's query engine requires it.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ versionId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session) {
      throw new UnauthorizedError();
    }

    const { versionId } = await params;
    const objectPath = await studioService.getThumbnailImagePath(
      session.user.id,
      versionId,
    );

    // Same distinction the narration route draws: a row whose object is gone
    // is not "not found", it is a named state with an action attached —
    // regenerate the thumbnail — and `getObject` below would otherwise turn
    // it into a 500 that reads as a server bug.
    if ((await objectSizeBytes(objectPath)) === null) {
      throw new ConflictError(
        "This thumbnail's image is no longer in storage and needs to be regenerated.",
      );
    }

    const [body, contentType] = await Promise.all([
      getObject(objectPath),
      objectContentType(objectPath),
    ]);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        // The stored type, not an assumption: a composited thumbnail is JPEG
        // but `ThumbnailService`'s fallback path stores the image model's own
        // bytes, which are commonly PNG (see `detectImageFormat` there).
        "Content-Type": contentType ?? "image/jpeg",
        "Content-Length": String(body.byteLength),
        // A `ThumbnailVersion` is immutable once written — regenerating
        // appends a new row with a new id — so the browser may keep this for
        // the length of a session. `private` because it is the operator's
        // unpublished work and must never sit in a shared proxy.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json(error.serialize(), { status: error.httpStatus });
    }
    throw error;
  }
}
