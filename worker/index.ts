import { hostname } from "node:os";

import { config } from "dotenv";

// .env.local holds local overrides; it must load
// first so it overrides the local docker-compose defaults in .env. Mirrors
// prisma.config.ts and scripts/render.ts exactly.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically, inside main(), and never at module
// top level — see scripts/render.ts for why: `@/config/env` reads
// `process.env` at import time, so a static import here (or of anything that
// imports it, which is nearly every service) would run before the dotenv
// calls above and read every env var as unset.

/** Identifies this process in Railway's shared log stream and in
 * `VideoStatusEvent` messages ("Claimed by worker-a"). `WORKER_ID` is set
 * explicitly in production (one per Railway service instance); the hostname
 * fallback is what makes local runs identifiable too. */
const WORKER_ID = process.env.WORKER_ID?.trim() || hostname();

/** How long to wait before checking for new work after finding none. */
const POLL_INTERVAL_MS = 5_000;

/** Display names for `PipelineStageName`, same list as scripts/render.ts —
 * kept here rather than imported because it's purely a presentation concern,
 * duplicated intentionally rather than shared for it. */
const STAGE_LABELS: Record<string, string> = {
  bucket: "Storage bucket",
  narration: "Narration",
  footage: "Footage",
  render: "Render",
  metadata: "Metadata",
  thumbnail: "Thumbnail",
};

function log(message: string): void {
  console.log(`[${WORKER_ID}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { jobService, HEARTBEAT_SECONDS } = await import("@/services/job.service");
  const { runPipeline, PipelineCancelledError } = await import("@/services/pipeline-runner");

  // Railway sends SIGTERM on every deploy. `shuttingDown` stops the loop from
  // claiming new work; whatever video is already mid-`processVideo` is left
  // to run to its normal completion (including its own `release` call)
  // rather than being torn down — see the module doc comment on why an
  // abrupt exit here is exactly the outcome this exists to avoid.
  let shuttingDown = false;
  const requestShutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`${signal} received — finishing the current video (if any), then exiting`);
  };
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  /**
   * Claims, heartbeats, runs and releases exactly one video. Every error
   * this can throw is caught by the caller — this function's own job is just
   * to make sure a claimed video is *always* released, success or failure,
   * via the `finally` that stops the heartbeat and the `catch` that reports
   * failure/cancellation. A throw escaping `processVideo` would mean the
   * video was claimed but never released, which is the leaked-lease failure
   * mode this whole loop exists to avoid.
   */
  async function processVideo(userId: string, videoId: string): Promise<void> {
    log(`claimed video ${videoId}`);

    // Set by the heartbeat, read by `shouldCancel` below. This is the only
    // channel cancellation has into a running FFmpeg process: `heartbeat`
    // reports whether the operator asked to stop, and `runPipeline` polls
    // this closure between stages and (via `renderService.render`) during
    // the encode itself.
    let cancelRequested = false;

    // Tracks whichever heartbeat call is currently in flight (or a resolved
    // promise, between ticks). `clearInterval` only stops *future* ticks — a
    // tick already dispatched keeps running, and `jobService.heartbeat`
    // renews `leaseExpiresAt` into the future. If that write lands after
    // `release`'s `leaseExpiresAt: null`, a video this worker just finished
    // is left looking leased for another ten minutes. `stopHeartbeat` below
    // awaits this before every `release` call so release's write is always
    // the one that lands last.
    let heartbeatInFlight: Promise<void> = Promise.resolve();

    const heartbeatTimer = setInterval(() => {
      heartbeatInFlight = jobService
        .heartbeat(videoId)
        .then(({ cancelRequested: requested }) => {
          if (requested && !cancelRequested) {
            log(`cancellation requested for ${videoId}`);
          }
          cancelRequested = requested;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log(`heartbeat failed for ${videoId}: ${message}`);
        });
    }, HEARTBEAT_SECONDS * 1000);

    async function stopHeartbeat(): Promise<void> {
      clearInterval(heartbeatTimer);
      await heartbeatInFlight;
    }

    try {
      await runPipeline({
        userId,
        videoId,
        shouldCancel: () => cancelRequested,
        onProgress: (event) => {
          switch (event.type) {
            case "stage-start":
              log(`${videoId} -> ${STAGE_LABELS[event.stage] ?? event.stage}`);
              break;
            case "message":
              log(`${videoId}    ${event.message}`);
              break;
            case "stage-done":
              log(`${videoId}    done in ${event.elapsedMs}ms — ${event.detail}`);
              break;
            case "stage-failed":
              log(`${videoId}    failed after ${event.elapsedMs}ms`);
              break;
          }
        },
      });

      await stopHeartbeat();
      await jobService.release(videoId, "succeeded");
      log(`released video ${videoId}: READY`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // `cancelRequested` (set by the heartbeat above) is what tells a
      // deliberate cancellation apart from a genuine failure — both surface
      // as a thrown error (`PipelineCancelledError` between stages, or
      // renderService's "Render was cancelled." mid-encode), but only
      // `release(..., "cancelled")` clears `cancelRequestedAt`. Releasing a
      // cancelled video as "failed" instead would leave that flag set,
      // which `claimNext` treats as permanently unclaimable.
      const outcome = cancelRequested || error instanceof PipelineCancelledError
        ? "cancelled"
        : "failed";

      log(`releasing video ${videoId}: ${outcome} — ${message}`);

      await stopHeartbeat();

      try {
        await jobService.release(videoId, outcome, message);
      } catch (releaseError) {
        const releaseMessage =
          releaseError instanceof Error ? releaseError.message : String(releaseError);
        log(`failed to release video ${videoId} after ${outcome}: ${releaseMessage}`);
      }
    } finally {
      // Belt-and-braces alongside the explicit `stopHeartbeat` calls above:
      // a leaked interval would keep renewing this video's lease forever,
      // which is worse than no lease at all — the video would look alive to
      // `claimNext` even though nothing is running it. `clearInterval` is
      // idempotent, so calling it again here (it was likely already called
      // by `stopHeartbeat`) is harmless — this is only a backstop for a path
      // that reaches here without having called it, e.g. an unexpected throw
      // from `stopHeartbeat` or `release` themselves.
      clearInterval(heartbeatTimer);
    }
  }

  log(`starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

  while (!shuttingDown) {
    try {
      const claimed = await jobService.claimNext(WORKER_ID);

      if (!claimed) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await processVideo(claimed.userId, claimed.videoId);
    } catch (error) {
      // A claim/process failure must never kill the loop: an unhandled
      // throw here would kill the process, Railway would restart it, and
      // the currently-claimed video's lease would then have to expire
      // (up to ten minutes) before anything retried it.
      const message = error instanceof Error ? error.message : String(error);
      log(`iteration failed: ${message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log("stopped claiming new work — exiting");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${WORKER_ID}] fatal: ${message}`);
  process.exitCode = 1;
});
