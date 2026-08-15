"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { publishVideoSchema } from "@/schemas/publish.schema";
import { publishService, type ShortPublishOutcome } from "@/services/publish.service";
import { requireSession } from "@/server/session";

/**
 * Gate 2's server half.
 *
 * Visibility is now the operator's, taken from the dialog's picker and parsed
 * here rather than assumed: this action used to pin every upload to
 * `UNLISTED` — a placeholder that stood in for the picker that did not exist —
 * which meant every video an operator published was findable only by someone
 * already holding its link. No search, no browse, no recommendations.
 *
 * `includeShorts` is the dialog's second question, and it is the reason shorts
 * can reach YouTube at all — they could not, by construction, until this
 * landed (see the `ShortStatus` comment in schema.prisma). It arrives here as
 * an explicit `false` from an unticked box, and `publishVideoSchema` defaults
 * it to `false` for anything that omits it, so the only way a short is
 * uploaded is a request that says so.
 *
 * Nothing about either field makes a second publish easier. The claim that
 * makes publishing one-shot lives in `publishService.publish` (a `create()` on
 * the `@unique` `Publication.videoId`, taken before a single byte is sent, and
 * a `ShortPublication.shortId` claim per short taken the same way), and it is
 * unchanged and unreachable from here — a caller that sends a different
 * visibility for a video that already has a Publication row still gets the
 * same `ConflictError` as one that sends the same visibility. Nor does
 * anything call this on a schedule: `/automation` and the schedules stop at a
 * READY video on purpose, and this action still runs only from a click.
 *
 * The shorts' outcomes come back one per short rather than folded into a
 * single verdict. A publish where the video and two of three clips went up is
 * neither a success nor a failure, and the dialog has to be able to say which
 * clip did not make it and why.
 */
export async function publishVideoAction(
  videoId: string,
  input: unknown,
): Promise<
  ActionResult<{ youtubeVideoId: string; shorts: ShortPublishOutcome[] }>
> {
  return run(async () => {
    const session = await requireSession();
    const { visibility, includeShorts } = publishVideoSchema.parse(input);

    const result = await publishService.publish(session.user.id, videoId, {
      visibility,
      includeShorts,
    });

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return result;
  });
}
