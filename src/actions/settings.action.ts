"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import {
  updateSettingsSchema,
  updateThemeSchema,
} from "@/schemas/settings.schema";
import { requireSession } from "@/server/session";
import { settingsService } from "@/services/settings.service";

export async function updateSettingsAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updateSettingsSchema.parse(input);
    await settingsService.update(session.user.id, parsed);

    revalidatePath("/settings");

    return null;
  });
}

/**
 * What the top-bar theme toggle calls, so a choice made there follows the
 * operator to another browser instead of living only in that browser's
 * `localStorage`.
 *
 * The toggle has already applied the theme locally by the time this runs — the
 * write is a background sync, not the thing that makes the click work, which is
 * why the caller ignores the result and why a failure is silent there.
 *
 * Only /settings is revalidated, even though the dashboard layout reads this
 * column too. Every studio route is server-rendered on demand, so there is no
 * cached shell holding a stale theme — a fresh load re-reads the row anyway,
 * and the current tab has already changed theme without help. What *would* be
 * stale is the settings form's own Theme select, which displays the column, so
 * that one page is dropped from the client router cache. Revalidating the root
 * layout instead would invalidate the static marketing pages as well, for a
 * click that cannot possibly have changed them.
 */
export async function updateThemeAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const { theme } = updateThemeSchema.parse(input);
    await settingsService.updateTheme(session.user.id, theme);

    revalidatePath("/settings");

    return null;
  });
}
