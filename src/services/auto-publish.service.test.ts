import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { AutoPublishService } from "@/services/auto-publish.service";
import { YouTubeQuotaError } from "@/services/publish.service";
import { resolveAutoPublish } from "@/services/schedule.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The long-video drip, against a real Postgres.
 *
 * Same discipline as release.service.test.ts and schedule.service.test.ts:
 * these run against a shared database that also holds the operator's real data,
 * so every test gets its own throwaway `User` (src/test/fixtures.ts). YouTube is
 * never reached — the publisher is injected, and every test in this file passes
 * a fake one.
 *
 * What is deliberately NOT asserted here is anything about the upload itself.
 * `PublishService` has its own test file and its own fake `fetch`; this one is
 * about the queue around it — who is due, who wins the claim, and what each
 * kind of failure means.
 */

// A claim is a read, a conditional update and an update — several sequential
// round trips to a remote database, and the concurrency tests do it twice over.
vi.setConfig({ testTimeout: 40_000 });

let userId: string;
let projectId: string;

beforeEach(async () => {
  userId = await createTestUser("autopublish");
  // `Video.projectId` is required, so every video fixture needs one. No
  // channel: nothing in this file reaches the publisher for real, and a project
  // without one is the cheapest row that satisfies the foreign key.
  const project = await prisma.project.create({
    data: { userId, name: "Auto-publish fixtures" },
    select: { id: true },
  });
  projectId = project.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

/** A publisher that fails the test if it is reached. Most cases here never get
 *  as far as an upload, and a stub that silently succeeded would hide that. */
const noPublish = {
  publish: async () => {
    throw new Error("publish should not have been called");
  },
} as never;

/** A publisher whose upload always succeeds, returning the shape
 *  `PublishService.publish` really returns. */
function publishesAs(youtubeVideoId: string) {
  return {
    publish: async () => ({
      youtubeVideoId,
      shorts: [],
      thumbnail: { applied: true, error: null },
    }),
  } as never;
}

/** A publisher that always throws what it was given. */
function refusesWith(error: Error) {
  return {
    publish: async () => {
      throw error;
    },
  } as never;
}

/** A video still on its way through the pipeline. */
async function makeVideo(title = "Episode"): Promise<string> {
  const video = await prisma.video.create({
    data: { userId, projectId, title, status: "QUEUED" },
    select: { id: true },
  });
  return video.id;
}

/** A video that has finished rendering, which is the only kind a job is due
 *  for. */
async function makeReadyVideo(title = "Episode"): Promise<string> {
  const video = await prisma.video.create({
    data: { userId, projectId, title, status: "READY" },
    select: { id: true },
  });
  return video.id;
}

describe("enqueue", () => {
  it("writes a waiting job carrying the visibility it was given", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeVideo();

    await service.enqueue(userId, videoId, "PUBLIC");

    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job).not.toBeNull();
    expect(job?.status).toBe("WAITING");
    expect(job?.visibility).toBe("PUBLIC");
    expect(job?.attempts).toBe(0);
  });

  it("is idempotent, and the first booking wins", async () => {
    // A retried create path must not rewrite what the video was made under.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeVideo();

    await service.enqueue(userId, videoId, "PUBLIC");
    await service.enqueue(userId, videoId, "PRIVATE");

    const jobs = await prisma.autoPublishJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].visibility).toBe("PUBLIC");
  });

  it("books nothing for a video no automation asked for", async () => {
    // The Generate button passes no options at all. A one-off video belongs to
    // no automation, so there is no setting to read and no default to invent.
    const videoId = await makeVideo();

    const jobs = await prisma.autoPublishJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(0);
  });
});

describe("resolveAutoPublish", () => {
  it("prefers the series over the schedule underneath it", async () => {
    // The precedence, asserted at the only place it is decided. A series is
    // what the operator configures; the schedule's own copy is dead data for
    // that kind of row.
    expect(
      resolveAutoPublish(
        { autoPublish: true, publishVisibility: "PUBLIC" },
        { autoPublish: false, publishVisibility: "PRIVATE" },
      ),
    ).toBe("PUBLIC");
  });

  it("lets a series switched off win over a schedule switched on", async () => {
    // The same rule in the direction that would otherwise publish something
    // nobody asked to publish.
    expect(
      resolveAutoPublish(
        { autoPublish: false, publishVisibility: "PUBLIC" },
        { autoPublish: true, publishVisibility: "PUBLIC" },
      ),
    ).toBeNull();
  });

  it("reads a standalone schedule's own visibility when there is no series", async () => {
    expect(
      resolveAutoPublish(null, { autoPublish: true, publishVisibility: "UNLISTED" }),
    ).toBe("UNLISTED");
  });

  it("returns null when the automation is switched off", async () => {
    expect(
      resolveAutoPublish(null, { autoPublish: false, publishVisibility: "PUBLIC" }),
    ).toBeNull();
  });
});

