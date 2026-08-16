"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createProjectSchema, mergeProjectsSchema } from "@/schemas/project.schema";
import { requireSession } from "@/server/session";
import {
  type MergeImpact,
  type MergeResult,
  projectService,
} from "@/services/project.service";

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
    // `/videos` too: its new-video picker is `projectService.list` filtered to
    // `ACTIVE`, so the whole visible effect of archiving lands on that page.
    // Without this the archived project keeps offering itself as a target
    // until something else happens to revalidate it.
    revalidatePath("/videos");

    return null;
  });
}

/** Restores an archived project to `ACTIVE`. See `projectService.unarchive`. */
export async function unarchiveProjectAction(
  id: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await projectService.unarchive(session.user.id, id);

    revalidatePath("/projects");
    revalidatePath("/videos");

    return null;
  });
}

/**
 * Counts for the delete confirmation, fetched when the dialog opens rather
 * than carried in the page's row data — see `projectService.deletionImpact`
 * for why the mid-render count has to be read late to be worth anything.
 */
export async function projectDeletionImpactAction(
  id: string,
): Promise<
  ActionResult<{
    videoCount: number;
    publishedCount: number;
    activeRenderCount: number;
  }>
> {
  return run(async () => {
    const session = await requireSession();

    return projectService.deletionImpact(session.user.id, id);
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

/**
 * What a merge would move and every reason it would be refused, fetched when
 * the dialog opens and again whenever the operator changes which project
 * survives. Same reasoning as `projectDeletionImpactAction`: the counts and
 * the refusals have to be read late to be worth anything.
 */
export async function projectMergeImpactAction(
  input: unknown,
): Promise<ActionResult<MergeImpact>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = mergeProjectsSchema.parse(input);

    return projectService.mergeImpact(session.user.id, parsed);
  });
}

/**
 * Folds the source projects into the target and soft-deletes them. Everything
 * filed under a source — videos, schedules and series alike — moves in one
 * transaction; see `projectService.merge` for why a cross-channel merge is
 * refused outright rather than acknowledged.
 */
export async function mergeProjectsAction(
  input: unknown,
): Promise<ActionResult<MergeResult>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = mergeProjectsSchema.parse(input);
    const result = await projectService.merge(session.user.id, parsed);

    revalidatePath("/projects");
    // Videos change which project they are filed under, and schedules and
    // series change which project they file *into* — so every page that names
    // a project is stale.
    revalidatePath("/videos");
    revalidatePath("/automation");

    return result;
  });
}
