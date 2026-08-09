"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createVideoSchema } from "@/schemas/video.schema";
import { requireSession } from "@/server/session";
import type { PipelineState } from "@/services/pipeline.service";
import { pipelineService } from "@/services/pipeline.service";
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

/**
 * Polled by the pipeline panel every couple of seconds while a render is
 * active (see pipeline-panel.tsx). No `revalidatePath` here — this is a read,
 * not a mutation, and Next's cache has nothing stale to invalidate.
 */
export async function getPipelineStateAction(
  videoId: string,
): Promise<ActionResult<PipelineState>> {
  return run(async () => {
    const session = await requireSession();
    return pipelineService.getState(session.user.id, videoId);
  });
}
