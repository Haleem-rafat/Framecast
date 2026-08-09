"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { requireSession } from "@/server/session";
import {
  scriptService,
  type GenerateScriptInput,
} from "@/services/script.service";

export async function generateScriptAction(
  videoId: string,
  input: GenerateScriptInput,
): Promise<ActionResult<Awaited<ReturnType<typeof scriptService.generate>>>> {
  return run(async () => {
    const session = await requireSession();
    const version = await scriptService.generate(session.user.id, videoId, input);

    revalidatePath(`/videos/${videoId}`);

    return version;
  });
}

export async function saveScriptEditAction(
  videoId: string,
  content: string,
): Promise<ActionResult<Awaited<ReturnType<typeof scriptService.saveEdit>>>> {
  return run(async () => {
    const session = await requireSession();
    const version = await scriptService.saveEdit(session.user.id, videoId, content);

    revalidatePath(`/videos/${videoId}`);

    return version;
  });
}

export async function setActiveVersionAction(
  videoId: string,
  versionId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await scriptService.setActiveVersion(session.user.id, videoId, versionId);

    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}
