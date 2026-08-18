"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { shortCountSchema } from "@/schemas/video.schema";
import { requireSession } from "@/server/session";
import { shortsService, type ShortSummary } from "@/services/shorts.service";

/**
 * Picks the moments and queues them. Deliberately returns as soon as the model
 * has answered rather than waiting for the encodes: the worker renders them,
 * and the panel polls. A server action that waited would hold a request open
 * for the length of three encodes and time out behind any proxy in front of
 * the app.
 *
 * `count` is validated here rather than trusted from the panel for the reason
 * every count reaching a queue is: this one decides how much money and how many
 * worker minutes one click spends. See `shortCountSchema`.
 *
 * Generation stays something an operator asks for. `scheduleService` and
 * `autoPublishService` never call `shortsService` at all, and that is the
 * split, not an omission: the automated half is `ReleaseCadence`, which drips
 * shorts an operator has already watched, out of a bank an operator already
 * chose to fill. Wiring generation into either of them would put seven uploads
 * on a real channel out of a run nobody looked at — and raising the count makes
 * that worse, not better, which is exactly why the count arrives from a click.
 */
export async function generateShortsAction(
  videoId: string,
  count?: number,
): Promise<ActionResult<ShortSummary[]>> {
  return run(async () => {
    const session = await requireSession();

    // Passed through as `undefined` when the caller omitted it, so the service's
    // own default parameter is what answers "how many" — one number, in one
    // place, rather than a copy of it here that could drift.
    const shorts = await shortsService.generate(
      session.user.id,
      videoId,
      shortCountSchema.optional().parse(count),
    );

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
