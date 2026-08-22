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

/**
 * How often to ask whether a schedule is due.
 *
 * Not every poll. The video and short claims are the loop's real work and they
 * run every five seconds; a third query on the same cadence would be twelve
 * pointless round trips a minute against a table whose rows come due once a
 * week. Thirty seconds is far finer than the minute-level granularity a
 * schedule can even express, so nothing fires late that would not have fired
 * late anyway.
 */
const SCHEDULE_TICK_INTERVAL_MS = 30_000;

/**
 * How often to ask whether a shorts release slot is due.
 *
 * The same thirty seconds, for a nearly identical reason: a cadence expresses
 * its slots to the minute, so a poll finer than that buys nothing, and one
 * coarser would let a clip drift visibly past the time of day it was scheduled
 * for. Denser than a schedule's occurrences — three a day per channel rather
 * than one a week — but the *query* is the same single indexed lookup that
 * almost always returns nothing, so the cost of asking is the same.
 *
 * A separate timer rather than sharing the schedule's, so that a schedule tick
 * that finds work does not also delay the release check behind it.
 */
const RELEASE_TICK_INTERVAL_MS = 30_000;

/**
 * How often to ask whether a finished video is booked to publish itself.
 *
 * The same thirty seconds as the two above, and for a simpler reason than
 * either of them: this tick has no cadence to keep up with. It fires on a
 * *state* — a video an automation made has reached READY — so the only latency
 * it can add is between the render finishing and the upload starting, measured
 * against a schedule that comes round once a week. Thirty seconds there is not
 * a number anybody can notice. The query is the same single indexed lookup that
 * almost always returns nothing, so asking more often would buy nothing.
 */
const AUTO_PUBLISH_TICK_INTERVAL_MS = 30_000;

/**
 * How often to ask whether a channel is due for an analytics collection.
 *
 * Coarser than the schedule and release ticks, and deliberately so. Those two
 * express their work to the minute; this one has a cadence of a day per channel
 * (a quarter-hour while backfilling), and the figures it collects are two days
 * old before YouTube will report them at all. Asking twice a minute would be a
 * query whose answer cannot have changed.
 *
 * Note where the tick is actually *called* — the idle branch at the bottom of
 * the loop, not up here beside the other two. See the comment at the call site.
 */
/**
 * How often to advance the motion tier by one step.
 *
 * Ten seconds, and it is the finest tick in this file for a reason none of the
 * others have: `motionService.tick()` claims exactly ONE job, and a manifest is
 * up to twelve of them. At the thirty seconds the ticks above use, simply
 * getting twelve clips submitted would take six minutes of a worker doing
 * nothing else — against a generation that takes three and a half. Ten seconds
 * puts that at two minutes, which is noise beside the generation itself.
 *
 * The query is the same single indexed lookup as the others and almost always
 * returns nothing. What is NOT free is the branch that finds a finished clip:
 * it downloads a few megabytes and runs an FFmpeg conform, seconds of held loop
 * with an encoder beside whatever render is already running. That is accepted
 * on the same grounds as the release and auto-publish uploads above, and it is
 * bounded — one clip per tick, and the clip is five seconds long.
 */
const MOTION_TICK_INTERVAL_MS = 10_000;

