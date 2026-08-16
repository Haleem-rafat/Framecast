import { NextResponse, type NextRequest } from "next/server";

import {
  ConflictError,
  isAppError,
  NotFoundError,
  UnauthorizedError,
} from "@/lib/errors";
import {
  getObject,
  objectContentType,
  objectSizeBytes,
  storagePath,
} from "@/lib/storage";
import { characterSheetFilenameSchema } from "@/schemas/channel.schema";
import { getSession } from "@/server/session";
import { channelService } from "@/services/channel.service";

/**
 * Streams a channel's character sheet so the branding screen can show it.
 *
 * The logo route next door, applied to the other per-channel image, and every
 * decision in it holds here for the same reasons: the object is resolved
 * server-side behind the session so there is no signed URL to leak; the path is
 * *rebuilt* from the channel id and the filename rather than accepted, so
 * `storagePath`'s refusal of `/` and `..` pins the request inside this
 * channel's own prefix; and a foreign channel 404s exactly like an invented one
 * because `ChannelService.get` scopes by `userId`.
 *
 * Keyed on the filename rather than the channel, which is what makes the
 * hour-long cache honest — regenerating writes a new `sheet-<token>.png` rather
 * than overwriting, so any URL the browser is holding keeps resolving to the
 * picture it was already showing.
 *
 * Node runtime, not Edge: Prisma's query engine requires it.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string; filename: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session) {
      throw new UnauthorizedError();
    }

    const { id, filename } = await params;

    // Throws `NotFoundError` for a foreign or invented channel, before the
    // filename is used for anything.
    await channelService.get(session.user.id, id);

    // `safeParse` and a `NotFoundError`, not `.parse`: a ZodError is not an
    // `AppError` and would escape the handler below as a 500. A traversal
    // attempt is a request for a sheet this channel does not have.
    const parsed = characterSheetFilenameSchema.safeParse(filename);

    if (!parsed.success) {
      throw new NotFoundError("Character sheet");
    }

    const objectPath = storagePath(id, "characters", parsed.data);

    // A recorded sheet whose object has gone is a named state with an action
    // attached rather than a 500 out of `getObject` that reads as a bug — and
    // it matters more here than for a logo, because every illustrated video
    // this channel makes reads this same object.
    if ((await objectSizeBytes(objectPath)) === null) {
      throw new ConflictError(
        "This character sheet is no longer in storage. Generate a new one.",
      );
    }

    const [body, contentType] = await Promise.all([
      getObject(objectPath),
      objectContentType(objectPath),
    ]);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType ?? "image/png",
        "Content-Length": String(body.byteLength),
        // Immutable per filename. `private` because it is the operator's
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
