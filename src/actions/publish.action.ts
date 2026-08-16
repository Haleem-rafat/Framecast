"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { publishVideoSchema } from "@/schemas/publish.schema";
import {
  publishService,
  type ShortPublishOutcome,
  type ThumbnailOutcome,
} from "@/services/publish.service";
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
 * `channelId` is the dialog's third question, and the one that used never to be
 * asked at all: the upload went wherever the video's project pointed, which is
 * how a video filed under the wrong project could only be corrected by moving
 * the project — the very edit that used to redirect every series filed under it
 * without saying so. It arrives seeded with the video's own channel, so the
 * common case sends what the service would have derived anyway, and the service
 * re-checks ownership, usability and series agreement regardless of what a
 * hand-made request claims.
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
  ActionResult<{
    youtubeVideoId: string;
    shorts: ShortPublishOutcome[];
    thumbnail: ThumbnailOutcome;
  }>
> {
  return run(async () => {
    const session = await requireSession();
    const { visibility, includeShorts, channelId } = publishVideoSchema.parse(input);

    const result = await publishService.publish(session.user.id, videoId, {
      visibility,
      includeShorts,
      channelId,
    });

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);
    // A publish to a channel other than the video's own refiles the video into
    // a project on that channel (see `publishService.publish`), so the projects
    // page's video counts and the videos list's project column are both stale
    // the moment this returns.
    revalidatePath("/projects");

    return result;
  });
}

/**
 * Re-attaches a published video's thumbnail, and the one publish-path action
 * that is safe to press twice.
 *
 * Nothing about this weakens Gate 2. The one-shot rule exists because
 * `videos.insert` cannot be undone, so a second publish would put a second
 * copy of the video on the channel; `thumbnails.set` replaces rather than
 * adds, costs 50 units against a different allowance from the daily upload
 * count, and is idempotent with the same image. `publishService.retryThumbnail`
 * therefore reads the `Publication` row rather than claiming one, and refuses
 * only the two cases where a retry means nothing — a video that is not on
 * YouTube, and a thumbnail that is already attached. It cannot start an upload:
 * there is no path from here to `videos.insert` at all.
 *
 * Takes no input beyond the video id on purpose. The image is whichever
 * `ThumbnailVersion` is active at the moment it runs, so regenerating the
 * thumbnail and retrying does the obvious thing without this action needing to
 * know that a regeneration happened.
 */
export async function retryThumbnailAction(
  videoId: string,
): Promise<ActionResult<ThumbnailOutcome>> {
  return run(async () => {
    const session = await requireSession();

    const outcome = await publishService.retryThumbnail(session.user.id, videoId);

    revalidatePath(`/videos/${videoId}`);

    return outcome;
  });
}