const ANALYTICS_TICK_INTERVAL_MS = 120_000;

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
  const { selectShortsIfAsked } = await import("@/services/auto-publish.service");
  const { scheduleService } = await import("@/services/schedule.service");
  const { releaseService } = await import("@/services/release.service");
  const { autoPublishService } = await import("@/services/auto-publish.service");
  const { motionService } = await import("@/services/motion.service");
  const { shortsService } = await import("@/services/shorts.service");
  const { channelAnalyticsService } = await import(
    "@/services/channel-analytics.service"
  );

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

      // After the release, never before, and outside the try that owns the
      // render. The video is finished and publishable at this point; reel
      // selection is a bonus a schedule asked for, and it must not be able to
      // turn a finished video into a failed one. `selectShortsIfAsked` swallows
      // its own errors for the same reason and returns without a word when the
      // video is not an automation's or the automation did not ask.
      await selectShortsIfAsked(videoId, (message) => log(`${videoId}    ${message}`));
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

  /**
   * Claims, heartbeats, renders and releases exactly one short.
   *
   * The same shape as `processVideo` above, and deliberately so: shorts go
   * through the identical claim/lease/heartbeat/release discipline rather than
   * a second, ad-hoc loop of their own. What differs is only what shorts do
   * not have — there is no cancellation flag to poll (see the `ShortStatus`
   * comment in schema.prisma), so the heartbeat renews the lease and reports
   * nothing back.
   *
   * Nothing in here can touch the parent video. `shortsService` writes only to
   * the `short` row, and every error below is released against `shortId`, so a
   * short that fails leaves a READY (or PUBLISHED) video exactly as it was —
   * which is the whole reason shorts are a separate claim rather than a
   * seventh pipeline stage bolted onto the end of `runPipeline`.
   */
  async function processShort(shortId: string, videoId: string): Promise<void> {
    log(`claimed short ${shortId} (video ${videoId})`);

    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      heartbeatInFlight = shortsService.heartbeat(shortId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`heartbeat failed for short ${shortId}: ${message}`);
      });
    }, HEARTBEAT_SECONDS * 1000);

    // Same reasoning as `processVideo`'s `stopHeartbeat`: `clearInterval` stops
    // only future ticks, and a tick already in flight would renew the lease
    // after `release` cleared it, leaving a finished short looking claimed.
    async function stopHeartbeat(): Promise<void> {
      clearInterval(heartbeatTimer);
      await heartbeatInFlight;
    }

    try {
      await shortsService.renderShort(shortId, (message) => log(`${shortId}    ${message}`));

      await stopHeartbeat();
      await shortsService.release(shortId, "succeeded");
      log(`released short ${shortId}: READY`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`releasing short ${shortId}: failed — ${message}`);

      await stopHeartbeat();

      try {
        await shortsService.release(shortId, "failed", message);
      } catch (releaseError) {
        const releaseMessage =
          releaseError instanceof Error ? releaseError.message : String(releaseError);
        log(`failed to release short ${shortId}: ${releaseMessage}`);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  log(`starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

  /**
   * When the schedule due-check may next run. Zero so the first poll after a
   * deploy checks immediately — a worker that has just come back up is exactly
   * when a schedule is most likely to be overdue.
   */
  let nextScheduleTickAt = 0;

  /** When the shorts release due-check may next run. Zero for the same reason
   *  as the schedule's: a worker that has just come back up is exactly when a
   *  slot is most likely to be overdue. */
  let nextReleaseTickAt = 0;

  /** When the auto-publish due-check may next run. Zero for the same reason as
   *  the other two: a worker that has just come back up is exactly when a
   *  finished video is most likely to have been waiting to go out. */
  let nextAutoPublishTickAt = 0;

  /** When the motion tier may next take a step. Zero because a worker that has
   *  just come back up may be holding generations that fal.ai finished while it
   *  was down — and those are already paid for. */
  let nextMotionTickAt = 0;

  /** When the analytics collector may next look. Zero so a freshly deployed
   *  worker collects on its first idle moment rather than two minutes later —
   *  which matters exactly once, on the deploy that first creates any
   *  `ChannelCollection` rows at all. */
  let nextAnalyticsTickAt = 0;

  /**
   * Runs one analytics collection if one is due, and logs what it produced.
   *
   * Called from two places with different urgency, which is why it is a
   * function rather than an inline block — see both call sites below.
   */
  async function tickAnalytics(): Promise<void> {
    nextAnalyticsTickAt = Date.now() + ANALYTICS_TICK_INTERVAL_MS;

    const collection = await channelAnalyticsService.tick();

    if (!collection) {
      return;
    }

    log(
      `analytics "${collection.channelTitle}" → ${collection.outcome}` +
        ` (${collection.videoDays} video-day${collection.videoDays === 1 ? "" : "s"}` +
        `${collection.snapshotTaken ? ", channel snapshot" : ""}` +
        `${collection.backfilledTo ? `, backfilled to ${collection.backfilledTo}` : ""})` +
        `${collection.reason ? ` — ${collection.reason}` : ""}`,
    );
  }

  while (!shuttingDown) {
    try {
      // Deliberately before the video claim rather than after it, and this is
      // the one ordering decision in this loop worth arguing about.
      //
      // The shorts claim below sits *after* the video claim so that a queued
      // video always outranks a derivative of one that already finished. A
      // schedule tick is not that: it is the thing that *creates* queued
      // videos. Put behind the video claim, it would never run at all on a busy
      // worker — every iteration would `continue` on a claimed video and the
      // Monday morning run would land whenever the backlog happened to clear.
      //
      // Placing it first is safe precisely because it is bounded and rare: it
      // is one indexed query that almost always returns nothing, it runs at
      // most twice a minute, and when it does find work that work is a single
      // Anthropic call — the same order of delay as one video's claim, not a
      // ten-minute render. Nothing here `continue`s either, so the moment the
      // tick queues a video the loop falls straight through and claims it.
      if (Date.now() >= nextScheduleTickAt) {
        nextScheduleTickAt = Date.now() + SCHEDULE_TICK_INTERVAL_MS;

        const tick = await scheduleService.tick();

        if (tick) {
          log(
            `schedule "${tick.scheduleName}" due ${tick.scheduledFor.toISOString()} → ` +
              `${tick.outcome}${tick.videoId ? ` (video ${tick.videoId})` : ""}` +
              `${tick.reason ? ` — ${tick.reason}` : ""}`,
          );
        }
      }

      // Beside the schedule tick and ahead of the video claim, for the same
      // reason: behind it, a busy worker would `continue` on a claimed video
      // every iteration and 08:00 would arrive whenever the render backlog
      // happened to clear.
      //
      // What is different, and worth being honest about, is the cost when this
      // one *does* find work. A schedule tick that fires is one Anthropic call;
      // a release that fires reads tens of megabytes off disk and PUTs them to
      // YouTube, which is seconds to tens of seconds with the loop held. That
      // is deliberate, and the alternative was worse: running the upload
      // without awaiting it would put a multi-megabyte buffer alongside
      // whatever FFmpeg is holding, on a box with 4GB and two vCPUs, at exactly
      // the moment renders are most likely to be running. Nine uploads a day
      // across three channels is about three minutes of held loop, against
      // renders that take ten minutes each — so the video that waits, waits an
      // unnoticeable amount.
      //
      // A slot that comes due *during* a render is the one case that shows: the
      // iteration is inside `processVideo`, so the clip goes out when the render
      // finishes rather than on the minute. History records the slot it was for
      // (`scheduledFor`) separately from when it happened (`createdAt`), so a
      // late release reads as late rather than as on time.
      //
      // `releaseService.tick()` claims at most one slot, which is also this
      // app's answer to three channels all releasing at 08:00 — see its own
      // doc comment on why the stagger is here rather than in the times the
      // operator picked.
      if (Date.now() >= nextReleaseTickAt) {
        nextReleaseTickAt = Date.now() + RELEASE_TICK_INTERVAL_MS;

        const release = await releaseService.tick();

        if (release) {
          log(
            `release "${release.channelTitle}" slot ${release.scheduledFor.toISOString()} → ` +
              `${release.outcome}` +
              `${release.youtubeVideoId ? ` (youtube ${release.youtubeVideoId})` : ""}` +
              `${release.reason ? ` — ${release.reason}` : ""}`,
          );
        }
      }

      // Beside the release tick and ahead of the video claim, for a different
      // reason from either of the two above. Those sit here because they
      // *create* queued work, and behind the claim they would never fire on a
      // busy worker. This one creates nothing — it finishes something. What it
      // shares is the consequence of sitting behind the claim: on a worker with
      // a render backlog, an episode would go up whenever that backlog happened
      // to clear, which is precisely the opposite of the promise "publishes
      // itself" makes to somebody who is not watching.
      //
      // The cost when it fires is an upload — tens of megabytes to YouTube with
      // the loop held, seconds to tens of seconds. Identical to the release
      // tick's, and accepted for the identical reason: running it without
      // awaiting would put a multi-megabyte buffer beside whatever FFmpeg is
      // holding, on a box with 4GB and two vCPUs, at exactly the moment renders
      // are most likely to be running.
      //
      // `tick()` claims at most one job, which is also the answer to a worker
      // coming back after a day down with nine episodes finished and booked:
      // they go out one poll apart rather than nine at once onto a channel
      // whose audience is asleep.
      if (Date.now() >= nextAutoPublishTickAt) {
        nextAutoPublishTickAt = Date.now() + AUTO_PUBLISH_TICK_INTERVAL_MS;

        const published = await autoPublishService.tick();

        if (published) {
          log(
            `auto-publish "${published.videoTitle}" → ${published.outcome}` +
              `${published.youtubeVideoId ? ` (youtube ${published.youtubeVideoId})` : ""}` +
              `${published.reason ? ` — ${published.reason}` : ""}`,
          );
        }
      }

      // The motion tier, ahead of the video claim for a reason the two above
      // do not have: **these jobs are already paid for.** A generation sits in
      // fal.ai's queue whether or not this worker is looking, so a tick stuck
      // behind a render backlog is not work deferred, it is money spent and not
      // collected — and a result url does not stay fetchable forever.
      //
      // One job per tick, deliberately. That is also what stops a twelve-clip
      // manifest from firing twelve submits into the same second and turning a
      // ceiling that was checked once into a burst nobody watched.
      //
      // Every line it logs is a step in something expensive, so every step is
      // logged, including the polls that found nothing — the ONLY record of
      // what this tier did with an afternoon is this log.
      if (Date.now() >= nextMotionTickAt) {
        nextMotionTickAt = Date.now() + MOTION_TICK_INTERVAL_MS;

        const motion = await motionService.tick();

        if (motion) {
          log(
            `motion clip ${motion.clipId} of video ${motion.videoId} → ` +
              `${motion.outcome}${motion.storagePath ? ` (${motion.storagePath})` : ""}` +
              `${motion.reason ? ` — ${motion.reason}` : ""}`,
          );
        }
      }

      // The escape hatch, and the *only* place analytics collection is allowed
      // to delay a render.
      //
      // Collection normally runs in the idle branch at the bottom of this loop
      // (see there for why). The hole in that arrangement is a worker that is
      // never idle: a long enough render backlog would mean the dashboard is
      // never refreshed at all, and the page would keep saying "captured four
      // days ago" with nothing explaining it.
      //
      // So a channel that has been due for more than six hours outranks the
      // video claim — but only just. `hasOverdueChannel` is a `count` on the
      // same index the due-check scans and almost always returns false, and
      // when it does fire it collects exactly one channel: a `channels.list`
      // and a handful of `reports.query` calls, seconds of held loop against a
      // render that takes ten minutes. The interval gate above it means this
      // cannot be asked more than once every two minutes either.
      if (
        Date.now() >= nextAnalyticsTickAt &&
        (await channelAnalyticsService.hasOverdueChannel())
      ) {
        await tickAnalytics();
      }

      const claimed = await jobService.claimNext(WORKER_ID);

      if (claimed) {
        await processVideo(claimed.userId, claimed.videoId);
        continue;
      }

      // Shorts are picked up only when there is no video waiting, and that
      // ordering is the point rather than an accident of where the call sits.
      // A video is the thing an operator is waiting on and the thing that
      // spends provider money; a short is a derivative of one that already
      // finished. Claiming shorts first would let a video sit queued behind
      // three encodes on a box with one worker.
      const claimedShort = await shortsService.claimNext();

      if (claimedShort) {
        await processShort(claimedShort.shortId, claimedShort.videoId);
        continue;
      }

      // Nothing to render and nothing to encode — the one moment in this loop
      // where spending seconds on Google's API costs nobody anything.
      //
      // Deliberately *not* up beside the schedule and release ticks. Those two
      // sit ahead of the video claim because they are what *creates* queued
      // work: behind it, a busy worker would never fire them and Monday's video
      // would appear whenever the backlog happened to clear. Analytics
      // collection is the opposite — it produces nothing anybody is waiting on,
      // and YouTube will not report a day's figures for about two days anyway,
      // so a collection deferred behind a ten-minute render is a collection
      // nobody can tell was deferred.
      //
      // What that buys is the constraint this worker actually lives under: 2
      // vCPUs and 640 MB shared with FFmpeg. A dozen sequential HTTPS round
      // trips never overlap an encode, because by construction there is no
      // encode running when this line is reached.
      if (Date.now() >= nextAnalyticsTickAt) {
        await tickAnalytics();
      }

      await sleep(POLL_INTERVAL_MS);
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
