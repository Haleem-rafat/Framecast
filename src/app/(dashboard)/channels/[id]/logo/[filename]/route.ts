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
import { logoFilenameSchema } from "@/schemas/channel.schema";
import { getSession } from "@/server/session";
import { channelService } from "@/services/channel.service";

/**
 * Streams one of a channel's logo objects so the branding screen can show it.
 *
 * `ChannelBrand.logoPath` holds a storage path, not a URL — it resolves only
 * through `src/lib/storage.ts` — so the same arrangement the thumbnail gallery
 * uses applies here: the object is resolved server-side behind the session,
 * and there is no signed URL to leak and no expiry to apologise for.
 *
 * Keyed on the *filename* rather than on the channel alone, and that is what
 * makes the cache header below honest. A channel's logo is mutable — choosing
 * a new one overwrites `logoPath` — so `/channels/{id}/logo` would be a URL
 * whose bytes change while the browser is told to keep them for an hour. Every
 * generated object carries its batch token and index in its name
 * (`logo-3f9c1a04-2.png`, see `LogoService.generateOptions`), so a per-filename
 * URL is immutable in the way `Cache-Control` needs. It also lets the screen
 * show the options from a batch, which are not in the database at all — only
 * the chosen one is.
 *
 * Ownership is proven against the channel before anything is read, and the
 * path is *rebuilt* from the id and the filename rather than accepted:
 * `storagePath` refuses `/` and `..`, so a request cannot climb out of this
 * channel's own `logos` prefix even though the filename comes from the URL.
 * A channel belonging to another operator 404s exactly like one that does not
 * exist, because `ChannelService.get` scopes its query by `userId`.
 *
 * It lives under the page it serves rather than in `/api` because it exists
 * only for that page, the same as the thumbnail image route.
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

    // Throws `NotFoundError` for a foreign or invented channel, which is the
    // 404 this route wants — and it happens before the filename is used for
    // anything, so an unowned id never reaches storage.
    await channelService.get(session.user.id, id);

    // `safeParse`, and a `NotFoundError` rather than the schema's own issue.
    // A ZodError is not an `AppError`, so `.parse` here would escape the
    // handler below and answer 500 — which is what a request for
    // `../../../etc/passwd` got before this line said otherwise. Nothing is
    // served either way (`storagePath` refuses the same shapes), but a
    // traversal attempt is a request for a logo this channel does not have,
    // and 404 is what that is.
    const parsed = logoFilenameSchema.safeParse(filename);

    if (!parsed.success) {
      throw new NotFoundError("Logo");
    }

    const objectPath = storagePath(id, "logos", parsed.data);

    // The same distinction the thumbnail route draws: a chosen logo whose
    // object has gone is a named state with an action attached — generate
    // another — rather than a 500 out of `getObject` that reads as a bug.
    if ((await objectSizeBytes(objectPath)) === null) {
      throw new ConflictError(
        "This logo is no longer in storage. Generate a new set of options.",
      );
    }

    const [body, contentType] = await Promise.all([
      getObject(objectPath),
      objectContentType(objectPath),
    ]);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        // The stored type rather than an assumption, exactly as the thumbnail
        // route does. Logos are written as `image/png` by `LogoService`, and
        // the fallback says so rather than guessing something else.
        "Content-Type": contentType ?? "image/png",
        "Content-Length": String(body.byteLength),
        // Immutable per filename — see the note above on why the URL is keyed
        // this way. `private` because it is the operator's unpublished work
        // and must never sit in a shared proxy.
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
