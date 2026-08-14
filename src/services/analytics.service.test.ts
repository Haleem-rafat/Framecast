import { randomUUID } from "node:crypto";

import { subDays } from "date-fns";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VideoStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { createTestUser, deleteTestUser } from "@/test/fixtures";
import { analyticsService } from "@/services/analytics.service";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";

let userId: string;
let projectId: string;

beforeEach(async () => {
  userId = await createTestUser("analytics");
  const project = await projectService.create(userId, {
    name: `Analytics project ${randomUUID().slice(0, 8)}`,
  });
  projectId = project.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

async function createVideo(status: VideoStatus = "DRAFT") {
  const video = await videoService.create(userId, {
    projectId,
    title: `Analytics video ${randomUUID().slice(0, 8)}`,
    topic: "analytics test topic",
  });

  if (status !== "DRAFT") {
    await prisma.video.update({ where: { id: video.id }, data: { status } });
  }

  return video.id;
}

/** A finished render with a known wall-clock duration. */
async function addRender(
  videoId: string,
  opts: { status: "SUCCEEDED" | "FAILED" | "CANCELLED"; durationSeconds?: number },
) {
  const startedAt = new Date();
  const finishedAt = opts.durationSeconds
    ? new Date(startedAt.getTime() + opts.durationSeconds * 1000)
    : null;

  return prisma.renderJob.create({
    data: {
      videoId,
      status: opts.status,
      startedAt,
      finishedAt,
    },
  });
}

describe("analyticsService.getOverview — scoping", () => {
  it("counts only the caller's videos, renders and publications", async () => {
    const otherUserId = await createTestUser("analytics-other");

    try {
      const otherProject = await projectService.create(otherUserId, {
        name: `Other project ${randomUUID().slice(0, 8)}`,
      });
      const theirVideo = await videoService.create(otherUserId, {
        projectId: otherProject.id,
        title: "Their video",
        topic: "their topic",
      });
      await addRender(theirVideo.id, {
        status: "SUCCEEDED",
        durationSeconds: 999,
      });

      const mine = await createVideo("READY");
      await addRender(mine, { status: "SUCCEEDED", durationSeconds: 10 });

      const overview = await analyticsService.getOverview(userId);
      const totalVideos = overview.videosByStatus.reduce(
        (sum, row) => sum + row.count,
        0,
      );

      expect(totalVideos).toBe(1);
      expect(overview.render.succeeded).toBe(1);
      // Their 999-second render must not have reached my timings at all.
      expect(overview.render.longestSeconds).toBe(10);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("excludes soft-deleted videos and their renders", async () => {
    const kept = await createVideo("READY");
    await addRender(kept, { status: "SUCCEEDED", durationSeconds: 5 });

    const removed = await createVideo("READY");
    await addRender(removed, { status: "SUCCEEDED", durationSeconds: 60 });
    await prisma.video.update({
      where: { id: removed },
      data: { deletedAt: new Date() },
    });

    const overview = await analyticsService.getOverview(userId);

    expect(
      overview.videosByStatus.reduce((sum, row) => sum + row.count, 0),
    ).toBe(1);
    expect(overview.render.succeeded).toBe(1);
    expect(overview.render.longestSeconds).toBe(5);
  });
});

describe("analyticsService.getOverview — render timings", () => {
  it("reports median, p90 and longest over successful renders only", async () => {
    const videoId = await createVideo();

    for (const durationSeconds of [10, 20, 30, 40, 100]) {
      await addRender(videoId, { status: "SUCCEEDED", durationSeconds });
    }
    // A failed render is counted in the tally but must never be timed —
    // its duration is the time to fail, not the time to produce a video.
    await addRender(videoId, { status: "FAILED", durationSeconds: 5000 });

    const { render } = await analyticsService.getOverview(userId);

    expect(render.timedCount).toBe(5);
    expect(render.succeeded).toBe(5);
    expect(render.failed).toBe(1);
    // Nearest-rank over [10,20,30,40,100].
    expect(render.medianSeconds).toBe(30);
    expect(render.p90Seconds).toBe(100);
    expect(render.longestSeconds).toBe(100);
  });

  it("leaves timings null when no render recorded both timestamps", async () => {
    const videoId = await createVideo();
    // Started but never finished — a render still in flight, or one whose
    // worker died. It has no duration, and must not be reported as zero.
    await addRender(videoId, { status: "SUCCEEDED" });

    const { render } = await analyticsService.getOverview(userId);

    expect(render.timedCount).toBe(0);
    expect(render.medianSeconds).toBeNull();
    expect(render.p90Seconds).toBeNull();
    expect(render.longestSeconds).toBeNull();
  });

  it("ignores renders older than the analytics window", async () => {
    const videoId = await createVideo();
    const old = await addRender(videoId, {
      status: "SUCCEEDED",
      durationSeconds: 42,
    });
    await prisma.renderJob.update({
      where: { id: old.id },
      data: { createdAt: subDays(new Date(), 45) },
    });

    const { render } = await analyticsService.getOverview(userId);

    expect(render.succeeded).toBe(0);
    expect(render.timedCount).toBe(0);
  });
});

describe("analyticsService.getOverview — publishing", () => {
  it("reports thumbnail attachment against published publications only", async () => {
    const channel = await channelService.connect(userId, {
      youtubeChannelId: `UC_analytics_${randomUUID().slice(0, 8)}`,
      title: "Analytics channel",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });

    const withThumbnail = await createVideo("PUBLISHED");
    const withoutThumbnail = await createVideo("PUBLISHED");
    const stillPending = await createVideo("READY");

    await prisma.publication.createMany({
      data: [
        {
          videoId: withThumbnail,
          channelId: channel.id,
          title: "A",
          status: "PUBLISHED",
          thumbnailApplied: true,
        },
        {
          videoId: withoutThumbnail,
          channelId: channel.id,
          title: "B",
          status: "PUBLISHED",
          thumbnailApplied: false,
        },
        {
          videoId: stillPending,
          channelId: channel.id,
          title: "C",
          status: "PENDING",
          thumbnailApplied: false,
        },
      ],
    });

    const { publish } = await analyticsService.getOverview(userId);

    expect(publish.published).toBe(2);
    expect(publish.thumbnailApplied).toBe(1);
    expect(
      publish.byStatus.find((row) => row.status === "PENDING")?.count,
    ).toBe(1);
  });
});

describe("analyticsService.getOverview — provider usage", () => {
  it("returns one gap-free point per day across the window", async () => {
    const { usage, windowDays } = await analyticsService.getOverview(userId);

    // ProviderUsage has no owner, so this cannot assert on figures without
    // depending on whatever else is in the shared database. The shape of the
    // series is the part this service is responsible for.
    expect(usage.dailyTruncated || usage.daily.length === windowDays).toBe(true);
    expect(usage.totalFailures).toBeLessThanOrEqual(usage.totalRequests);
    for (const row of usage.byOperation) {
      expect(row.failures).toBeLessThanOrEqual(row.requests);
    }
  });
});
