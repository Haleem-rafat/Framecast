import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { VideoStatus } from "@/generated/prisma/enums";
import { jobService, MAX_ATTEMPTS } from "@/services/job.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// that also holds the operator's real data. Every test in this file gets its
// own private, throwaway User (see src/test/fixtures.ts) instead of the
// operator's real account, so this file's own fixtures can never collide with
// — or be mistaken for — the operator's real projects/videos.
let userId: string;
let projectId: string;

beforeEach(async () => {
  userId = await createTestUser("job");
  const project = await prisma.project.create({
    data: { userId, name: `job-${randomUUID()}` },
  });
  projectId = project.id;
});

// Deleting the user cascades away every video this file created.
afterEach(() => deleteTestUser(userId));

/**
 * Creates a Video directly via prisma, bypassing `videoService.create`
 * (which always starts a video at DRAFT) so tests can drop a video into
 * whatever stage of the pipeline `jobService` needs to see.
 */
async function createVideo(
  overrides: {
    status?: VideoStatus;
    leaseExpiresAt?: Date | null;
    attempts?: number;
    cancelRequestedAt?: Date | null;
  } = {},
): Promise<string> {
  const video = await prisma.video.create({
    data: {
      userId,
      projectId,
      title: "Test video",
      status: overrides.status ?? "QUEUED",
      leaseExpiresAt: overrides.leaseExpiresAt ?? null,
      attempts: overrides.attempts ?? 0,
      cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    },
  });
  return video.id;
}

async function resetToQueued(videoId: string): Promise<void> {
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: "QUEUED",
      leaseExpiresAt: null,
      attempts: 0,
      cancelRequestedAt: null,
    },
  });
}

describe("jobService.claimNext", () => {
  // claimNext scans every Video row system-wide by design — there is no
  // per-user queue for it to look in, `Video.status = QUEUED` *is* the
  // queue. Run unmodified against the shared Supabase database, that scan
  // would also see the operator's own real QUEUED videos (there are several
  // as of this writing) and could actually claim one: flip it to
  // GENERATING, burn one of its three retry attempts, and leave a fake
  // "Claimed by worker-a" line in its permanent VideoStatusEvent history —
  // exactly the kind of accidental mutation of real operator data the rest
  // of this suite goes out of its way to avoid (see fixtures.ts).
  //
  // Shield every real, currently-claimable video (owned by someone other
  // than this test's own throwaway user) for the duration of each test in
  // this block: push its `leaseExpiresAt` far into the future, which is the
  // one condition that excludes a row from every branch of claimNext's
  // candidate query, without touching its `status`, `attempts`, or anything
  // else about it. The exact original value is restored in `afterEach`, so
  // the shield never outlives a single test.
  const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");
  let shielded: { id: string; leaseExpiresAt: Date | null }[] = [];

  beforeEach(async () => {
    const real = await prisma.video.findMany({
      where: {
        userId: { not: userId },
        deletedAt: null,
        OR: [{ status: "QUEUED" }, { status: { in: ["GENERATING", "RENDERING"] } }],
      },
      select: { id: true, leaseExpiresAt: true },
    });

    shielded = real;

    if (real.length > 0) {
      await prisma.video.updateMany({
        where: { id: { in: real.map((v) => v.id) } },
        data: { leaseExpiresAt: FAR_FUTURE },
      });
    }
  });

  afterEach(async () => {
    await Promise.all(
      shielded.map((v) =>
        prisma.video.update({
          where: { id: v.id },
          data: { leaseExpiresAt: v.leaseExpiresAt },
        }),
      ),
    );
    shielded = [];
  });

  it("gives one video to exactly one of two concurrent claimers", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    // Gate 1's equivalent race (VideoService.approveScript) reproduced in
    // only 2 of 3 runs, so a single green run here proves nothing.
    for (let run = 0; run < 10; run++) {
      await resetToQueued(videoId);

      const [a, b] = await Promise.all([
        jobService.claimNext("worker-a"),
        jobService.claimNext("worker-b"),
      ]);

      const claims = [a, b].filter((c) => c?.videoId === videoId);
      expect(claims).toHaveLength(1);
    }
  });

  it("returns null when nothing is queued", async () => {
    const result = await jobService.claimNext("worker-a");
    expect(result).toBeNull();
  });

  it("reclaims a video whose lease has expired", async () => {
    // Simulates a worker that died mid-render: lease in the past, status
    // still GENERATING. Without this the video is stranded forever.
    const videoId = await createVideo({
      status: "GENERATING",
      leaseExpiresAt: new Date(Date.now() - 1000),
      attempts: 1,
    });

    const claim = await jobService.claimNext("worker-b");

    expect(claim?.videoId).toBe(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("GENERATING");
    expect(video.attempts).toBe(2);
    expect(video.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not claim a video whose lease is still valid", async () => {
    const videoId = await createVideo({
      status: "GENERATING",
      leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      attempts: 1,
    });

    const claim = await jobService.claimNext("worker-a");

    const claims = claim?.videoId === videoId ? [claim] : [];
    expect(claims).toHaveLength(0);
  });

  it("refuses a video that has already failed three times", async () => {
    const videoId = await createVideo({ status: "QUEUED", attempts: 3 });

    const claim = await jobService.claimNext("worker-a");

    const claims = claim?.videoId === videoId ? [claim] : [];
    expect(claims).toHaveLength(0);
  });

  it("increments attempts on each claim", async () => {
    const videoId = await createVideo({ status: "QUEUED", attempts: 0 });

    await jobService.claimNext("worker-a");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.attempts).toBe(1);
  });

  // Lives in this block, not with the other acquireDirectLease tests, because
  // it calls claimNext — and claimNext scans every video system-wide, so it
  // needs the shield this block installs.
  it("does not claim a video the CLI holds a direct lease on", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    await jobService.acquireDirectLease(userId, videoId);

    const claimed = await jobService.claimNext("worker-a");
    expect(claimed?.videoId).not.toBe(videoId);

    await jobService.releaseDirectLease(videoId);

    const afterRelease = await jobService.claimNext("worker-a");
    expect(afterRelease?.videoId).toBe(videoId);
  });
});

