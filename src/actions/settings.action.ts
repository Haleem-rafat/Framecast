"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { updateSettingsSchema } from "@/schemas/settings.schema";
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
