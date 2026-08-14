"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { publishVideoSchema } from "@/schemas/publish.schema";
import { publishService } from "@/services/publish.service";
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
 * Nothing about this makes a second publish easier. The claim that makes
 * publishing one-shot lives in `publishService.publish` (a `create()` on the
 * `@unique` `Publication.videoId`, taken before a single byte is sent), and it
 * is unchanged and unreachable from here — a caller that sends a different
 * visibility for a video that already has a Publication row still gets the
 * same `ConflictError` as one that sends the same visibility. Nor does
 * anything call this on a schedule: `/automation` and the schedules stop at a
 * READY video on purpose, and this action still runs only from a click.
 */
export async function publishVideoAction(
  videoId: string,
  input: unknown,
): Promise<ActionResult<{ youtubeVideoId: string }>> {
  return run(async () => {
    const session = await requireSession();
    const { visibility } = publishVideoSchema.parse(input);

    const result = await publishService.publish(session.user.id, videoId, {
      visibility,
    });

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return result;
  });
}
