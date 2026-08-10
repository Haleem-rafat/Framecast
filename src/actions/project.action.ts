"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createProjectSchema } from "@/schemas/project.schema";
import { requireSession } from "@/server/session";
import { projectService } from "@/services/project.service";

export async function createProjectAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createProjectSchema.parse(input);
    const project = await projectService.create(session.user.id, parsed);

    revalidatePath("/projects");

    return { id: project.id };
  });
}

export async function updateProjectAction(
  id: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createProjectSchema.parse(input);
    await projectService.update(session.user.id, id, parsed);

    revalidatePath("/projects");

    return null;
  });
}

export async function archiveProjectAction(
  id: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await projectService.archive(session.user.id, id);

    revalidatePath("/projects");

    return null;
  });
}

/**
 * Soft-deletes a project and its videos. `projectService.remove` refuses
 * outright if any of those videos is actively leased, rather than deleting the
 * rest — a partially-deleted project is harder to reason about than a clear
 * refusal. It reports how many videos went with it so the confirmation can say
 * so afterwards.
 */
export async function deleteProjectAction(
  projectId: string,
): Promise<ActionResult<{ deletedVideoCount: number }>> {
  return run(async () => {
    const session = await requireSession();
    const result = await projectService.remove(session.user.id, projectId);

    revalidatePath("/projects");
    revalidatePath("/videos");

    return result;
  });
}
