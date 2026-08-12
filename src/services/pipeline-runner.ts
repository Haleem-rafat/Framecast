import "server-only";

import { prisma } from "@/lib/prisma";
import { ensureBucket } from "@/lib/storage";
import { footageService } from "@/services/footage.service";
import { metadataService } from "@/services/metadata.service";
import { renderService } from "@/services/render.service";
import { thumbnailService } from "@/services/thumbnail.service";
import { voiceOverService } from "@/services/voiceover.service";
import { formatBytes } from "@/utils/format";

/**
 * The one place the pipeline's stage order — bucket, narration, footage,
 * render, metadata, thumbnail — is defined. `scripts/render.ts` (the
 * debugging CLI) and the render worker both call `runPipeline` rather than
 * each owning their own copy of this sequence; two copies would drift, and
 * the CLI is only useful for diagnosing worker problems if it exercises the
 * identical path.
 */
export type PipelineStageName =
  | "bucket"
  | "narration"
  | "footage"
  | "render"
  | "metadata"
  | "thumbnail";

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
 * The same stage-lifecycle events as `runStage`, but a failure is reported
 * and swallowed rather than rethrown.
 *
 * `metadata` and `thumbnail` run after `render` has already committed a
 * playable, `READY` video — see `renderService.render`'s own transaction,
 * which sets that status the moment the encode succeeds, well before either
 * of these stages runs. Both `metadataService.generate` and
 * `thumbnailService.generate` already catch everything internally and
 * resolve to `null` on failure rather than throwing (see their own doc
 * comments); `fn` returning `null` here is that "nothing was produced"
 * outcome, reported as a failed stage so the operator can see it happened.
 * The extra `try`/`catch` around `fn` itself is a second line of defence, not
 * duplicated trust in a contract already kept elsewhere: if a future change
 * to either service ever reintroduced a throw, letting it escape `runPipeline`
 * would fail the whole pipeline promise, and the worker's only response to a
 * failed pipeline is `jobService.release(videoId, "failed")` — which would
 * overwrite the `READY` status `renderService.render` already committed with
 * `FAILED`, turning a finished, publishable video into one that reads as
 * broken over what is, by design, a cosmetic enhancement.
 */
async function runOptionalStage(
  stage: PipelineStageName,
  onProgress: PipelineProgress,
  fn: () => Promise<string | null>,
): Promise<void> {
  onProgress({ type: "stage-start", stage });
  const startedAt = Date.now();

  let detail: string | null;
  try {
    detail = await fn();
  } catch (error) {
    console.error(
      `Pipeline stage "${stage}" threw despite being documented never to — ` +
        "treating it as a failed stage rather than failing the pipeline: " +
        (error instanceof Error ? error.message : String(error)),
    );
    detail = null;
  }

  const elapsedMs = Date.now() - startedAt;
  if (detail === null) {
    onProgress({ type: "stage-failed", stage, elapsedMs });
    return;
  }
  onProgress({ type: "stage-done", stage, detail, elapsedMs });
}

/**
 * Runs the render pipeline for one video: storage bucket, narration,
 * footage, render, metadata, thumbnail — in that order, skipping any of the
 * first four stages already complete rather than redoing it. Narration in
 * particular is only ever re-synthesised when `force` is explicitly true;
 * the operator has 10,000 ElevenLabs characters a month and a real script is
 * roughly 7,000, so a silent re-synthesis is a direct cost regression, not
 * just wasted work.
 *
 * `metadata` and `thumbnail` are different in kind from the four stages
 * before them, not just in ordering. They run unconditionally rather than
 * being skipped when already done — this pipeline has no operator-facing
 * "regenerate" flow yet, so there's no `force`-style flag to gate on — and,
 * per `runOptionalStage`, a failure in either is reported but never fails
 * `runPipeline` itself: the video is already rendered and `READY` by the
 * time they run, and nothing past that point may turn a renderable video
 * into a failed one.
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
    return `rendered ${result.durationSeconds}s to ${result.outputUrl}`;
  });

  // `shouldCancel?.()` checked directly here, not `checkCancelled`, and
  // deliberately not for the same reason `checkCancelled` guards every stage
  // above. By this point the video is already `READY` — renderService.render
  // set that inside its own transaction — so `checkCancelled`'s throw
  // (`PipelineCancelledError`) would reject `runPipeline` itself, and the
  // worker's cancellation path (`jobService.release(videoId, "cancelled")`)
  // turns any rejection into `FAILED`, overwriting the `READY` status that
  // already exists. That is exactly the "renderable video becomes a failed
  // one" outcome `runOptionalStage` exists to prevent, just reached via
  // cancellation instead of a thrown error.
  //
  // A plain early `return` honours the same cancel request without ever
  // rejecting: `runPipeline` resolves normally, the worker releases the
  // video as `"succeeded"`, and `READY` is written again exactly as it would
  // without a cancel in play (see job.service.ts's `release`, which now also
  // clears `cancelRequestedAt` on that path). What changes is real spend —
  // an operator who cancelled while the video was still `RENDERING`, but
  // whose request lost the race with FFmpeg finishing (the render can
  // complete, and `renderService.render` can commit `READY`, in the gap
  // between the worker's last heartbeat and its next one), no longer pays for
  // an Anthropic call and an image generation for a video they explicitly
  // asked to stop. There is no way to request a *fresh* cancellation once the
  // video reads `READY` — `jobService.requestCancel` only accepts a video
  // that is `GENERATING`/`RENDERING` — so `shouldCancel` here can only ever
  // be honouring a request that was already in flight before render finished.
  if (shouldCancel?.()) {
    return;
  }

  await runOptionalStage("metadata", onProgress, async () => {
    const metadata = await metadataService.generate(userId, videoId);
    return metadata ? `generated title "${metadata.title}"` : null;
  });

  if (shouldCancel?.()) {
    return;
  }

  await runOptionalStage("thumbnail", onProgress, async () => {
    // Runs after metadata, not just after render: ThumbnailService reads
    // `video.generatedTitle ?? video.title` for the headline it draws on the
    // image (see thumbnail.service.ts), so generating it first is what lets
    // the thumbnail show the AI-generated title instead of the operator's
    // placeholder whenever metadata succeeded.
    const path = await thumbnailService.generate(userId, videoId);
    return path ? `stored ${path}` : null;
  });
}
