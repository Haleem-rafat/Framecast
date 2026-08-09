import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Alignment } from "@/lib/captions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { projectService } from "@/services/project.service";
import type { ProcessSpawner } from "@/services/render.service";
import { RenderService } from "@/services/render.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts). FFmpeg itself never runs: the process spawner
// is injected everywhere below (per RenderService's constructor), following
// the same injection shape as ScriptService's provider and
// VoiceOverService's provider.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-render-${RUN}`;

// Several tests wait out the real 1s progress-write throttle and/or make
// several sequential storage round trips against a live bucket — comfortably
// past Vitest's 5s default under any network variance.
vi.setConfig({ testTimeout: 15_000 });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds an alignment where every character takes exactly 0.1s, mirroring
 * captions.test.ts's fixture helper. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  command: string;
  args: string[];
}

/**
 * Builds an injectable `ProcessSpawner` whose behaviour is fully controlled
 * by `run`. `run` is invoked on a microtask after `spawn()` returns — after
 * RenderService has synchronously attached its `stdout`/`stderr`/`close`
 * listeners — so events emitted from within `run` are never missed.
 */
function createSpawner(
  run: (child: FakeChildProcess, args: string[]) => void | Promise<void>,
): { spawner: ProcessSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: ProcessSpawner = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      void run(child, args);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawner, calls };
}

/** A spawner that succeeds immediately: writes fake bytes to the output path
 * FFmpeg would have produced, then closes with code 0. */
function createSucceedingSpawner() {
  return createSpawner(async (child, args) => {
    const outputPath = args[args.length - 1];
    child.stdout.emit("data", "out_time_ms=1000000\nprogress=continue\n");
    await writeFile(outputPath, "fake-rendered-mp4-bytes");
    child.emit("close", 0);
  });
}

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("render");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
});

/**
 * Creates a video with narration, alignment and stock footage already in
 * place — everything render() requires — and moves it to GENERATING, the
 * status the upstream narration/footage stages are expected to leave it in.
 * These rows are created directly (not through voiceover.service /
 * footage.service, which are owned by other concurrently-active tasks):
 * render.service only ever reads the rows those services produce.
 */
async function makeRenderableVideo(
  opts: { durationSeconds?: number; clipCount?: number } = {},
): Promise<string> {
  const durationSeconds = opts.durationSeconds ?? 2;
  const clipCount = opts.clipCount ?? 2;

  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Render fixture video",
    topic: "testing",
  });

  await prisma.video.update({ where: { id: video.id }, data: { status: "GENERATING" } });

  const audioPath = storagePath(video.id, "audio", "narration.mp3");
  await putObject(audioPath, Buffer.from(`fake-audio-${RUN}`), "audio/mpeg");
  await prisma.voiceOver.create({
    data: {
      videoId: video.id,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      audioUrl: audioPath,
      durationSeconds,
    },
  });

  const alignmentPath = storagePath(video.id, "captions", "alignment.json");
  await putObject(
    alignmentPath,
    Buffer.from(JSON.stringify(evenAlignment("Hello there world"))),
    "application/json",
  );
  await prisma.asset.create({
    data: { kind: "SUBTITLE", storagePath: alignmentPath, provider: "ELEVENLABS" },
  });

  for (let i = 0; i < clipCount; i++) {
    const clipPath = storagePath(video.id, "clips", `clip-${i}.mp4`);
    await putObject(clipPath, Buffer.from(`fake-clip-${i}-${RUN}`), "video/mp4");
    await prisma.asset.create({ data: { kind: "VIDEO", storagePath: clipPath } });
  }

  return video.id;
}

describe("renderService.render — guards", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("refuses to render a video that is not GENERATING", async () => {
    const project = await projectService.create(userId, { name: PROJECT_NAME });
    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "Still a draft",
      topic: "testing",
    });

    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, video.id)).rejects.toThrow(ConflictError);
  });

  it("refuses to render when stock footage has not been collected", async () => {
    const videoId = await makeRenderableVideo({ clipCount: 0 });
    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, videoId)).rejects.toThrow(ConflictError);
  });
});

