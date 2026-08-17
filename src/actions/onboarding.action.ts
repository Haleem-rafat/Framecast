"use server";

import { z } from "zod";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import { onboardingService } from "@/services/onboarding.service";

/**
 * The two writes onboarding makes, and both are about *not* showing something.
 *
 * Deliberately no `revalidatePath`. Every one of these calls happens after the
 * browser has already hidden (or re-shown) the thing — the surface is client
 * state that was seeded from the server, so the write is a background sync and
 * a revalidation would only re-render the page the operator is standing on to
 * tell it what it already did. The same reasoning `updateThemeAction` gives for
 * revalidating one page and not the layout, taken one step further, because
 * there is no second surface displaying this value.
 */

/**
 * Keys are a closed vocabulary in the code but arrive here as a string from a
 * client component, so they are length-capped rather than trusted. The set is
 * an unbounded array on one row; without a cap, a hand-crafted POST could grow
 * it until the row stopped fitting.
 */
const dismissSchema = z.object({
  key: z.string().min(1).max(64),
});

const restoreSchema = z.object({
  /** Absent means "all of it" — what "replay onboarding" does. */
  keys: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export async function dismissOnboardingAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const { key } = dismissSchema.parse(input);

    await onboardingService.dismiss(session.user.id, key);

    return null;
  });
}

export async function restoreOnboardingAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const { keys } = restoreSchema.parse(input);

    await onboardingService.restore(session.user.id, keys);

    return null;
  });
}
