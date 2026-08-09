"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { upsertPromptSchema } from "@/schemas/prompt.schema";
import { requireSession } from "@/server/session";
import { promptTemplateService } from "@/services/prompt-template.service";

export async function createPromptAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = upsertPromptSchema.parse(input);
    const template = await promptTemplateService.create(session.user.id, parsed);

    revalidatePath("/prompts");

    return { id: template.id };
  });
}

export async function updatePromptAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = upsertPromptSchema.parse(input);
    await promptTemplateService.update(session.user.id, id, parsed);

    revalidatePath("/prompts");

    return null;
  });
}

export async function removePromptAction(
  id: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await promptTemplateService.remove(session.user.id, id);

    revalidatePath("/prompts");

    return null;
  });
}
