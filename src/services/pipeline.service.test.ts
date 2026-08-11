import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { MAX_ATTEMPTS } from "@/services/job.service";
import { PipelineService } from "@/services/pipeline.service";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";
import { formatDuration } from "@/utils/format";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// that also holds the operator's real data. Every test gets its own private,
// throwaway User (see src/test/fixtures.ts). This file only ever reads rows
// it writes itself directly via prisma — narration/footage/render are owned
// by other concurrently-active tasks' services, matching the fixture
// convention render.service.test.ts already established ("these rows are
// created directly ... render.service only ever reads the rows those
// services produce"). storagePath values below are plain strings, never
// actually uploaded — pipelineService never reads object bytes, only the
// database row that names the path, so there is nothing to clean up in the
// bucket either.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-pipeline-${RUN}`;

const service = new PipelineService();

let userId: string;
let videoId: string;

beforeEach(async () => {
  userId = await createTestUser("pipeline");
  const project = await projectService.create(userId, { name: PROJECT_NAME });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Pipeline fixture video",
    topic: "testing",
  });
  videoId = video.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

function setVideoStatus(status: string) {
  return prisma.video.update({ where: { id: videoId }, data: { status: status as never } });
}

function addVoiceOver(durationSeconds = 60) {
  return prisma.voiceOver.create({
    data: {
      videoId,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      audioUrl: `videos/${videoId}/audio/narration.mp3`,
      durationSeconds,
    },
  });
}

function addSubtitleAsset() {
  return prisma.asset.create({
    data: {
      kind: "SUBTITLE",
      storagePath: `videos/${videoId}/captions/alignment.json`,
      provider: "ELEVENLABS",
    },
  });
}

function addClipAssets(pexels: number, pixabay: number, sizeBytesEach?: number) {
  const sizeBytes = sizeBytesEach != null ? BigInt(sizeBytesEach) : undefined;
  const creates = [
    ...Array.from({ length: pexels }, (_, i) =>
      prisma.asset.create({
        data: {
          kind: "VIDEO",
          storagePath: `videos/${videoId}/clips/pexels-${i}.mp4`,
          provider: "PEXELS",
          sizeBytes,
        },
      }),
    ),
    ...Array.from({ length: pixabay }, (_, i) =>
      prisma.asset.create({
        data: {
          kind: "VIDEO",
          storagePath: `videos/${videoId}/clips/pixabay-${i}.mp4`,
          provider: "PIXABAY",
          sizeBytes,
        },
      }),
    ),
  ];
  return Promise.all(creates);
}

/** Mirrors what script.service.ts leaves behind for an approved script: a
 * `Script` row whose `activeVersionId` points at a `ScriptVersion` carrying
 * the actual narration text — the source pipeline.service.ts reads the
 * narration stage's character count from. */
async function addApprovedScript(content: string) {
  const script = await prisma.script.create({ data: { videoId } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });
  return version;
}

async function addRenderJob(opts: {
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  progress?: number;
  startedAt?: Date;
  finishedAt?: Date;
}) {
  return prisma.renderJob.create({
    data: {
      videoId,
      status: opts.status,
      progress: opts.progress ?? 0,
      startedAt: opts.startedAt,
      finishedAt: opts.finishedAt,
    },
  });
}

/** Explicit, increasing `createdAt` values so ordering is deterministic even
 * when rows are created faster than the clock's resolution. A single
 * `createMany` rather than `count` sequential `create` round trips — against
 * this suite's real, long-haul database, 25 one-at-a-time awaited inserts
 * routinely blew past vitest's 5s default test timeout on its own, before
 * `getState` was ever called. */
async function addRenderLogs(renderJobId: string, count: number) {
  const base = Date.now();
  await prisma.renderLog.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      renderJobId,
      message: `log line ${i}`,
      createdAt: new Date(base + i * 1000),
    })),
  });
}

/** Explicit `createdAt` for deterministic merge-ordering assertions, same
 * reasoning as `addRenderLogs` above. */
