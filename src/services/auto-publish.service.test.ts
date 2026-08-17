import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { AutoPublishService } from "@/services/auto-publish.service";
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
