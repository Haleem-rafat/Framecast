"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { shortsService, type ShortSummary } from "@/services/shorts.service";

/**
 * Picks the moments and queues them. Deliberately returns as soon as the model
 * has answered rather than waiting for the encodes: the worker renders them,
 * and the panel polls. A server action that waited would hold a request open
 * for the length of three encodes and time out behind any proxy in front of
 * the app.
 */
export async function generateShortsAction(
  videoId: string,
): Promise<ActionResult<ShortSummary[]>> {
  return run(async () => {
    const session = await requireSession();
    const shorts = await shortsService.generate(session.user.id, videoId);

    revalidatePath(`/videos/${videoId}`);

    return shorts;
  });
}

/** The panel's poll while anything is still queued or rendering. Reads only —
 *  no `revalidatePath`, which would defeat the point by re-rendering the whole
 *  route every two seconds. */
export async function listShortsAction(
  videoId: string,
): Promise<ActionResult<ShortSummary[]>> {
  return run(async () => {
    const session = await requireSession();
    return shortsService.list(session.user.id, videoId);
  });
}