function addStatusEvent(opts: {
  from?: string | null;
  to: string;
  message?: string | null;
  createdAt: Date;
}) {
  return prisma.videoStatusEvent.create({
    data: {
      videoId,
      from: (opts.from ?? null) as never,
      to: opts.to as never,
      message: opts.message ?? null,
      createdAt: opts.createdAt,
    },
  });
}

function addActivityLog(opts: {
  action: string;
  message?: string | null;
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  createdAt: Date;
}) {
  return prisma.activityLog.create({
    data: {
      userId,
      action: opts.action,
      entityType: "Video",
      entityId: videoId,
      message: opts.message ?? null,
      level: opts.level ?? "INFO",
      createdAt: opts.createdAt,
    },
  });
}

async function addPublication() {
  const channel = await prisma.channel.create({
    data: {
      userId,
      youtubeChannelId: `UC-${randomUUID()}`,
      title: "Test channel",
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return prisma.publication.create({
    data: {
      videoId,
      channelId: channel.id,
      title: "Published video",
      visibility: "UNLISTED",
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
}

function stageStatus(stages: { key: string; status: string }[], key: string) {
  return stages.find((stage) => stage.key === key)?.status;
}

describe("pipelineService.getState — access", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    await expect(service.getState(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });
});

describe("pipelineService.getState — isTerminal", () => {
  it.each([
    ["DRAFT", false],
    ["QUEUED", false],
    ["GENERATING", false],
    ["RENDERING", false],
    ["READY", true],
    ["PUBLISHED", true],
    ["FAILED", true],
  ] as const)("is %s for status %s", async (status, expected) => {
    await setVideoStatus(status);
    const state = await service.getState(userId, videoId);
    expect(state.isTerminal).toBe(expected);
  });
});

describe("pipelineService.getState — isActive", () => {
  it.each([
    ["DRAFT", false],
    ["QUEUED", false],
    ["GENERATING", true],
    ["RENDERING", true],
    ["READY", false],
    ["PUBLISHED", false],
    ["FAILED", false],
  ] as const)("is %s for status %s with no RenderJob", async (status, expected) => {
    await setVideoStatus(status);
    const state = await service.getState(userId, videoId);
    expect(state.isActive).toBe(expected);
  });

  it("is false when QUEUED and the only RenderJob is itself still QUEUED", async () => {
    // No render worker exists yet — a RenderJob sitting at QUEUED is exactly
    // the "nothing is actually running" case the slow poll interval exists
    // for, even though the render stage row shows as "running" (see
    // renderStageStatus's QUEUED-counts-as-running display quirk below).
    await addRenderJob({ status: "QUEUED", progress: 0 });
    await setVideoStatus("QUEUED");

    const state = await service.getState(userId, videoId);

    expect(state.isActive).toBe(false);
    expect(stageStatus(state.stages, "render")).toBe("running");
  });

  it("is true when a RenderJob is RUNNING, even before the video status catches up", async () => {
    await addRenderJob({ status: "RUNNING", progress: 12 });
    await setVideoStatus("QUEUED");

    const state = await service.getState(userId, videoId);

    expect(state.isActive).toBe(true);
  });

  it("is false once terminal, even with a stale RUNNING RenderJob row", async () => {
    await addRenderJob({ status: "RUNNING", progress: 99 });
    await setVideoStatus("FAILED");

    const state = await service.getState(userId, videoId);

    expect(state.isTerminal).toBe(true);
    expect(state.isActive).toBe(false);
  });
});

describe("pipelineService.getState — isFailed / attempts", () => {
  it.each([
    ["DRAFT", false],
    ["QUEUED", false],
    ["GENERATING", false],
    ["RENDERING", false],
    ["READY", false],
    ["PUBLISHED", false],
    ["FAILED", true],
  ] as const)("isFailed is %s for status %s", async (status, expected) => {
    await setVideoStatus(status);
    const state = await service.getState(userId, videoId);
    expect(state.isFailed).toBe(expected);
  });

  it("is not failed from a stale FAILED RenderJob row once the video itself is QUEUED again", async () => {
    // Exactly the shape a Retry leaves behind: the latest RenderJob is still
    // the old failed attempt (a fresh one doesn't exist until the render
    // stage starts again), but the video row has already moved back to
    // QUEUED. isFailed must track the video, not infer from the stage.
    await addRenderJob({ status: "FAILED" });
    await setVideoStatus("QUEUED");

    const state = await service.getState(userId, videoId);

    expect(state.isFailed).toBe(false);
    expect(stageStatus(state.stages, "render")).toBe("failed");
  });

  it("reports attempts, maxAttempts and attemptsExhausted", async () => {
    await prisma.video.update({ where: { id: videoId }, data: { attempts: 2, status: "FAILED" } });

    const state = await service.getState(userId, videoId);

    expect(state.attempts).toBe(2);
    expect(state.maxAttempts).toBe(MAX_ATTEMPTS);
    expect(state.attemptsExhausted).toBe(2 >= MAX_ATTEMPTS);
  });

  it("is exhausted once attempts reaches maxAttempts", async () => {
    await prisma.video.update({
      where: { id: videoId },
      data: { attempts: MAX_ATTEMPTS, status: "FAILED" },
    });

    const state = await service.getState(userId, videoId);

    expect(state.attemptsExhausted).toBe(true);
  });
});

describe("pipelineService.getState — stage derivation", () => {
  it("marks every stage pending for a DRAFT video with no rows yet", async () => {
    const state = await service.getState(userId, videoId);

    expect(state.stages.map((s) => s.status)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(state.progress).toBeNull();
    expect(state.elapsedSeconds).toBeNull();
    expect(state.logs).toEqual([]);
  });

  it("promotes the first incomplete stage to running once the video is active", async () => {
    await setVideoStatus("QUEUED");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "narration")).toBe("running");
    expect(stageStatus(state.stages, "footage")).toBe("pending");
  });

  it("marks narration done once a VoiceOver exists, and promotes footage next", async () => {
    await addVoiceOver(462);
    await addSubtitleAsset();
    await setVideoStatus("GENERATING");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "narration")).toBe("done");
    // Captions' Asset was created in the same call as narration in
    // voiceover.service.ts, so it can legitimately be done before footage —
    // the stage list's fixed display order doesn't imply completion order.
    expect(stageStatus(state.stages, "captions")).toBe("done");
    expect(stageStatus(state.stages, "footage")).toBe("running");
  });

  it("marks footage done once VIDEO assets exist under the video's prefix", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(5, 4);
    await setVideoStatus("GENERATING");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "footage")).toBe("done");
    const footageStage = state.stages.find((s) => s.key === "footage");
    expect(footageStage?.detail).toContain("9 clips");
  });

  it("includes total clip size in the footage detail once Assets carry sizeBytes", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 1, 10 * 1024 * 1024); // 3 clips x 10MB
    await setVideoStatus("GENERATING");

    const state = await service.getState(userId, videoId);

    const footageStage = state.stages.find((s) => s.key === "footage");
    expect(footageStage?.detail).toContain("3 clips");
    expect(footageStage?.detail).toContain("30.0MB");
  });

  it("omits the size segment when clips carry no sizeBytes (pre-existing rows)", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(1, 1); // no sizeBytesEach passed -> null column
    await setVideoStatus("GENERATING");

    const state = await service.getState(userId, videoId);

    const footageStage = state.stages.find((s) => s.key === "footage");
    expect(footageStage?.detail).toContain("2 clips");
    expect(footageStage?.detail).not.toContain("MB");
  });

  it("still shows footage as done, with its original detail, after publish reclaims its clips", async () => {
    // Mirrors what publish.service.ts's reclaimClipStorage actually leaves
    // behind: the clip Assets soft-deleted (deletedAt set), not removed —
    // it's the only writer of Asset.deletedAt in the codebase. Without the
    // read model tolerating that, a published video's footage stage would
    // regress from "done" back to "pending" the moment its clips are
    // reclaimed, even though the video finished the pipeline and is live on
    // YouTube.
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 1, 10 * 1024 * 1024);
    await prisma.asset.updateMany({
      where: { storagePath: { startsWith: `videos/${videoId}/clips/` } },
      data: { deletedAt: new Date() },
    });
    await setVideoStatus("PUBLISHED");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "footage")).toBe("done");
    const footageStage = state.stages.find((s) => s.key === "footage");
    expect(footageStage?.detail).toContain("3 clips");
    expect(footageStage?.detail).toContain("30.0MB");
  });

  it("includes the approved script's character count in the narration detail", async () => {
    await addApprovedScript("x".repeat(1234));
    await addVoiceOver(45);
    await setVideoStatus("GENERATING");

    const state = await service.getState(userId, videoId);

    const narrationStage = state.stages.find((s) => s.key === "narration");
    expect(narrationStage?.detail).toContain("0:45 narration");
    expect(narrationStage?.detail).toContain("1,234 characters");
  });

  it("does not see another video's assets (storage-path prefix is exact)", async () => {
    const otherVideo = await videoService.create(userId, {
      projectId: (await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).projectId,
      title: "Sibling video",
      topic: "testing",
    });
    await prisma.asset.create({
      data: {
        kind: "VIDEO",
        storagePath: `videos/${otherVideo.id}/clips/clip-0.mp4`,
        provider: "PEXELS",
      },
    });

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "footage")).toBe("pending");
  });

  it("reflects a running RenderJob's percentage and elapsed time", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 0);
    const startedAt = new Date(Date.now() - 30_000);
    await addRenderJob({ status: "RUNNING", progress: 63, startedAt });
    await setVideoStatus("RENDERING");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "render")).toBe("running");
    expect(state.progress).toBe(63);
    expect(state.elapsedSeconds).toBeGreaterThanOrEqual(29);
    expect(state.elapsedSeconds).toBeLessThan(40);

    // The render stage's own detail carries the same percentage and elapsed
    // time as the top-level fields, not a re-derived or differently-rounded
    // value.
    const renderStage = state.stages.find((s) => s.key === "render");
    expect(renderStage?.detail).toContain("63%");
    expect(renderStage?.detail).toContain(`${formatDuration(state.elapsedSeconds!)} elapsed`);
  });

  it("marks upload done once a Publication exists, alongside a SUCCEEDED render", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 0);
    await addRenderJob({
      status: "SUCCEEDED",
      progress: 100,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    });
    await addPublication();
    await setVideoStatus("PUBLISHED");

    const state = await service.getState(userId, videoId);

    expect(state.stages.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(state.isTerminal).toBe(true);
    expect(state.progress).toBe(100);
  });
});

