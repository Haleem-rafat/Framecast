import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";

// Tests run against a real, shared Supabase database (see src/test/setup.ts).
// Every fixture this file creates is tagged with a run-unique token so that
// a concurrent test run — or the operator's own dev app — never has rows it
// owns touched, and this file never touches rows it doesn't own.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-${RUN}`;

let userId: string;
let projectId: string | undefined;

/** Deletes only the project (and its videos) this file created for the current test. */
async function cleanupCurrentProject() {
  if (!projectId) return;
  await prisma.video.deleteMany({ where: { projectId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
}

/** Safety net for a crashed test that never reached its own cleanup. */
async function cleanupAnyStrayRuns() {
  const strays = await prisma.project.findMany({
    where: { name: PROJECT_NAME },
    select: { id: true },
  });
  const strayIds = strays.map((p) => p.id);
  if (strayIds.length === 0) return;
  await prisma.video.deleteMany({ where: { projectId: { in: strayIds } } });
  await prisma.project.deleteMany({ where: { id: { in: strayIds } } });
}

beforeEach(async () => {
  await cleanupCurrentProject();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
});

afterEach(cleanupCurrentProject);
afterAll(cleanupAnyStrayRuns);

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