describe("claimDue", () => {
  it("does not claim a job whose video has not rendered yet", async () => {
    // The whole reason booking early is safe. A job written while the video was
    // QUEUED is not due until the render finishes.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeVideo();
    await service.enqueue(userId, videoId, "PUBLIC");

    expect(await service.claimDue()).toBeNull();
  });

  it("claims a job whose video is READY", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo("Bedtime Stories 4");
    await service.enqueue(userId, videoId, "PUBLIC");

    const claim = await service.claimDue();

    expect(claim?.videoId).toBe(videoId);
    expect(claim?.videoTitle).toBe("Bedtime Stories 4");
    expect(claim?.visibility).toBe("PUBLIC");
    expect(claim?.attempts).toBe(0);
  });

  it("cannot be claimed twice", async () => {
    // The property that matters most in this file: a second claim means the
    // same video uploaded to the same channel twice, and there is no way to
    // take either copy down from here.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");

    const first = await service.claimDue();
    const second = await service.claimDue();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does not claim a job that is not due yet", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: { runAfter: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await service.claimDue()).toBeNull();
  });

  it("retakes a claim whose lease has lapsed, without counting a failure", async () => {
    // A dead worker is not a failed publish. Nothing else would ever clear its
    // claim, which is why this is a lease and not a lock.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: { status: "CLAIMED", leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    const claim = await service.claimDue();

    expect(claim?.videoId).toBe(videoId);
    expect(claim?.attempts).toBe(0);
  });

  it("leaves a claim whose lease is still running alone", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: {
        status: "CLAIMED",
        leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    expect(await service.claimDue()).toBeNull();
  });

  it("does not touch a deleted video's job", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.video.update({
      where: { id: videoId },
      data: { deletedAt: new Date() },
    });

    expect(await service.claimDue()).toBeNull();
  });

  it("does not reclaim a job that already finished", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: { status: "DONE" },
    });

    expect(await service.claimDue()).toBeNull();
  });
});

/** Books a READY video and wins its claim, which is the state every
 *  `executeClaim` test starts from. */
async function claimFor(service: AutoPublishService, title = "Episode") {
  const videoId = await makeReadyVideo(title);
  await service.enqueue(userId, videoId, "PUBLIC");
  const claim = await service.claimDue();

  if (!claim) throw new Error("fixture failed to claim its own job");

  return { claim, videoId };
}

describe("executeClaim", () => {
  it("marks the job DONE when the upload succeeds", async () => {
    const service = new AutoPublishService(publishesAs("yt-123"));
    const { claim, videoId } = await claimFor(service);

    const result = await service.executeClaim(claim);

    expect(result.outcome).toBe("PUBLISHED");
    expect(result.youtubeVideoId).toBe("yt-123");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("DONE");
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.error).toBeNull();
  });

  it("defers a spent quota without counting a failure", async () => {
    // A quota ceiling is a fact about the day, not a fault in the automation.
    // Every automation on the account meets it within the same hour, so
    // counting it would pause all of them on one busy Monday.
    const service = new AutoPublishService(
      refusesWith(new YouTubeQuotaError("this episode")),
    );
    const { claim, videoId } = await claimFor(service);

    const result = await service.executeClaim(claim);

    expect(result.outcome).toBe("DEFERRED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("WAITING");
    expect(job?.attempts).toBe(0);
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails immediately on a refusal a retry cannot fix", async () => {
    // PublishService refuses a video whose project and series disagree about
    // the channel. Retrying that three times over thirty-five minutes helps
    // nobody, and the operator has to change something either way.
    const service = new AutoPublishService(
      refusesWith(new ConflictError("This video is filed under a different channel.")),
    );
    const { claim, videoId } = await claimFor(service);

    const result = await service.executeClaim(claim);

    expect(result.outcome).toBe("FAILED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("FAILED");
    expect(job?.error).toContain("different channel");
  });

  it("fails immediately when the video cannot be found", async () => {
    const service = new AutoPublishService(
      refusesWith(new NotFoundError("That video no longer exists.")),
    );
    const { claim, videoId } = await claimFor(service);

    await service.executeClaim(claim);

    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("FAILED");
    // Not counted — it never got as far as being an attempt at anything.
    expect(job?.attempts).toBe(0);
  });

  it("backs off an ordinary failure and keeps the job waiting", async () => {
    const service = new AutoPublishService(refusesWith(new Error("socket hang up")));
    const { claim, videoId } = await claimFor(service);

    const result = await service.executeClaim(claim);

    expect(result.outcome).toBe("DEFERRED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("WAITING");
    expect(job?.attempts).toBe(1);
    expect(job?.error).toContain("socket hang up");
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up on the third ordinary failure", async () => {
    const service = new AutoPublishService(refusesWith(new Error("socket hang up")));
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({ where: { videoId }, data: { attempts: 2 } });
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("FAILED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("FAILED");
    expect(job?.attempts).toBe(3);
  });

  it("does not give up on the second", async () => {
    // The boundary, asserted from the other side. Off by one here is either a
    // show that stops too early or one that never stops at all.
    const service = new AutoPublishService(refusesWith(new Error("socket hang up")));
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({ where: { videoId }, data: { attempts: 1 } });
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("DEFERRED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("WAITING");
    expect(job?.attempts).toBe(2);
  });
});