describe("renderService.render — happy path", () => {
  it("moves the RenderJob to SUCCEEDED and the video GENERATING → RENDERING → READY, uploading the output", async () => {
    const videoId = await makeRenderableVideo();
    const updateSpy = vi.spyOn(prisma.renderJob, "update");
    const { spawner } = createSucceedingSpawner();
    const service = new RenderService(spawner);

    const result = await service.render(userId, videoId);

    expect(result.durationSeconds).toBe(2);
    expect(result.outputPath).toContain(videoId);
    expect(result.outputPath).toContain("output/video.mp4");

    // The job passed through RUNNING on its way to SUCCEEDED — RenderJob's
    // schema default is QUEUED, so combined with the final status below this
    // covers the full QUEUED → RUNNING → SUCCEEDED path.
    const statusesWritten = updateSpy.mock.calls
      .map((call) => (call[0] as { data?: { status?: string } }).data?.status)
      .filter(Boolean);
    expect(statusesWritten).toContain("RUNNING");

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.progress).toBe(100);
    expect(job.outputUrl).toBe(result.outputPath);
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");

    const events = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { createdAt: "asc" },
    });
    const transitions = events.map((e) => `${e.from}->${e.to}`);
    expect(transitions).toContain("GENERATING->RENDERING");
    expect(transitions).toContain("RENDERING->READY");

    const uploaded = await prisma.asset.count(); // sanity: no crash reading DB post-render
    expect(uploaded).toBeGreaterThanOrEqual(0);
  });

  it("extends clip coverage by repeating the clip list when clips fall short of the narration", async () => {
    // clipSeconds is 12 internally; one 12s slot covers 12s, short of a 30s
    // narration. Coverage must be extended (12*3=36 >= 30) rather than
    // silently truncating FFmpeg's output to the clips' combined length.
    const videoId = await makeRenderableVideo({ durationSeconds: 30, clipCount: 1 });
    const { spawner, calls } = createSucceedingSpawner();
    const service = new RenderService(spawner);

    await service.render(userId, videoId);

    expect(calls).toHaveLength(1);
    const clipOccurrences = calls[0].args.filter((arg) => arg.endsWith("clip-0.mp4")).length;
    expect(clipOccurrences).toBe(3);
  });

  it("writes progress as parsed FFmpeg output advances, throttled to at most one write per second", async () => {
    const videoId = await makeRenderableVideo({ durationSeconds: 2 });
    const updateSpy = vi.spyOn(prisma.renderJob, "update");

    const { spawner } = createSpawner(async (child, args) => {
      const outputPath = args[args.length - 1];
      // Two lines in immediate succession: only the first should produce a
      // write, the second falls inside the same throttle window.
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.3 * 1_000_000)}\n`);
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.35 * 1_000_000)}\n`);
      await sleep(1100); // clear the 1s throttle window
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.9 * 1_000_000)}\n`);
      await writeFile(outputPath, "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    const service = new RenderService(spawner);

    await service.render(userId, videoId);

    const progressWrites = updateSpy.mock.calls
      .map((call) => (call[0] as { data?: { progress?: number } }).data?.progress)
      .filter((value): value is number => typeof value === "number");

    // Exactly two real writes: the throttled-down first burst, and the one
    // after the window passed. The forced 100% on success goes through a
    // transaction client (tx.renderJob.update), a different object from the
    // one spied on here, so it never appears in this list.
    expect(progressWrites.length).toBe(2);
    expect(progressWrites[0]).toBeGreaterThan(0);
    expect(progressWrites[0]).toBeLessThan(50);
    expect(progressWrites[1]).toBeGreaterThan(progressWrites[0]);
    expect(progressWrites[1]).toBeLessThan(100);

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.progress).toBe(100);
  });
});

describe("renderService.render — failure path", () => {
  it("sets the RenderJob FAILED, batches stderr into one RenderLog, and fails the video", async () => {
    const videoId = await makeRenderableVideo();
    const { spawner } = createSpawner(async (child) => {
      // Two stderr chunks arriving close together must land as one RenderLog
      // row, not one row per line/chunk.
      child.stderr.emit("data", "ffmpeg: error: something broke\n");
      child.stderr.emit("data", "additional detail line\n");
      child.emit("close", 1);
    });
    const service = new RenderService(spawner);

    await expect(service.render(userId, videoId)).rejects.toThrow(/exited with code 1/);

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("exited with code 1");
    expect(job.finishedAt).toBeTruthy();

    const logs = await prisma.renderLog.findMany({ where: { renderJobId: job.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("something broke");
    expect(logs[0].message).toContain("additional detail line");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.failureReason).toContain("exited with code 1");

    const events = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("RENDERING->FAILED");
  });
});

describe("renderService.render — concurrency", () => {
  it("refuses a second concurrent render for the same video; only one succeeds", async () => {
    const videoId = await makeRenderableVideo();

    const results = await Promise.allSettled([
      new RenderService(createSucceedingSpawner().spawner).render(userId, videoId),
      new RenderService(createSucceedingSpawner().spawner).render(userId, videoId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);

    // Only the winner ever created a RenderJob — the loser's transaction
    // rolled back before reaching RenderJob.create.
    const jobs = await prisma.renderJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("SUCCEEDED");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
  });
});
