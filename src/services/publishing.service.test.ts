import { randomUUID } from "node:crypto";

import { addMinutes, subMinutes } from "date-fns";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { PublishingService } from "@/services/publishing.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same two-user arrangement as studio.service.test.ts, and for the same
// reason: `Publication` carries a `channelId` but no `userId`, so ownership
// is only ever established by walking back to the video. The second operator
// exists to be absent from every result.
const RUN = randomUUID().slice(0, 8);

let userId: string;
let otherUserId: string;
let channelId: string;
let projectId: string;
let service: PublishingService;

/**
 * A connected channel. Written with Prisma directly rather than through
 * `channelService`, which only ever creates one from a real OAuth exchange —
 * the token columns are required and are never selected into anything this
 * service returns, which is itself worth asserting below.
 */
async function createChannel(ownerId: string, title: string): Promise<string> {
  const channel = await prisma.channel.create({
    data: {
      userId: ownerId,
      youtubeChannelId: `yt-${RUN}-${randomUUID().slice(0, 8)}`,
      title,
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenExpiresAt: addMinutes(new Date(), 60),
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    },
  });

  return channel.id;
}

async function createVideo(
  ownerId: string,
  ownerProjectId: string,
  title: string,
): Promise<string> {
  const video = await videoService.create(ownerId, {
    projectId: ownerProjectId,
    title,
    topic: "how interest rates work",
  });

  return video.id;
}

beforeEach(async () => {
  userId = await createTestUser("publishing");
  otherUserId = await createTestUser("publishing-other");
  channelId = await createChannel(userId, "Ours");
  projectId = (
    await projectService.create(userId, { name: `publishing-${RUN}`, channelId })
  ).id;
  service = new PublishingService();
});

afterEach(async () => {
  await deleteTestUser(userId);
  await deleteTestUser(otherUserId);
});

describe("publications", () => {
  it("returns only the calling operator's publications", async () => {
    const videoId = await createVideo(userId, projectId, "Ours");
    await prisma.publication.create({
      data: { videoId, channelId, title: "Ours on YouTube", status: "PUBLISHED" },
    });

    const otherChannelId = await createChannel(otherUserId, "Theirs");
    const otherProjectId = (
      await projectService.create(otherUserId, {
        name: `publishing-other-${RUN}`,
        channelId: otherChannelId,
      })
    ).id;
    const otherVideoId = await createVideo(otherUserId, otherProjectId, "Theirs");
    await prisma.publication.create({
      data: {
        videoId: otherVideoId,
        channelId: otherChannelId,
        title: "Theirs on YouTube",
        status: "PUBLISHED",
      },
    });

    const { publications } = await service.getOverview(userId);

    expect(publications).toHaveLength(1);
    expect(publications[0].videoId).toBe(videoId);
  });

  it("keeps the published title beside the operator's own, because they differ", async () => {
    // Publication.title is what was sent to YouTube — a generated title,
    // clamped to 100 characters — and Video.title is what the operator typed.
    // Collapsing the two would hide which one an audience actually sees.
    const videoId = await createVideo(userId, projectId, "Working title");
    await prisma.publication.create({
      data: {
        videoId,
        channelId,
        title: "How Interest Rates Actually Work",
        status: "PUBLISHED",
        youtubeVideoId: "abc123",
        thumbnailApplied: true,
      },
    });

    const [entry] = (await service.getOverview(userId)).publications;

    expect(entry.videoTitle).toBe("Working title");
    expect(entry.title).toBe("How Interest Rates Actually Work");
    expect(entry.channelTitle).toBe("Ours");
    expect(entry.youtubeVideoId).toBe("abc123");
    expect(entry.thumbnailApplied).toBe(true);
  });

  it("never carries the channel's OAuth tokens into what the page receives", async () => {
    // Channel holds the access and refresh tokens whose exposure is a
    // security incident (see the model's own comment), and this payload
    // crosses to the browser. A `select` widened by accident is exactly the
    // regression this catches.
    const videoId = await createVideo(userId, projectId, "Ours");
    await prisma.publication.create({
      data: { videoId, channelId, title: "Ours", status: "PUBLISHED" },
    });

    const [entry] = (await service.getOverview(userId)).publications;

    expect(JSON.stringify(entry)).not.toContain("test-access-token");
    expect(JSON.stringify(entry)).not.toContain("test-refresh-token");
  });

  it("reports a scheduled publish as due rather than as already live", async () => {
    // publish.service.ts deliberately leaves publishedAt null for a SCHEDULED
    // row: the column means "when this went live", and YouTube has not made
    // it live yet.
    const videoId = await createVideo(userId, projectId, "Later");
    const scheduledFor = addMinutes(new Date(), 60);
    await prisma.publication.create({
      data: {
        videoId,
        channelId,
        title: "Later",
        status: "SCHEDULED",
        visibility: "PUBLIC",
        scheduledFor,
      },
    });

    const [entry] = (await service.getOverview(userId)).publications;

    expect(entry.status).toBe("SCHEDULED");
    expect(entry.publishedAt).toBeNull();
    expect(entry.scheduledFor?.getTime()).toBe(scheduledFor.getTime());
  });

  it("carries a failed publish's reason, since it is the only account of it", async () => {
    const videoId = await createVideo(userId, projectId, "Broken");
    await prisma.publication.create({
      data: {
        videoId,
        channelId,
        title: "Broken",
        status: "FAILED",
        error: "The YouTube upload failed (500).",
      },
    });

    const [entry] = (await service.getOverview(userId)).publications;

    expect(entry.status).toBe("FAILED");
    expect(entry.error).toBe("The YouTube upload failed (500).");
  });
});

