import "server-only";

import type { PublishVisibility } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { publishService, type PublishService } from "@/services/publish.service";

/**
 * The long-video drip: a video that its automation said should publish itself.
 *
 * ## What this is, and what it deliberately is not
 *
 * `ReleaseService` is the same idea for shorts, and this file copies its
 * discipline rather than inventing a second one — see `claimDue`. What is
 * different is the trigger. A release fires on a *clock*: a slot comes round and
 * whatever is banked goes out. This fires on a *state*: a video an automation
 * created reaches READY, and the job written when it was created becomes due.
 * There is no cadence here, because "publish it when it is finished" has no time
 * of day in it.
 *
 * Nothing in this file calls a model or spends provider money. The video it
 * uploads was already paid for. What it *can* spend is the operator's channel
 * reputation, which is why the switch behind it is off by default and why the
 * failure taxonomy in `executeClaim` is as careful as it is.
 */

/**
 * How long a worker holds a claimed job.
 *
 * Five minutes, the same as `ReleaseService`'s and sized to the same work: one
 * file read off local disk and one `videos.insert`. Long enough to outlast an
 * honest upload on a domestic uplink, short enough that a dead worker's job is
 * retaken on the next poll rather than stranded until somebody notices.
 */
const CLAIM_LEASE_SECONDS = 300;

/**
 * How many due jobs one claim looks at.
 *
 * Five, matching `ReleaseService`'s and `ScheduleService`'s, and for the same
 * reason: the list exists only so a lost race falls through to another row
 * instead of waiting for the next poll.
 */
const CANDIDATE_BATCH = 5;

/** A job won by `claimDue`, carrying everything `executeClaim` needs so it never
 *  re-reads a row another process may have moved underneath it. */
export interface AutoPublishClaim {
  jobId: string;
  userId: string;
  videoId: string;
  /** Read for the log line and the failure sentence, not for the upload — what
   *  title YouTube is told is `PublishService`'s business. */
  videoTitle: string;
  visibility: PublishVisibility;
  /** How many ordinary failures this job has already had. `executeClaim` needs
   *  it to decide between another backoff and giving up. */
  attempts: number;
}

export class AutoPublishService {
  /**
   * `Pick`, not the whole `PublishService`, for the reason `ReleaseService`
   * gives for the same choice: this service calls exactly one of its methods,
   * and typing the parameter as the full class would force every test to stub
   * the thumbnail path and the reclaims as well.
   */
  constructor(
    private readonly publisher: Pick<PublishService, "publish"> = publishService,
  ) {}

  /**
   * Books a video to publish itself once it is rendered.
   *
   * Called at *creation*, not at READY, and that is what freezes the visibility
   * — see `AutoPublishJob.visibility`. The job simply is not due until the video
   * reaches READY; `claimDue` joins on that, so nothing has to remember to
   * enqueue later and nothing can publish a half-rendered file.
   *
   * `createMany` with `skipDuplicates` rather than a pre-check: the `videoId`
   * unique constraint is the real guard, and the only way a row already exists
   * is a retried create path, where re-booking is a no-op rather than an error
   * worth surfacing. Note which one survives — the FIRST. A retry must not
   * rewrite what the video was made under.
   */
  async enqueue(
    userId: string,
    videoId: string,
    visibility: PublishVisibility,
  ): Promise<void> {
    await prisma.autoPublishJob.createMany({
      data: [{ userId, videoId, visibility }],
      skipDuplicates: true,
    });
  }

  /**
   * Wins exactly one due job.
   *
   * ## Why this cannot publish twice
   *
   * The same shape as `ReleaseService.claimDue`, for the same reason: Prisma's
   * `updateMany` has no `LIMIT`, so an unconditional "claim the oldest due job"
   * would let two callers both match and both believe they won. Instead: read a
   * short list of candidates, then try to win each with an update whose `where`
   * repeats the exact state just read. The conditional update *is* the lock; the
   * read above it is only a hint.
   *
   * The stake is higher here than almost anywhere else in this codebase. A lost
   * race that both callers won means the same video uploaded to the same channel
   * twice, and there is no unpublish path from this app.
   *
   * ## Why a booked job waits
   *
   * The `video` join is what makes booking-at-creation safe. A job written while
   * the video was still QUEUED is not due until it is READY, so nothing has to
   * remember to enqueue later and nothing can publish a half-rendered file.
   *
   * ## Why a lapsed claim is not a failure
   *
   * A `CLAIMED` row whose lease has passed is a worker that died mid-upload, not
   * an upload that was refused. It goes back into the running with `attempts`
   * untouched — nothing else would ever clear it, which is why this is a lease
   * and not a lock.
   */
  async claimDue(now: Date = new Date()): Promise<AutoPublishClaim | null> {
    const candidates = await prisma.autoPublishJob.findMany({
      where: {
        runAfter: { lte: now },
        video: { status: "READY", deletedAt: null },
        OR: [
          { status: "WAITING" },
          { status: "CLAIMED", leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { runAfter: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        videoId: true,
        visibility: true,
        attempts: true,
        status: true,
        video: { select: { title: true } },
      },
    });

    for (const candidate of candidates) {
      const { count } = await prisma.autoPublishJob.updateMany({
        where: {
          id: candidate.id,
          // The lock. Repeats the exact status just read, so only one caller
          // can still match. A lapsed CLAIMED row is retaken by the same pair
          // of conditions that found it — without the lease check a second
          // worker could take a job whose first worker is still uploading.
          status: candidate.status,
          ...(candidate.status === "CLAIMED"
            ? { leaseExpiresAt: { lt: now } }
            : {}),
        },
        data: {
          status: "CLAIMED",
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
        },
      });

      // Another worker won it. Fall through to the next candidate rather than
      // waiting out a whole poll interval.
      if (count === 0) continue;

      return {
        jobId: candidate.id,
        userId: candidate.userId,
        videoId: candidate.videoId,
        videoTitle: candidate.video.title,
        visibility: candidate.visibility,
        attempts: candidate.attempts,
      };
    }

    return null;
  }
}

export const autoPublishService = new AutoPublishService();
