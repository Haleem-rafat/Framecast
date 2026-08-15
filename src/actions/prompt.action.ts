"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { upsertPromptSchema } from "@/schemas/prompt.schema";
import { requireSession } from "@/server/session";
import {
  promptTemplateService,
  type AddedScriptStyle,
} from "@/services/prompt-template.service";

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

/**
 * Adds a built-in style from the browse surface to the operator's own library.
 *
 * Takes the catalogue's style id and nothing else — the content, name,
 * description and variables all come from `SCRIPT_STYLES` server-side, so no
 * request can post prompt text through here and have it stored as though the
 * app shipped it. A second add of a style the operator already has is refused
 * by the service with a sentence naming it (see `addScriptStyle`).
 */
export async function addScriptStyleAction(
  styleId: string,
): Promise<ActionResult<AddedScriptStyle>> {
  return run(async () => {
    const session = await requireSession();
    const added = await promptTemplateService.addScriptStyle(
      session.user.id,
      styleId,
    );

    revalidatePath("/prompts");

    return added;
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
