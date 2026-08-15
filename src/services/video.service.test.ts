import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
// that also holds the operator's real data. Every test in this file gets its
// own private, throwaway User (see src/test/fixtures.ts) instead of the
// operator's real account, so this file's fixtures can never collide with —
// or be mistaken for — the operator's real projects/videos.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-${RUN}`;

let userId: string;
let projectId: string | undefined;

beforeEach(async () => {
  userId = await createTestUser("video");
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
});

// Deleting the user cascades away every fixture (project, video, and its
// pipeline children) the test created.
afterEach(() => deleteTestUser(userId));

/**
 * Builds a DRAFT video with a non-empty active ScriptVersion — the minimum
 * state approveScript needs to succeed — bypassing the (not-yet-built)
 * script service since Task 8 only owns project/video/prompt services.
 */
async function createApprovableVideo() {
  const video = await videoService.create(userId, {
    projectId: projectId as string,
    title: "Ready for approval",
    topic: "approval race",
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content: "Full script content." },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return video.id;
}

describe("videoService", () => {
  it("creates a video in DRAFT", async () => {
    const video = await videoService.create(userId, {
      projectId: projectId as string,
      title: "How inflation actually works",
      topic: "inflation",
    });

    expect(video.status).toBe("DRAFT");
  });

  it("refuses approval while there is no script", async () => {
    const video = await videoService.create(userId, {
      projectId: projectId as string,
      title: "No script yet",
      topic: "x",
    });

    await expect(videoService.approveScript(userId, video.id)).rejects.toThrow(
      ConflictError,
    );
  });

  it("hides another user's videos", async () => {
    const video = await videoService.create(userId, {
      projectId: projectId as string,
      title: "Mine",
      topic: "x",
    });

    await expect(
      videoService.get("00000000-0000-4000-8000-000000000001", video.id),
    ).rejects.toThrow();
  });

  // Gate 2's confirmation dialog (publish-video-button.tsx) reads the
  // project's assigned channel and any Publication straight off this
  // method's return value — this is the coverage that its shape is actually
  // there, not just assumed from the schema.
  it("includes the project's assigned channel and any publication", async () => {
    const channel = await channelService.connect(userId, {
      youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
      title: "Money Mechanics",
      accessToken: "ya29.test-access-token",
      refreshToken: "1//test-refresh-token",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });
    const channelProjectId = (
      await projectService.create(userId, {
        name: `${PROJECT_NAME}-channel`,
        channelId: channel.id,
      })
    ).id;

    const video = await videoService.create(userId, {
      projectId: channelProjectId,
      title: "Has a channel",
      topic: "x",
    });

    const beforePublish = await videoService.get(userId, video.id);
    expect(beforePublish.project.channel?.title).toBe("Money Mechanics");
    expect(beforePublish.publication).toBeNull();

    await prisma.publication.create({
      data: {
        videoId: video.id,
        channelId: channel.id,
        title: "Has a channel",
        visibility: "UNLISTED",
        status: "PUBLISHED",
        youtubeVideoId: "yt_test123",
      },
    });

    const afterPublish = await videoService.get(userId, video.id);
    expect(afterPublish.publication?.youtubeVideoId).toBe("yt_test123");
  });

  it("appends exactly one event when approved concurrently", async () => {
    const videoId = await createApprovableVideo();

    const results = await Promise.allSettled([
      videoService.approveScript(userId, videoId),
      videoService.approveScript(userId, videoId),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const events = await prisma.videoStatusEvent.count({
      where: { videoId, to: "QUEUED" },
    });
    expect(events).toBe(1);
  });

  it("records the format the operator approved, and only then", async () => {
    const videoId = await createApprovableVideo();

    // A draft has not chosen anything yet. The column defaults to LANDSCAPE
    // because that is what every video made before formats existed factually
    // is, not because a draft has decided to be one.
    const draft = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(draft.format).toBe("LANDSCAPE");

    await videoService.approveScript(userId, videoId, "VERTICAL");

    const approved = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(approved.format).toBe("VERTICAL");
    expect(approved.status).toBe("QUEUED");
  });

  it("keeps landscape for a caller that does not choose", async () => {
    // Gate 1's default, and the reason every existing caller — the script
    // service's own tests, the fixtures — is unaffected by the new parameter.
    const videoId = await createApprovableVideo();

    await videoService.approveScript(userId, videoId);

    const approved = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(approved.format).toBe("LANDSCAPE");
  });

  it("names the format in the status event, not only in the column", async () => {
    // VideoStatusEvent is the append-only record of what was asked for, and
    // "which shape did I approve this as" is exactly the question asked later
    // of a video whose render nobody is happy with.
    const videoId = await createApprovableVideo();

    await videoService.approveScript(userId, videoId, "VERTICAL");

    const event = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId, to: "QUEUED" },
    });
    expect(event.message).toContain("1080×1920");
  });

  it("surfaces the format on the list the videos page renders", async () => {
    const videoId = await createApprovableVideo();
    await videoService.approveScript(userId, videoId, "VERTICAL");

    const listed = await videoService.list(userId);
    const row = listed.find((video) => video.id === videoId);

    expect(row?.format).toBe("VERTICAL");
  });

  it("soft-deletes a video rather than removing the row", async () => {
    const videoId = await createApprovableVideo();

    await videoService.remove(userId, videoId);

    const row = await prisma.video.findUnique({ where: { id: videoId } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();

    await expect(videoService.get(userId, videoId)).rejects.toThrow(NotFoundError);
  });

  // Deleting a row a worker is mid-write to is a correctness problem, not a UI
  // nicety — the operator has to cancel the run first.
  it("refuses to delete a video a worker currently holds", async () => {
    const videoId = await createApprovableVideo();
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: "RENDERING",
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await expect(videoService.remove(userId, videoId)).rejects.toThrow(ConflictError);

    const row = await prisma.video.findUnique({ where: { id: videoId } });
    expect(row?.deletedAt).toBeNull();
  });

  it("deletes a video whose worker died, leaving a lapsed lease", async () => {
    const videoId = await createApprovableVideo();
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "RENDERING", leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(videoService.remove(userId, videoId)).resolves.toBeUndefined();
  });

  it("skips the busy ones in a bulk delete instead of failing the batch", async () => {
    const free = await createApprovableVideo();
    const busy = await createApprovableVideo();
    await prisma.video.update({
      where: { id: busy },
      data: {
        status: "GENERATING",
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const result = await videoService.removeMany(userId, [free, busy]);

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    const busyRow = await prisma.video.findUnique({ where: { id: busy } });
    expect(busyRow?.deletedAt).toBeNull();
  });

  /**
   * The video list's "Delete selected" posts whatever ids are checked in the
   * browser, so the only thing standing between a forged payload and another
   * operator's back catalogue is the `userId` in `removeMany`'s `where`. It is
   * one clause in one query and nothing else re-checks it — which is exactly
   * why it is asserted here rather than assumed.
   */
  it("cannot bulk-delete a video another operator owns", async () => {
    const mine = await createApprovableVideo();

    const strangerId = await createTestUser("video-stranger");
    try {
      const strangerProject = await projectService.create(strangerId, {
        name: `stranger-${RUN}`,
      });
      const theirs = await videoService.create(strangerId, {
        projectId: strangerProject.id,
        title: "Not yours",
        topic: "ownership",
      });

      // Both ids in one batch: the foreign one has to be skipped without
      // taking the legitimate one down with it.
      const result = await videoService.removeMany(userId, [mine, theirs.id]);

      expect(result.deletedCount).toBe(1);
      expect(result.skippedCount).toBe(1);

      const theirRow = await prisma.video.findUnique({ where: { id: theirs.id } });
      expect(theirRow?.deletedAt).toBeNull();
    } finally {
      await deleteTestUser(strangerId);
    }
  });
});
