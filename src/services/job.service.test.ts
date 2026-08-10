import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { VideoStatus } from "@/generated/prisma/enums";
import { jobService } from "@/services/job.service";
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