describe("jobService.heartbeat", () => {
  it("extends the lease", async () => {
    const videoId = await createVideo({
      status: "GENERATING",
      leaseExpiresAt: new Date(Date.now() - 1000),
    });

    await jobService.heartbeat(videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a cancellation request", async () => {
    const videoId = await createVideo({
      status: "GENERATING",
      cancelRequestedAt: new Date(),
    });

    const result = await jobService.heartbeat(videoId);

    expect(result.cancelRequested).toBe(true);
  });

  it("reports no cancellation request when none was made", async () => {
    const videoId = await createVideo({ status: "GENERATING" });

    const result = await jobService.heartbeat(videoId);

    expect(result.cancelRequested).toBe(false);
  });
});

describe("jobService.release", () => {
  it("moves a succeeded video to READY and appends one event", async () => {
    const videoId = await createVideo({
      status: "RENDERING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await jobService.release(videoId, "succeeded");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
    expect(video.leaseExpiresAt).toBeNull();

    const events = await prisma.videoStatusEvent.count({
      where: { videoId, to: "READY" },
    });
    expect(events).toBe(1);
  });

  it("clears the lease so a failed video can be retried", async () => {
    const videoId = await createVideo({
      status: "GENERATING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attempts: 1,
    });

    await jobService.release(videoId, "failed", "provider timed out");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.leaseExpiresAt).toBeNull();
    // Retryable: attempts was already incremented by claimNext, release does
    // not touch it further, and it is still below MAX_ATTEMPTS.
    expect(video.attempts).toBe(1);
  });

  it("records the reason on failure", async () => {
    const videoId = await createVideo({ status: "RENDERING" });

    await jobService.release(videoId, "failed", "ffmpeg exited with code 1");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.failureReason).toBe("ffmpeg exited with code 1");

    const event = await prisma.videoStatusEvent.findFirst({
      where: { videoId, to: "FAILED" },
    });
    expect(event?.message).toBe("ffmpeg exited with code 1");
  });

  it("clears both the lease and the cancel flag on cancellation", async () => {
    const videoId = await createVideo({
      status: "GENERATING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      cancelRequestedAt: new Date(),
    });

    await jobService.release(videoId, "cancelled", "Cancelled by eramdevteam@gmail.com");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.leaseExpiresAt).toBeNull();
    expect(video.cancelRequestedAt).toBeNull();
    expect(video.failureReason).toBe("Cancelled by eramdevteam@gmail.com");
  });
});

