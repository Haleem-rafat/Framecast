"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { startAutomationSchema } from "@/schemas/automation.schema";
import { requireSession } from "@/server/session";
import { automationService, type AutomationResult } from "@/services/automation.service";

/**
 * The guided flow's one button.
 *
 * Everything expensive or irreversible about this call lives in
 * `AutomationService.start` — the readiness check, the duplicate-submission
 * guard, and the automatic script approval — deliberately, so a second caller
 * (a CLI, a future scheduler) gets the identical guarantees rather than only
 * whatever this action layer happened to check. This does what every other
 * action in the codebase does and no more: scope the call to the signed-in
 * user, validate the payload, and funnel the result through `run()` so a
 * provider's raw message can never reach the browser unserialised.
 *
 * `revalidatePath` covers the two server-rendered surfaces this changes: the
 * videos list gains a queued row, and the dashboard's stats and getting-started
 * checklist both move (a video that queues completes the last three checklist
 * steps at once).
 */
export async function startAutomationAction(
  input: unknown,
): Promise<ActionResult<AutomationResult>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = startAutomationSchema.parse(input);
    const result = await automationService.start(session.user.id, parsed);

    revalidatePath("/videos");
    revalidatePath("/dashboard");

    return result;
  });
}
