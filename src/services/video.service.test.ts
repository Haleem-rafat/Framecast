import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
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
});
