import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/** How long a claim is held before another worker may take over. */
const LEASE_SECONDS = 600;
/** Renewal interval is far shorter, so a slow stage never loses its own lease. */
export const HEARTBEAT_SECONDS = 30;
/** A video that fails this many times stops costing money. Exported so the
 * read model (`pipeline.service.ts`) can tell an operator "retry is pointless
 * now" without duplicating the cap as a second magic number. */
export const MAX_ATTEMPTS = 3;

/**
 * Claim, heartbeat and release: the worker-facing half of the pipeline. The
 * `Video.status` column *is* the queue — there is no separate queue table —
 * so claiming a video is entirely a matter of winning a conditional update
 * against it. See `claimNext` for why that has to be two steps.
 */
export class JobService {
  /**
   * Finds the oldest claimable video and wins it with a conditional update.
   *
   * Prisma's `updateMany` has no `LIMIT`, so an unconditional "claim the
   * oldest queued video" would let two concurrent callers both match (and
   * both think they won) the same row. Instead: read a short list of
   * candidates, then try to win each one in turn with an update whose
   * `where` clause repeats the exact state just read. Only one caller's
   * update can still match a row once either of them has changed it, so
   * `count === 1` is a real win and `count === 0` means someone else got
   * there first — the conditional update *is* the lock, not the read above
   * it.
   */
  async claimNext(
    workerId: string,
  ): Promise<{ videoId: string; userId: string } | null> {
    const now = new Date();

    // Candidates: queued and unclaimed, or claimed by a worker whose lease
    // has lapsed — that second case is a worker that died mid-run. A lock
    // would strand that video forever; a lease lets another worker retake it.
    const candidates = await prisma.video.findMany({
      where: {
        deletedAt: null,
        attempts: { lt: MAX_ATTEMPTS },
        cancelRequestedAt: null,
        OR: [
          {
            status: "QUEUED",
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
          },
          {
            status: { in: ["GENERATING", "RENDERING"] },
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { id: true, userId: true, status: true },
    });

    for (const candidate of candidates) {
      // The conditional update is the lock: only one caller can match a row
      // in this exact state, so only one can claim it.
      const { count } = await prisma.video.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "GENERATING",
          leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000),
          attempts: { increment: 1 },
        },
      });

      if (count === 1) {
        await prisma.videoStatusEvent.create({
          data: {
            videoId: candidate.id,
            from: candidate.status,
            to: "GENERATING",
            message: `Claimed by ${workerId}`,
          },
        });

        return { videoId: candidate.id, userId: candidate.userId };
      }
    }

