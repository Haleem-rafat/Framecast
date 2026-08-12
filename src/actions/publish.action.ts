"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { publishService } from "@/services/publish.service";
import { requireSession } from "@/server/session";

/**
 * A deliberate placeholder, not a permanent default.
 *
 * `publish.service.ts` used to hard-code `unlisted` inside `uploadToYouTube`;
 * it now takes visibility from the caller and defaults to `PRIVATE` when
 * nobody asks — the right default for a service, since nothing leaks publicly
 * by omission. This action is the one caller that cannot yet ask, because no
 * visibility picker exists in the UI: `publish-video-button.tsx` states the
 * upload's visibility as a fact the operator is confirming, not as a choice
 * they are making.
 *
 * Passing `UNLISTED` explicitly keeps that copy true and keeps the behaviour
 * the operator already relies on. The alternative — letting the service
 * default apply — would silently change every publish from "anyone with the
 * link can watch it" to "nobody but me can", while the dialog kept promising a
 * shareable link, for an action that cannot be undone from this app.
 *
 * Delete this constant when the picker ships and pass the operator's actual
 * choice through instead. Until then, whoever changes this line must change
 * `UPLOAD_VISIBILITY_NOTE` and the success toast in `publish-video-button.tsx`
 * in the same edit.
 */
const PLACEHOLDER_VISIBILITY = "UNLISTED" as const;

export async function publishVideoAction(
  videoId: string,
): Promise<ActionResult<{ youtubeVideoId: string }>> {
  return run(async () => {
    const session = await requireSession();
    const result = await publishService.publish(session.user.id, videoId, {
      visibility: PLACEHOLDER_VISIBILITY,
    });

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return result;
  });
}
