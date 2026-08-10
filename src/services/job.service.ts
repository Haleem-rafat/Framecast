import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/** How long a claim is held before another worker may take over. */
const LEASE_SECONDS = 600;
/** Renewal interval is far shorter, so a slow stage never loses its own lease. */
export const HEARTBEAT_SECONDS = 30;
/** A video that fails this many times stops costing money. */
const MAX_ATTEMPTS = 3;

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
        data: { status: "READY", leaseExpiresAt: null },
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
}

export const jobService = new JobService();