    return null;
  }

  /** Renews the lease and reports whether the operator asked to stop. Only
   * the worker owns the FFmpeg child process, so cancellation can only ever
   * be *requested* elsewhere (see `requestCancel`) and acted on here. */
  async heartbeat(videoId: string): Promise<{ cancelRequested: boolean }> {
    const video = await prisma.video.update({
      where: { id: videoId },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) },
      select: { cancelRequestedAt: true },
    });

    return { cancelRequested: video.cancelRequestedAt !== null };
  }

  /**
   * Ends a claim. `leaseExpiresAt` is cleared in every outcome — a succeeded
   * video must not still look claimed, and a failed one must be claimable
   * again by the next attempt (subject to `MAX_ATTEMPTS`). The transition
   * itself is guarded the same way `VideoService.approveScript` guards
   * DRAFT -> QUEUED: read the current status, then only write if a
   * conditional update still finds the row in that exact state.
   */
  async release(
    videoId: string,
    outcome: "succeeded" | "failed" | "cancelled",
    reason?: string,
  ): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const from = video.status;

    if (outcome === "succeeded") {
      const { count } = await prisma.video.updateMany({
        where: { id: videoId, deletedAt: null, status: from },
        // `cancelRequestedAt` is cleared here too, matching the `failed` and
        // cancelled branches below: a video that finished successfully has
        // nothing left running to cancel, so a flag left over from a cancel
        // request that lost the race with the render finishing (see
        // pipeline-runner.ts's own comment on that race) must not survive
        // into a READY video. Nothing currently reads a stray
        // `cancelRequestedAt` on a READY video as meaningful — this was
        // inert, resting on `requestCancel`'s own GENERATING/RENDERING guard
        // rather than on this write actually clearing it — but leaving a
        // "please cancel me" flag permanently set on a finished video is a
        // latent trap for the next thing that reads it.
        data: { status: "READY", leaseExpiresAt: null, cancelRequestedAt: null },
      });

      if (count === 0) {
        throw new ConflictError("The video's status changed unexpectedly.");
      }

      await prisma.videoStatusEvent.create({
        data: { videoId, from, to: "READY", message: "Render completed" },
      });

      return;
    }

    if (outcome === "failed") {
      const { count } = await prisma.video.updateMany({
        where: { id: videoId, deletedAt: null, status: from },
        data: {
          status: "FAILED",
          leaseExpiresAt: null,
          failureReason: reason ?? null,
        },
      });

      if (count === 0) {
        throw new ConflictError("The video's status changed unexpectedly.");
      }

      await prisma.videoStatusEvent.create({
        data: { videoId, from, to: "FAILED", message: reason ?? "Render failed" },
      });

      return;
    }

    // Cancellation is cooperative: `requestCancel` only sets a flag, and the
    // worker is the only thing that can act on it (it owns the FFmpeg child
    // process). This is where it does — and it clears the flag it's acting
    // on, so the video is a plain, retryable FAILED afterward rather than
    // one still flagged as "please cancel me".
    const message = reason ?? "Cancelled by operator";
    const { count } = await prisma.video.updateMany({
      where: { id: videoId, deletedAt: null, status: from },
      data: {
        status: "FAILED",
        leaseExpiresAt: null,
        cancelRequestedAt: null,
        failureReason: message,
      },
    });

    if (count === 0) {
      throw new ConflictError("The video's status changed unexpectedly.");
    }

    await prisma.videoStatusEvent.create({
      data: { videoId, from, to: "FAILED", message },
    });
  }

  /**
   * Flags a video for cancellation. Only ever a request: the worker owns the
   * FFmpeg child process, so only it can actually stop one, on its next
   * `heartbeat`. Scoped to `userId` like every other mutation in this
   * codebase, and refused for a video that isn't mid-pipeline — cancelling a
   * DRAFT or already-terminal video means nothing.
   */
  async requestCancel(userId: string, videoId: string): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "GENERATING" && video.status !== "RENDERING") {
      throw new ConflictError(
        `Only a video that is actively being processed can be cancelled. This one is ${video.status.toLowerCase()}.`,
      );
    }

    await prisma.video.update({
      where: { id: videoId },
      data: { cancelRequestedAt: new Date() },
    });
  }

  /**
   * The operator-facing half of the queue: puts a video back to `QUEUED` so
   * the worker's own `claimNext` picks it up on its next poll. Only ever
   * touches `status` and `leaseExpiresAt` — every other stage-completion
   * signal (narration, footage, captions) lives on rows `runPipeline` reads
   * directly, so re-queuing never needs to reset any of them, and a retried
   * video skips straight past the stages it already finished (in particular,
   * narration is never re-synthesised — see `runPipeline`'s own comment on
   * why that matters for ElevenLabs quota).
   *
   * Three starting states are valid. `QUEUED` and idle (the video passed Gate 1
   * — see `VideoService.approveScript`, which is the only thing that ever
   * sets `QUEUED` — and nothing has claimed it yet, so this is a harmless
   * re-affirmation); `FAILED` with attempts still under `MAX_ATTEMPTS`; or
   * stranded mid-flight — `GENERATING`/`RENDERING` with a lapsed lease, which
   * is the only way an operator can recover a video whose worker died holding
   * it. `DRAFT` is deliberately never valid here: this codebase has no notion of
   * "script approved" independent of that same `QUEUED` transition, so a
   * `DRAFT` video is by definition not yet approved, and the page never even
   * mounts the pipeline panel this method is called from until a video
   * leaves `DRAFT` (see the video detail page's own gate).
   *
   * `resetAttempts` is the one difference between "Run" and "Retry": a
   * deliberate retry means the operator has presumably fixed whatever failed
   * and is asking for a fresh three attempts, not the automatic-retry-loop
   * protection `MAX_ATTEMPTS` exists for.
   */
  private async requeue(
    userId: string,
    videoId: string,
    resetAttempts: boolean,
    eventMessage: string,
  ): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true, attempts: true, leaseExpiresAt: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const now = new Date();
    // An expired lease is proof no worker is holding this video: the holder
    // renews every HEARTBEAT_SECONDS and would have renewed long before
    // LEASE_SECONDS elapsed. Anything still sitting in a mid-flight status
    // past that point was abandoned by a worker that died — Railway redeploy,
    // crash, laptop sleep — and nothing else will ever recover it, because
    // `release` only runs inside the worker that died.
    const leaseHasLapsed = video.leaseExpiresAt !== null && video.leaseExpiresAt < now;

    const isIdleQueued = video.status === "QUEUED";
    const isRetryableFailure = video.status === "FAILED" && video.attempts < MAX_ATTEMPTS;
    const isStranded =
      (video.status === "GENERATING" || video.status === "RENDERING") && leaseHasLapsed;

    if (!isIdleQueued && !isRetryableFailure && !isStranded) {
      const reason =
        video.status === "FAILED"
          ? `This video has already failed ${video.attempts} times, the maximum. Fix the underlying issue before trying again.`
          : `Only a queued video, or a failed video that hasn't exhausted its retries, can be run. This one is ${video.status.toLowerCase()}.`;
      throw new ConflictError(reason);
    }

    // Same shape as `claimNext`'s own win-the-row step and
    // `VideoService.approveScript`'s DRAFT -> QUEUED guard: the `where`
    // clause repeats the exact status just read, so a second rapid click (or
    // a worker claiming the video in the instant between the read above and
    // this write) can no longer match the row. Only one caller's update can
    // win; the other gets `count === 0` and a clean conflict rather than
    // silently queuing the same video twice.
    //
    // The lease predicate is repeated only when reclaiming a stranded video,
    // where it is load-bearing: `GENERATING`/`RENDERING` is exactly the state
    // a live worker holds, so without it a worker that renewed its lease
    // between the read above and this write would have its video yanked out
    // from under it mid-render. It is deliberately NOT applied to the
    // `QUEUED` and `FAILED` cases — no worker holds a video in either, so a
    // lease still sitting on one is stale by definition, and refusing to
    // requeue because of it would strand the video for the full remaining
    // lease over a value this very write clears.
    const leaseGuard = isStranded
      ? { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] }
      : {};

    const { count } = await prisma.video.updateMany({
      where: {
        id: videoId,
        userId,
        deletedAt: null,
        status: video.status,
        ...leaseGuard,
      },
      data: {
        status: "QUEUED",
        leaseExpiresAt: null,
        // Nothing outside the worker's own `release` ever clears this, and
        // `claimNext` treats a set flag as permanently disqualifying. So a
        // cancel whose worker died before its next heartbeat — or a cancel
        // pressed during a CLI run, which never reads the flag at all — left
        // the video unclaimable forever, with a Cancel button that did
        // nothing and a panel polling every 2s until the tab closed.
        // Requeuing is the operator asking for this video to run, which is by
        // definition a withdrawal of any earlier cancel.
        cancelRequestedAt: null,
        ...(resetAttempts ? { attempts: 0 } : {}),
      },
    });

    if (count === 0) {
      throw new ConflictError("The video's status changed unexpectedly.");
    }

    await prisma.videoStatusEvent.create({
      data: { videoId, from: video.status, to: "QUEUED", message: eventMessage },
    });
  }

  /**
   * Takes the same lease the worker uses, for a runner that is not the
   * worker — today that means `scripts/render.ts`.
   *
   * The CLI used to call `runPipeline` directly, holding nothing. That made
   * it invisible to `claimNext`, which reads an unleased video as free work,
   * so the worker would happily claim a video the CLI was already halfway
   * through. `FootageService.collect` has no status guard and decides how
   * many clips to fetch with a plain read-then-write, so both runners read
   * "0 clips exist", both computed the same shortfall, and both downloaded
   * and stored it — double the download time, double the storage against a
   * free-tier bucket, and roughly twice the inputs handed to FFmpeg, whose
   * memory growth is exactly what the clip cap exists to bound.
   *
   * Deliberately does not touch `status` or `attempts`. The CLI is a
   * debugging tool and must keep running against a video in whatever state
   * it is already in; all this does is make it visible to the worker, since
   * `claimNext` skips any video whose lease is still live.
   */
  async acquireDirectLease(userId: string, videoId: string): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const now = new Date();
    const { count } = await prisma.video.updateMany({
      where: {
        id: videoId,
        userId,
        deletedAt: null,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000) },
    });

    if (count === 0) {
      throw new ConflictError(
        "Another runner is already working on this video — either the render " +
          "worker or a second CLI run. Wait for it to finish, or cancel it " +
          "from the app, before running this again.",
      );
    }
  }

  /**
   * Renews a lease taken by `acquireDirectLease`. Unlike `heartbeat` this
   * reports nothing back: the CLI has no cooperative-cancellation loop, so
   * there is no `cancelRequested` for it to act on.
   */
  async renewDirectLease(videoId: string): Promise<void> {
    await prisma.video.updateMany({
      where: { id: videoId },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) },
    });
  }

  /** Drops a lease taken by `acquireDirectLease`, so the worker can pick the
   * video up again. Must run even when the pipeline threw. */
  async releaseDirectLease(videoId: string): Promise<void> {
    await prisma.video.updateMany({
      where: { id: videoId },
      data: { leaseExpiresAt: null },
    });
  }

  /** Queues an already-approved, idle video, or restarts a retryable
   * failure — without resetting `attempts`. See `requeue` for the guard. */
  async start(userId: string, videoId: string): Promise<void> {
    await this.requeue(userId, videoId, false, "Started by operator");
  }

  /** Like `start`, but resets `attempts` to 0 first: a deliberate operator
   * retry gets a fresh three attempts rather than picking up where the
   * automatic cap left off. See `requeue` for the guard. */
  async retry(userId: string, videoId: string): Promise<void> {
    await this.requeue(userId, videoId, true, "Retried by operator");
  }
}

export const jobService = new JobService();
