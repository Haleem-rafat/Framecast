"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import {
  addScheduleTopicsSchema,
  createScheduleSchema,
  updateScheduleSchema,
} from "@/schemas/schedule.schema";
import { requireSession } from "@/server/session";
import { scheduleService } from "@/services/schedule.service";

/**
 * The schedule surface's write path.
 *
 * Every guard that matters — ownership, project usability, whether the
 * operator's prompt can actually be rendered from the stored answers — lives in
 * `ScheduleService`, not here, deliberately: a server action is a public
 * endpoint reachable by a hand-crafted POST with no UI in front of it, and the
 * worker calls the same service with no action layer at all. These functions do
 * what every other action in this codebase does and no more: scope to the
 * signed-in user, parse the payload, and funnel the result through `run()` so a
 * driver message can never reach the browser.
 *
 * `revalidatePath` covers `/automation/schedules` (the list) and the detail
 * route, which are the only server-rendered surfaces these change. Nothing here
 * touches `/videos` or `/dashboard`: creating a schedule produces no video, and
 * the run that eventually does happens in the worker, where `revalidatePath`
 * has no meaning.
 */

const LIST_PATH = "/automation/schedules";

function revalidateSchedule(id?: string): void {
  revalidatePath(LIST_PATH);

  if (id) {
    revalidatePath(`${LIST_PATH}/${id}`);
  }
}

export async function createScheduleAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createScheduleSchema.parse(input);
    const created = await scheduleService.create(session.user.id, parsed);

    revalidateSchedule(created.id);

    return created;
  });
}

export async function updateScheduleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updateScheduleSchema.parse(input);
    await scheduleService.update(session.user.id, id, parsed);

    revalidateSchedule(id);

    return null;
  });
}

/**
 * Pausing has to take effect on the very next due-check, so it is a plain
 * status write with nothing queued behind it — see `ScheduleService.pause` for
 * what it can and cannot recall.
 */
export async function pauseScheduleAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await scheduleService.pause(session.user.id, id, "Paused by the operator.");

    revalidateSchedule(id);

    return null;
  });
}

export async function resumeScheduleAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await scheduleService.resume(session.user.id, id);

    revalidateSchedule(id);

    return null;
  });
}

export async function deleteScheduleAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await scheduleService.remove(session.user.id, id);

    revalidateSchedule(id);

    return null;
  });
}

export async function addScheduleTopicsAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ added: number }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = addScheduleTopicsSchema.parse(input);
    const result = await scheduleService.addTopics(session.user.id, id, parsed);

    revalidateSchedule(id);

    return result;
  });
}

export async function removeScheduleTopicAction(
  id: string,
  topicId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await scheduleService.removeTopic(session.user.id, id, topicId);

    revalidateSchedule(id);

    return null;
  });
}
