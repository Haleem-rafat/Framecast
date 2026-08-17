import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { AutoPublishService } from "@/services/auto-publish.service";
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
});
