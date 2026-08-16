"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import {
  startEasyVideoSchema,
  suggestSubjectsSchema,
} from "@/schemas/easy-mode.schema";
import { requireSession } from "@/server/session";
import type { AutomationResult } from "@/services/automation.service";
import { easyModeService, type EasySuggestions } from "@/services/easy-mode.service";

/**
 * Easy mode's one button.
 *
 * A sibling of `startAutomationAction` rather than a flag on it, because the
 * two accept genuinely different payloads — this one has no project, no
 * variables and no duration by design (see easy-mode.schema.ts) — and folding
 * them together would mean one endpoint whose contract depended on a mode
 * field. Everything expensive is still `AutomationService.start` underneath, so
 * both buttons get the same readiness re-check, the same duplicate guard and
 * the same Gate 1 disclosure.
 *
 * The same two `revalidatePath` calls as the written form, for the same two
 * surfaces: the videos list gains a queued row, and a queued video completes
 * the last three steps of the dashboard's getting-started checklist at once.
 */
export async function startEasyVideoAction(
  input: unknown,
): Promise<ActionResult<AutomationResult>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = startEasyVideoSchema.parse(input);
    const result = await easyModeService.start(session.user.id, parsed);

    revalidatePath("/videos");
    revalidatePath("/dashboard");

    return result;
  });
}

/**
 * Asks a model for subjects this channel's niche suits.
 *
 * No `revalidatePath`: nothing is written. This produces suggestions the
 * operator may ignore, which is exactly why it is a separate, explicitly
 * pressed button — it costs one short model call, and the page it lives on is
 * free to open.
 *
 * `EasyModeService.suggest` never throws, so a provider outage arrives here as
 * a successful result carrying `error`. That is deliberate: `run()` would turn
 * a throw into a failed action and the UI would lose the subjects it already
 * had on screen, when the honest outcome is "the free ideas are still there,
 * the paid ones did not arrive".
 */
export async function suggestSubjectsAction(
  input: unknown,
): Promise<ActionResult<EasySuggestions>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = suggestSubjectsSchema.parse(input);

    return easyModeService.suggest(session.user.id, parsed.channelId);
  });
}
