"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import {
  approveScriptSchema,
  createVideoSchema,
  deleteVideosSchema,
} from "@/schemas/video.schema";
import { requireSession } from "@/server/session";
import { jobService } from "@/services/job.service";
import type { PipelineLogStream, PipelineState } from "@/services/pipeline.service";
import { pipelineService } from "@/services/pipeline.service";
import { videoService } from "@/services/video.service";

export async function createVideoAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createVideoSchema.parse(input);
    const video = await videoService.create(session.user.id, parsed);

    revalidatePath("/videos");

    return { id: video.id };
  });
}

/**
 * Gate 1, and the one place a video's output format is decided.
 *
 * `input` is parsed rather than taken at its word: it arrives from a dialog,
 * and the value it carries is what the renderer will spend narration quota and
 * a full encode producing. An unparseable one is a rejected action, not a
 * silent fall back to landscape — an operator who asked for a short and got a
 * nine-minute widescreen video would only find out after paying for it.
 */
export async function approveScriptAction(
  videoId: string,
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const { format } = approveScriptSchema.parse(input);
    await videoService.approveScript(session.user.id, videoId, format);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}

/**
 * Run (on an idle, already-approved video) or Retry (on a retryable
 * `FAILED` one) from `pipeline-panel.tsx`. Both just flip `status` back to
 * `QUEUED` and clear the lease — `JobService.requeue`'s conditional update is
 * the only thing guarding against two rapid clicks double-queuing the same
 * video, so this action does nothing more than scope the call to the caller
 * and funnel the result through `run()`.
 */
export async function startPipelineAction(videoId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await jobService.start(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}

/**
 * Retry — like `startPipelineAction`, but resets `attempts` to 0 first. The
 * operator has presumably fixed whatever failed; `MAX_ATTEMPTS` exists to
 * stop the worker's own automatic reclaiming from looping forever, not to
 * stop a human trying again on purpose.
 */
export async function retryPipelineAction(videoId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await jobService.retry(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}

/**
 * Cancel a video that's actively being processed. Only ever a request — the
 * worker owns the FFmpeg child process, so it can only be stopped from
 * inside the worker's own heartbeat loop (see `JobService.requestCancel`);
 * this just flags it.
 */
export async function cancelPipelineAction(videoId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await jobService.requestCancel(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}

/**
 * Polled by the pipeline panel — every couple of seconds while something is
 * actually running, far more slowly while idle-`QUEUED` with nothing to
 * watch, not at all once terminal (see pipeline-panel.tsx's `isActive`/
 * `isTerminal`-driven interval). No `revalidatePath` here — this is a read,
 * not a mutation, and Next's cache has nothing stale to invalidate.
 */
export async function getPipelineStateAction(
  videoId: string,
): Promise<ActionResult<PipelineState>> {
  return run(async () => {
    const session = await requireSession();
    return pipelineService.getState(session.user.id, videoId);
  });
}

/**
 * Polled by the log stream, gated on the same `isActive` signal the pipeline
 * panel already computes (see `use-pipeline-state.ts`) rather than a second,
 * independently-tuned interval — while active it tracks the same 2s cadence;
 * once idle-`QUEUED` or terminal it stops, since a merged three-table fetch
 * is not something to pay for on every idle tick.
 */
export async function getPipelineLogsAction(
  videoId: string,
): Promise<ActionResult<PipelineLogStream>> {
  return run(async () => {
    const session = await requireSession();
    return pipelineService.getLogStream(session.user.id, videoId);
  });
}

/**
 * Soft-deletes one video. `videoService.remove` refuses while a worker holds
 * the lease — see its doc comment for why deleting a row mid-render is a
 * correctness problem rather than a UI nicety — so the ConflictError it throws
 * reaches the operator verbatim through `run()`.
 */
export async function deleteVideoAction(videoId: string): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await videoService.remove(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath("/projects");

    return null;
  });
}

/**
 * The list page's "Delete selected". Returns how many landed and how many were
 * skipped rather than throwing on the first busy one, so clearing a dozen test
 * videos is not blocked by one that happens to be rendering.
 */
export async function deleteVideosAction(
  ids: unknown,
): Promise<ActionResult<{ deletedCount: number; skippedCount: number }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = deleteVideosSchema.parse(ids);
    const result = await videoService.removeMany(session.user.id, parsed);

    revalidatePath("/videos");
    revalidatePath("/projects");

    return result;
  });
}
