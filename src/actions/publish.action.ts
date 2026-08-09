"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { publishService } from "@/services/publish.service";
import { requireSession } from "@/server/session";

export async function publishVideoAction(
  videoId: string,
): Promise<ActionResult<{ youtubeVideoId: string }>> {
  return run(async () => {
    const session = await requireSession();
    const result = await publishService.publish(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return result;
  });
}