describe("pipelineService.getState — failure attribution", () => {
  it("marks render failed from the RenderJob's own status, leaving upload pending", async () => {
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 0);
    await addRenderJob({
      status: "FAILED",
      progress: 40,
      startedAt: new Date(Date.now() - 10_000),
      finishedAt: new Date(),
    });
    await setVideoStatus("FAILED");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "narration")).toBe("done");
    expect(stageStatus(state.stages, "footage")).toBe("done");
    expect(stageStatus(state.stages, "captions")).toBe("done");
    expect(stageStatus(state.stages, "render")).toBe("failed");
    expect(stageStatus(state.stages, "upload")).toBe("pending");
  });

  it("marks upload failed when the render succeeded but no Publication was created", async () => {
    // Mirrors publish.service.ts's error path: it deliberately never creates
    // a Publication row when the YouTube upload itself fails, so upload's
    // only failure signal is the video-wide FAILED fallback.
    await addVoiceOver();
    await addSubtitleAsset();
    await addClipAssets(2, 0);
    await addRenderJob({
      status: "SUCCEEDED",
      progress: 100,
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    });
    await setVideoStatus("FAILED");

    const state = await service.getState(userId, videoId);

    expect(stageStatus(state.stages, "render")).toBe("done");
    expect(stageStatus(state.stages, "upload")).toBe("failed");
  });
});

