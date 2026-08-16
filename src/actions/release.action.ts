"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import {
  createReleaseCadenceSchema,
  updateReleaseCadenceSchema,
} from "@/schemas/release.schema";
import { requireSession } from "@/server/session";
import { releaseService } from "@/services/release.service";

/**
 * The shorts drip's write path.
 *
 * Every guard that matters — ownership, whether the channel is still connected,
 * whether this channel already has a cadence — lives in `ReleaseService`, not
 * here, and deliberately: a server action is a public endpoint reachable by a
 * hand-crafted POST with no UI in front of it, and the worker calls the same
 * service with no action layer at all. These functions do what every other
 * action in this codebase does and no more: scope to the signed-in user, parse
 * the payload, and funnel the result through `run()` so a driver message can
 * never reach the browser.
 *
 * Note what is missing: there is no "release one now" action. The whole point
 * of a drip is *when* a clip goes out, and an out-of-band release is the one
 * thing that cannot be taken back — an upload has no undo from this app. An
 * operator who wants a clip up immediately already has the publish dialog on
 * the video it came from.
 */

const LIST_PATH = "/automation/releases";

function revalidateCadence(id?: string): void {
  revalidatePath(LIST_PATH);

  if (id) {
    revalidatePath(`${LIST_PATH}/${id}`);
  }
}

export async function createReleaseCadenceAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createReleaseCadenceSchema.parse(input);
    const created = await releaseService.create(session.user.id, parsed);

    revalidateCadence(created.id);

    return created;
  });
}

export async function updateReleaseCadenceAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updateReleaseCadenceSchema.parse(input);
    await releaseService.update(session.user.id, id, parsed);

    revalidateCadence(id);

    return null;
  });
}

/**
 * Pausing has to take effect on the very next due-check, so it is a plain
 * status write with nothing queued behind it — see `ReleaseService.pause` for
 * what it can and cannot recall.
 */
export async function pauseReleaseCadenceAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await releaseService.pause(session.user.id, id, "Paused by the operator.");

    revalidateCadence(id);

    return null;
  });
}

export async function resumeReleaseCadenceAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await releaseService.resume(session.user.id, id);

    revalidateCadence(id);

    return null;
  });
}

export async function deleteReleaseCadenceAction(id: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await releaseService.remove(session.user.id, id);

    revalidateCadence(id);

    return null;
  });
}