describe("jobService.requestCancel", () => {
  it("flags a video that is actively being processed", async () => {
    const videoId = await createVideo({ status: "GENERATING" });

    await jobService.requestCancel(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.cancelRequestedAt).not.toBeNull();
  });

  it("refuses to cancel a video that is not being processed", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    await expect(jobService.requestCancel(userId, videoId)).rejects.toThrow(ConflictError);
  });

  it("refuses a video that does not belong to the caller", async () => {
    const videoId = await createVideo({ status: "GENERATING" });

    await expect(
      jobService.requestCancel("00000000-0000-4000-8000-000000000001", videoId),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("jobService.start", () => {
  it("re-affirms an already-queued, idle video: QUEUED with a clear lease", async () => {
    const videoId = await createVideo({
      status: "QUEUED",
      leaseExpiresAt: new Date(Date.now() + 1000),
    });

    await jobService.start(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
    expect(video.leaseExpiresAt).toBeNull();
  });

  it("requeues a retryable FAILED video without resetting attempts", async () => {
    const videoId = await createVideo({ status: "FAILED", attempts: 1 });

    await jobService.start(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
    expect(video.attempts).toBe(1);

    const event = await prisma.videoStatusEvent.findFirst({
      where: { videoId, to: "QUEUED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event?.from).toBe("FAILED");
  });

  it("refuses a FAILED video that has exhausted its attempts", async () => {
    const videoId = await createVideo({ status: "FAILED", attempts: MAX_ATTEMPTS });

    await expect(jobService.start(userId, videoId)).rejects.toThrow(ConflictError);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
  });

  it.each(["DRAFT", "GENERATING", "RENDERING", "READY", "PUBLISHED"] as const)(
    "refuses a %s video",
    async (status) => {
      const videoId = await createVideo({ status });

      await expect(jobService.start(userId, videoId)).rejects.toThrow(ConflictError);
    },
  );

  it("refuses a video that does not belong to the caller", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    await expect(
      jobService.start("00000000-0000-4000-8000-000000000001", videoId),
    ).rejects.toThrow(NotFoundError);
  });

  it("lets the FAILED -> QUEUED transition happen exactly once under a race", async () => {
    // `start` treats QUEUED as a valid (idempotent) starting point as well as
    // FAILED, so two concurrent calls racing a FAILED video are not
    // guaranteed to produce exactly one *successful call* — whichever call's
    // read lands after the winner's write simply finds the video already
    // QUEUED and re-affirms it, harmlessly (that is the same "already
    // queued, idle" case Run always permits). What must never happen is the
    // FAILED -> QUEUED transition itself firing twice — that's the one
    // Postgres's row lock actually guards, the same mechanism proven safe by
    // claimNext's own concurrency test above. So: assert on the transition,
    // not on how many of the two calls happened to resolve.
    const videoId = await createVideo({ status: "FAILED", attempts: 1 });

    // Gate 1's equivalent race (VideoService.approveScript) reproduced in
    // only 2 of 3 runs, so a single green run here proves nothing. Counted
    // cumulatively (never wiped between runs) rather than reset every
    // iteration, to save a round trip against this suite's real, long-haul
    // database — after `run + 1` resets there must be exactly `run + 1` such
    // transitions, never two from the same race.
    for (let run = 0; run < 10; run++) {
      await prisma.video.update({
        where: { id: videoId },
        data: { status: "FAILED", attempts: 1, leaseExpiresAt: null },
      });

      const results = await Promise.allSettled([
        jobService.start(userId, videoId),
        jobService.start(userId, videoId),
      ]);

      // At least one must have won — a race can never leave the video worse
      // off than before either call.
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.status).toBe("QUEUED");

      const transitions = await prisma.videoStatusEvent.count({
        where: { videoId, from: "FAILED", to: "QUEUED" },
      });
      expect(transitions).toBe(run + 1);
    }
  }, 30_000);
});

describe("jobService.retry", () => {
  it("requeues a FAILED video and resets attempts to 0", async () => {
    const videoId = await createVideo({ status: "FAILED", attempts: 2 });

    await jobService.retry(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
    expect(video.attempts).toBe(0);
  });

  it("refuses a FAILED video that has already exhausted its attempts", async () => {
    const videoId = await createVideo({ status: "FAILED", attempts: MAX_ATTEMPTS });

    await expect(jobService.retry(userId, videoId)).rejects.toThrow(ConflictError);
  });

  it("lets the FAILED -> QUEUED transition happen exactly once under a race", async () => {
    // Same reasoning as jobService.start's equivalent test above: assert on
    // the transition that must never double-fire, not on how many of the two
    // racing calls happened to resolve successfully.
    const videoId = await createVideo({ status: "FAILED", attempts: 2 });

    // Cumulative for the same reason as jobService.start's version above.
    for (let run = 0; run < 10; run++) {
      await prisma.video.update({
        where: { id: videoId },
        data: { status: "FAILED", attempts: 2, leaseExpiresAt: null },
      });

      const results = await Promise.allSettled([
        jobService.retry(userId, videoId),
        jobService.retry(userId, videoId),
      ]);

      expect(results.some((r) => r.status === "fulfilled")).toBe(true);

      const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(video.status).toBe("QUEUED");
      expect(video.attempts).toBe(0);

      const transitions = await prisma.videoStatusEvent.count({
        where: { videoId, from: "FAILED", to: "QUEUED" },
      });
      expect(transitions).toBe(run + 1);
    }
  }, 30_000);
});

describe("jobService.acquireDirectLease — the CLI must be visible to the worker", () => {
  it("refuses a second runner while a lease is live, and allows one once it lapses", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    await jobService.acquireDirectLease(userId, videoId);
    await expect(jobService.acquireDirectLease(userId, videoId)).rejects.toThrow(ConflictError);

    await prisma.video.update({
      where: { id: videoId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    await expect(jobService.acquireDirectLease(userId, videoId)).resolves.toBeUndefined();
  });

  it("refuses a video that does not belong to the caller", async () => {
    const videoId = await createVideo({ status: "QUEUED" });

    await expect(
      jobService.acquireDirectLease("00000000-0000-4000-8000-000000000001", videoId),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("jobService.start — recovering wedged videos", () => {
  // Nothing but the worker's own `release` ever cleared `cancelRequestedAt`,
  // and `claimNext` skips any video that has it set. A cancel whose worker
  // died before its next heartbeat — or one pressed during a CLI run, which
  // never reads the flag at all — therefore left the video permanently
  // unclaimable, with a Cancel button that did nothing.
  it("clears a stale cancel request so the video can be claimed again", async () => {
    const videoId = await createVideo({
      status: "FAILED",
      attempts: 1,
      cancelRequestedAt: new Date(),
    });

    await jobService.start(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
    expect(video.cancelRequestedAt).toBeNull();
  });

  it("reclaims a video stranded mid-flight by a worker that died", async () => {
    const videoId = await createVideo({
      status: "RENDERING",
      leaseExpiresAt: new Date(Date.now() - 60_000),
      cancelRequestedAt: new Date(),
    });

    await jobService.start(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
    expect(video.leaseExpiresAt).toBeNull();
    expect(video.cancelRequestedAt).toBeNull();
  });

  // The other half of that guard: a live lease means a worker really is
  // holding this video, and requeuing it would pull the row out from under a
  // render that is still running.
  it("refuses to reclaim a video whose worker still holds a live lease", async () => {
    const videoId = await createVideo({
      status: "RENDERING",
      leaseExpiresAt: new Date(Date.now() + 600_000),
    });

    await expect(jobService.start(userId, videoId)).rejects.toThrow(ConflictError);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("RENDERING");
  });
});