describe("pipelineService.getState — logs", () => {
  it("returns at most the last 20 RenderLog lines, oldest first", async () => {
    const job = await addRenderJob({ status: "RUNNING", progress: 10 });
    await addRenderLogs(job.id, 25);

    const state = await service.getState(userId, videoId);

    expect(state.logs).toHaveLength(20);
    expect(state.logs[0].message).toBe("log line 5");
    expect(state.logs[19].message).toBe("log line 24");
    // oldest first
    expect(state.logs[0].createdAt.getTime()).toBeLessThan(state.logs[19].createdAt.getTime());
  });

  it("returns no logs when no RenderJob has ever been created", async () => {
    const state = await service.getState(userId, videoId);
    expect(state.logs).toEqual([]);
  });

  it("fetches logs for a FAILED RenderJob (diagnosing the crash)", async () => {
    const job = await addRenderJob({ status: "FAILED", progress: 40 });
    await addRenderLogs(job.id, 3);

    const state = await service.getState(userId, videoId);

    expect(state.logs).toHaveLength(3);
  });

  it("skips fetching logs for a SUCCEEDED RenderJob (the tail no longer matters)", async () => {
    const job = await addRenderJob({ status: "SUCCEEDED", progress: 100 });
    await addRenderLogs(job.id, 5);

    const state = await service.getState(userId, videoId);

    expect(state.logs).toEqual([]);
  });

  it("skips fetching logs for a RenderJob that is only QUEUED (not yet running)", async () => {
    const job = await addRenderJob({ status: "QUEUED", progress: 0 });
    await addRenderLogs(job.id, 5);

    const state = await service.getState(userId, videoId);

    expect(state.logs).toEqual([]);
  });
});