describe("readyToPublish", () => {
  it("lists a rendered video that nothing has claimed", async () => {
    const videoId = await createVideo(userId, projectId, "Finished");
    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });

    const { readyToPublish } = await service.getOverview(userId);

    expect(readyToPublish).toHaveLength(1);
    expect(readyToPublish[0].videoId).toBe(videoId);
    expect(readyToPublish[0].channelTitle).toBe("Ours");
    expect(readyToPublish[0].isFinalizing).toBe(false);
  });

  it("excludes a video that already has a publication, whatever its state", async () => {
    // The Publication row is created *before* the upload as publish()'s
    // concurrency claim, so an in-flight or failed attempt blocks a second
    // publish just as a successful one does. Offering such a video as "ready"
    // would send the operator into a guaranteed ConflictError.
    const videoId = await createVideo(userId, projectId, "Claimed");
    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });
    await prisma.publication.create({
      data: { videoId, channelId, title: "Claimed", status: "FAILED", error: "nope" },
    });

    expect((await service.getOverview(userId)).readyToPublish).toHaveLength(0);
  });

  it("excludes videos that have not finished rendering", async () => {
    await createVideo(userId, projectId, "Still a draft");

    expect((await service.getOverview(userId)).readyToPublish).toHaveLength(0);
  });

  it("flags a video whose worker is still generating metadata and a thumbnail", async () => {
    // A live lease on a READY video is proof runPipeline's metadata and
    // thumbnail stages are still in flight — the same signal publish() itself
    // refuses on, and the same one PipelineState.isFinalizing reads.
    const videoId = await createVideo(userId, projectId, "Nearly");
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "READY", leaseExpiresAt: addMinutes(new Date(), 5) },
    });

    expect((await service.getOverview(userId)).readyToPublish[0].isFinalizing).toBe(true);
  });

  it("does not flag a video whose worker died and left a lapsed lease", async () => {
    // A lapsed lease means the holder died, not that anything is still
    // running — the video has had its one automatic chance and is publishable.
    const videoId = await createVideo(userId, projectId, "Abandoned");
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "READY", leaseExpiresAt: subMinutes(new Date(), 5) },
    });

    expect((await service.getOverview(userId)).readyToPublish[0].isFinalizing).toBe(false);
  });

  it("reports a missing channel rather than omitting the video", async () => {
    // publish() refuses a video whose project has no channel. Hiding it here
    // would leave the operator with a finished video and no explanation; the
    // page states the blocker instead.
    const bareProjectId = (
      await projectService.create(userId, { name: `publishing-bare-${RUN}` })
    ).id;
    const videoId = await createVideo(userId, bareProjectId, "No channel");
    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });

    const [entry] = (await service.getOverview(userId)).readyToPublish;

    expect(entry.videoId).toBe(videoId);
    expect(entry.channelTitle).toBeNull();
  });

  it("excludes another operator's rendered videos", async () => {
    const otherProjectId = (
      await projectService.create(otherUserId, { name: `publishing-other-${RUN}` })
    ).id;
    const otherVideoId = await createVideo(otherUserId, otherProjectId, "Theirs");
    await prisma.video.update({
      where: { id: otherVideoId },
      data: { status: "READY" },
    });

    expect((await service.getOverview(userId)).readyToPublish).toHaveLength(0);
  });
});
