"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createVideoSchema } from "@/schemas/video.schema";
import { requireSession } from "@/server/session";
import { videoService } from "@/services/video.service";

export async function createVideoAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createVideoSchema.parse(input);
    const video = await videoService.create(session.user.id, parsed);

    revalidatePath("/videos");

    return { id: video.id };
  });
}

export async function approveScriptAction(
  videoId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await videoService.approveScript(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}
