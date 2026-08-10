import "server-only";

import { prisma } from "@/lib/prisma";
import { ensureBucket } from "@/lib/storage";
import { footageService } from "@/services/footage.service";
import { renderService } from "@/services/render.service";
import { voiceOverService } from "@/services/voiceover.service";
import { formatBytes } from "@/utils/format";

/**
 * The one place the pipeline's stage order — bucket, narration, footage,
 * render — is defined. `scripts/render.ts` (the debugging CLI) and the
 * render worker both call `runPipeline` rather than each owning their own
 * copy of this sequence; two copies would drift, and the CLI is only useful
 * for diagnosing worker problems if it exercises the identical path.
 */
export type PipelineStageName = "bucket" | "narration" | "footage" | "render";

/**
 * One event per stage-lifecycle transition, plus every inner progress line
 * the services themselves report. Each service already accepts a plain
 * `(message: string) => void` progress callback (see `FootageProgress` in
 * footage.service.ts for why it's a callback rather than a direct
 * `console.log` — this module runs inside the worker too, where stdout is
 * the wrong medium); those messages are forwarded here unchanged as
 * `type: "message"` rather than reinvented as a second convention. Callers
 * (the CLI, the worker) render/report each event however suits them.
 */
export type PipelineEvent =
  | { type: "stage-start"; stage: PipelineStageName }
  | { type: "message"; stage: PipelineStageName; message: string }
  | { type: "stage-done"; stage: PipelineStageName; detail: string; elapsedMs: number }
  | { type: "stage-failed"; stage: PipelineStageName; elapsedMs: number };

export type PipelineProgress = (event: PipelineEvent) => void;

export interface RunPipelineInput {
  userId: string;
  videoId: string;
  /** Re-synthesise narration even though it already exists. Spends real
   * ElevenLabs quota the moment this is true — it must trace back to an
   * explicit operator choice (the CLI's `--force-narration` flag), never a
   * default. */
  force?: boolean;
  onProgress?: PipelineProgress;
  /** Polled between stages, and threaded into `renderService.render` so a
   * long FFmpeg run can be interrupted mid-render rather than only at a
   * stage boundary. The CLI passes nothing — it runs to completion or until
   * killed. The worker passes a check against its own heartbeat. */
  shouldCancel?: () => boolean;
}

const noopProgress: PipelineProgress = () => {};

export class PipelineCancelledError extends Error {
  constructor(stage: PipelineStageName) {
    super(`Pipeline cancelled before the "${stage}" stage started.`);
    this.name = "PipelineCancelledError";
  }
}

async function runStage(
  stage: PipelineStageName,
  onProgress: PipelineProgress,
  fn: (report: (message: string) => void) => Promise<string>,
): Promise<void> {
  onProgress({ type: "stage-start", stage });
  const startedAt = Date.now();
  try {
    const detail = await fn((message) => onProgress({ type: "message", stage, message }));
    onProgress({ type: "stage-done", stage, detail, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    onProgress({ type: "stage-failed", stage, elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

/**
 * Runs the render pipeline for one video: storage bucket, narration,
 * footage, render — in that order, skipping any stage already complete
 * rather than redoing it. Narration in particular is only ever
 * re-synthesised when `force` is explicitly true; the operator has 10,000
 * ElevenLabs characters a month and a real script is roughly 7,000, so a
 * silent re-synthesis is a direct cost regression, not just wasted work.
 */
export async function runPipeline(input: RunPipelineInput): Promise<void> {
  const { userId, videoId, force = false, onProgress = noopProgress, shouldCancel } = input;

  function checkCancelled(stage: PipelineStageName): void {
    if (shouldCancel?.()) {
      throw new PipelineCancelledError(stage);
    }
  }

  const video = await prisma.video.findFirst({
    where: { id: videoId, userId, deletedAt: null },
    select: {
      id: true,
      status: true,
      script: { select: { activeVersion: { select: { content: true } } } },
      voiceOver: { select: { durationSeconds: true } },
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} was not found for user ${userId}.`);
  }

  checkCancelled("bucket");
  await runStage("bucket", onProgress, async () => {
    await ensureBucket();
    return "bucket ready";
  });

  checkCancelled("narration");
  await runStage("narration", onProgress, async (report) => {
    if (video.voiceOver && !force) {
      return (
        `already exists (${video.voiceOver.durationSeconds}s) — skipped. ` +
        "Pass --force-narration to re-synthesise (this spends ElevenLabs quota again)."
      );
    }

    if (video.voiceOver && force) {
      const characters = video.script?.activeVersion?.content?.length ?? 0;
      report(
        `--force-narration: about to spend ~${characters} characters of the ` +
          "operator's ElevenLabs monthly quota re-synthesising this narration.",
      );
    }

    const result = await voiceOverService.generate(userId, videoId, { force }, report);
    return `synthesised ${result.durationSeconds}s of narration (${result.characterCount} characters)`;
  });

  checkCancelled("footage");
  await runStage("footage", onProgress, async (report) => {
    const before = await prisma.asset.count({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
    });

    const result = await footageService.collect(userId, videoId, report);
    const downloaded = result.clipCount - before;

    if (downloaded <= 0) {
      return `already had ${result.clipCount} clips — nothing new downloaded`;
    }

    return (
      `collected ${downloaded} new clip(s), ${result.clipCount} total, ` +
      `${formatBytes(result.bytesDownloaded)} downloaded (${JSON.stringify(result.bySource)})`
    );
  });

  checkCancelled("render");
  await runStage("render", onProgress, async (report) => {
    if (video.status === "READY") {
      return "video is already READY — skipped";
    }

    // No service owns the QUEUED -> GENERATING edge: narration requires QUEUED
    // and render.service requires GENERATING, so this is what flips it, right
    // before handing off to render.service. Same atomic conditional-update
    // shape as the gates in video.service.ts / render.service.ts, so a second
    // concurrent runner can't double-transition.
    if (video.status === "QUEUED") {
      const { count } = await prisma.video.updateMany({
        where: { id: videoId, userId, deletedAt: null, status: "QUEUED" },
        data: { status: "GENERATING" },
      });

      if (count > 0) {
        await prisma.videoStatusEvent.create({
          data: {
            videoId,
            from: "QUEUED",
            to: "GENERATING",
            message: "Narration and footage ready; starting render",
          },
        });
      }
    }

    const result = await renderService.render(userId, videoId, report, shouldCancel);
    return `rendered ${result.durationSeconds}s to ${result.outputPath}`;
  });
}
