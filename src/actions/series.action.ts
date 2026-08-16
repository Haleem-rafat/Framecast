"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createSeriesSchema, updateSeriesSchema } from "@/schemas/series.schema";
import { requireSession } from "@/server/session";
import { seriesService, type SeriesRunResult } from "@/services/series.service";

/**
 * The series surface's write path.
 *
 * Every guard that matters — ownership, that the project publishes to the named
 * channel, that the script style is the operator's own and is a SCRIPT prompt,
 * that the stored answers satisfy it — lives in `SeriesService`, not here. A
 * server action is a public endpoint reachable by a hand-crafted POST with no
 * UI in front of it, and the worker reaches the same behaviour through
 * `ScheduleService` with no action layer at all. These functions do what every
 * other action in this codebase does and no more: scope to the signed-in user,
 * parse the payload, and funnel the result through `run()` so a driver message
 * can never reach the browser.
 *
 * The topic queue has no actions here on purpose. It is a `ScheduleTopic` list
 * on a real `Schedule`, and `addScheduleTopicsAction` /
 * `removeScheduleTopicAction` already manage it correctly — the series page
 * passes them the schedule id and reuses the same component.
 */

const LIST_PATH = "/automation/series";

function revalidateSeries(id?: string): void {
  revalidatePath(LIST_PATH);

  if (id) {
    revalidatePath(`${LIST_PATH}/${id}`);
  }
}

export async function createSeriesAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createSeriesSchema.parse(input);
    const created = await seriesService.create(session.user.id, parsed);

    revalidateSeries(created.id);

    return created;
  });
}

export async function updateSeriesAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updateSeriesSchema.parse(input);
    await seriesService.update(session.user.id, id, parsed);

    revalidateSeries(id);

    return null;
  });
}

/** Pausing has to take effect on the very next due-check, so it is a plain
 *  status write with nothing queued behind it — see `ScheduleService.pause` for
 *  what it can and cannot recall. */
export async function pauseSeriesAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await seriesService.pause(session.user.id, id, "Paused by the operator.");

    revalidateSeries(id);

    return null;
  });
}

export async function resumeSeriesAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await seriesService.resume(session.user.id, id);

    revalidateSeries(id);

    return null;
  });
}

export async function deleteSeriesAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await seriesService.remove(session.user.id, id);

    revalidateSeries(id);

    return null;
  });
}

/**
 * "Make one now": one action that applies the whole recipe.
 *
 * `/videos` is revalidated as well as the series pages, because unlike every
 * other action in this file this one actually produces a video — the operator
 * lands back on a list that has to include it. `/automation/schedules` is not:
 * this run is not an occurrence of the cadence and writes no `ScheduleRun`.
 */
export async function generateFromSeriesAction(
  id: string,
): Promise<ActionResult<SeriesRunResult>> {
  return run(async () => {
    const session = await requireSession();
    const result = await seriesService.generateNow(session.user.id, id);

    revalidateSeries(id);
    revalidatePath("/videos");

    return result;
  });
}