describe("pipelineService.getLogStream — access", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    await expect(service.getLogStream(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when a different user asks for this video's logs", async () => {
    // Guards the actual scoping mechanism: getLogStream never filters the
    // RenderLog/VideoStatusEvent/ActivityLog queries by userId directly (see
    // its comment) — ownership is enforced once, up front, by the video
    // lookup. A foreign caller must be rejected there, before any log rows
    // are ever touched.
    const otherUserId = await createTestUser("pipeline-foreign");
    try {
      await expect(service.getLogStream(otherUserId, videoId)).rejects.toThrow(NotFoundError);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("pipelineService.getLogStream — merge ordering", () => {
  it("merges render, status, and activity entries into one oldest-first stream", async () => {
    const base = Date.now();
    const job = await addRenderJob({ status: "RUNNING", progress: 10 });
    await prisma.renderLog.create({
      data: { renderJobId: job.id, message: "ffmpeg: frame=100", createdAt: new Date(base + 2000) },
    });
    await addActivityLog({
      action: "voiceover.generate",
      message: "Generated narration",
      createdAt: new Date(base + 1000),
    });
    await addStatusEvent({
      from: "DRAFT",
      to: "QUEUED",
      message: "Script approved by operator",
      createdAt: new Date(base + 3000),
    });

    const stream = await service.getLogStream(userId, videoId);

    // videoService.create's own "Video created" VideoStatusEvent (written in
    // beforeEach, before `base`) sorts ahead of all three of these — so this
    // only asserts the tail of the merge, not the very first entry.
    const tail = stream.entries.slice(-3);
    expect(tail.map((entry) => entry.source)).toEqual(["activity", "render", "status"]);
    expect(tail.map((entry) => entry.message)).toEqual([
      "Generated narration",
      "ffmpeg: frame=100",
      "Script approved by operator",
    ]);

    for (let i = 1; i < stream.entries.length; i++) {
      expect(stream.entries[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        stream.entries[i - 1].createdAt.getTime(),
      );
    }
  });

  it("includes RenderLog rows from every render attempt for the video, not just the latest", async () => {
    const firstJob = await addRenderJob({ status: "FAILED", progress: 20 });
    await prisma.renderLog.create({
      data: {
        renderJobId: firstJob.id,
        message: "first attempt crashed",
        createdAt: new Date(Date.now() - 5000),
      },
    });
    const secondJob = await addRenderJob({ status: "SUCCEEDED", progress: 100 });
    await prisma.renderLog.create({
      data: { renderJobId: secondJob.id, message: "second attempt succeeded", createdAt: new Date() },
    });

    const stream = await service.getLogStream(userId, videoId);
    const messages = stream.entries.map((entry) => entry.message);

    expect(messages).toContain("first attempt crashed");
    expect(messages).toContain("second attempt succeeded");
  });
});

describe("pipelineService.getLogStream — level", () => {
  it("derives ERROR for a status transition to FAILED, INFO for any other transition", async () => {
    await addStatusEvent({
      from: "RENDERING",
      to: "FAILED",
      message: "Render crashed",
      createdAt: new Date(),
    });
    await addStatusEvent({
      from: "DRAFT",
      to: "QUEUED",
      message: "Approved",
      createdAt: new Date(Date.now() + 1),
    });

    const stream = await service.getLogStream(userId, videoId);

    expect(stream.entries.find((entry) => entry.message === "Render crashed")?.level).toBe(
      "ERROR",
    );
    expect(stream.entries.find((entry) => entry.message === "Approved")?.level).toBe("INFO");
  });

  it("falls back to a 'from → to' message when a VideoStatusEvent has none", async () => {
    await addStatusEvent({ from: "QUEUED", to: "GENERATING", message: null, createdAt: new Date() });

    const stream = await service.getLogStream(userId, videoId);
    const entry = stream.entries.find(
      (candidate) => candidate.source === "status" && candidate.message.includes("GENERATING"),
    );

    expect(entry?.message).toBe("QUEUED → GENERATING");
  });

  it("passes ActivityLog's level through and falls back to the action name when message is null", async () => {
    await addActivityLog({
      action: "voiceover.generate",
      message: null,
      level: "WARN",
      createdAt: new Date(),
    });

    const stream = await service.getLogStream(userId, videoId);
    const entry = stream.entries.find((candidate) => candidate.source === "activity");

    expect(entry?.level).toBe("WARN");
    expect(entry?.message).toBe("voiceover.generate");
  });

  it("never surfaces ActivityLog.metadata even when a row has one set", async () => {
    await prisma.activityLog.create({
      data: {
        userId,
        action: "test.action",
        entityType: "Video",
        entityId: videoId,
        message: "has metadata",
        metadata: { secret: "should-not-leak" },
        createdAt: new Date(),
      },
    });

    const stream = await service.getLogStream(userId, videoId);
    const entry = stream.entries.find((candidate) => candidate.message === "has metadata");

    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("metadata");
  });
});

describe("pipelineService.getLogStream — cap and truncation", () => {
  it("caps the merged stream at 200 entries, keeps the newest, and flags truncation", async () => {
    const job = await addRenderJob({ status: "RUNNING", progress: 0 });
    const base = Date.now();
    await prisma.renderLog.createMany({
      data: Array.from({ length: 210 }, (_, i) => ({
        renderJobId: job.id,
        message: `line ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    });

    const stream = await service.getLogStream(userId, videoId);

    expect(stream.truncated).toBe(true);
    expect(stream.entries).toHaveLength(200);
    // The oldest 10 of the 210 render lines — plus the fixture's own
    // "Video created" status event, older still — are the ones cut. The
    // stream keeps the newest 200, so its oldest surviving entry is line 10.
    expect(stream.entries[0].message).toBe("line 10");
    expect(stream.entries[199].message).toBe("line 209");
  });

  it("does not flag truncation when the total is at or under the cap", async () => {
    const job = await addRenderJob({ status: "RUNNING", progress: 0 });
    await addRenderLogs(job.id, 50);

    const stream = await service.getLogStream(userId, videoId);

    expect(stream.truncated).toBe(false);
    // 50 render lines plus the fixture's own "Video created" status event.
    expect(stream.entries).toHaveLength(51);
  });
});
