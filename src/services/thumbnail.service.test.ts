import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { removeObjects } from "@/lib/storage";
import { projectService } from "@/services/project.service";
import { ThumbnailService } from "@/services/thumbnail.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// The image provider and the FFmpeg spawner are both injected, so no image is
// ever generated and no process is ever spawned — the same convention
// render.service.test.ts and footage.service.test.ts already follow.
vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

let userId: string;
let videoId: string;

/** Objects this file writes to the real bucket, swept first in afterEach so a
 *  failed assertion cannot leave one behind — Asset carries no FK back to
 *  User, so deleteTestUser's cascade cannot reach them. */
const storedPaths: string[] = [];

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

/** Mirrors render.service.test.ts's spawner: `run` is invoked on a microtask
 *  after spawn() returns, so listeners are attached before any event fires. */
function createSpawner(run: (child: FakeChildProcess, args: string[]) => Promise<void>) {
  const calls: string[][] = [];

  const spawner = (_command: string, args: string[]) => {
    const child = new FakeChildProcess();
    calls.push(args);
    queueMicrotask(() => void run(child, args));
    return child as never;
  };

  return { spawner, calls };
}

/** A spawner that writes plausible bytes to the output path and exits 0. */
function succeedingSpawner() {
  return createSpawner(async (child, args) => {
    await writeFile(args[args.length - 1], `composited-${RUN}`);
    child.emit("close", 0);
  });
}

function fakeImageProvider(bytes = "raw-image-bytes") {
  return {
    generate: vi.fn().mockResolvedValue({
      data: Buffer.from(bytes),
      model: "test/image-model",
    }),
  };
}

async function makeVideoWithScript() {
  const project = await projectService.create(userId, { name: `thumb-${RUN}` });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "How inflation actually works",
    topic: "inflation",
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: 1,
      content: "Money is weirder than you think. Here is why.",
    },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return video.id;
}

beforeEach(async () => {
  userId = await createTestUser("thumbnail");
  videoId = await makeVideoWithScript();
});

afterEach(async () => {
  const paths = storedPaths.splice(0);
  if (paths.length > 0) {
    await removeObjects(paths).catch(() => {});
  }
  await deleteTestUser(userId);
});

describe("ThumbnailService.generate", () => {
  it("stores a version whose prompt can reproduce it", async () => {
    const { spawner } = succeedingSpawner();
    const images = fakeImageProvider();

    const path = await new ThumbnailService(images, spawner).generate(userId, videoId);
    storedPaths.push(path!);

    const thumbnail = await prisma.thumbnail.findUniqueOrThrow({
      where: { videoId },
      include: { activeVersion: true },
    });

    // ThumbnailVersion.prompt exists precisely so a good thumbnail is
    // repeatable; a version without it is a dead end.
    expect(thumbnail.activeVersion!.prompt).toBeTruthy();
    expect(thumbnail.activeVersion!.prompt).toContain("Money is weirder");
    expect(thumbnail.activeVersion!.model).toBe("test/image-model");
  });

  it("appends a version and moves the active pointer rather than overwriting", async () => {
    const { spawner } = succeedingSpawner();
    const service = new ThumbnailService(fakeImageProvider(), spawner);

    const first = await service.generate(userId, videoId);
    const second = await service.generate(userId, videoId);
    storedPaths.push(first!, second!);

    const thumbnail = await prisma.thumbnail.findUniqueOrThrow({
      where: { videoId },
      include: { versions: { orderBy: { version: "asc" } } },
    });

    // Regenerating is the expected workflow — the first image is often wrong,
    // and comparing attempts is what ThumbnailVersion is for.
    expect(thumbnail.versions).toHaveLength(2);
    expect(thumbnail.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(thumbnail.activeVersionId).toBe(thumbnail.versions[1].id);
    expect(first).not.toBe(second);
  });

  it("returns null when image generation fails, leaving the video publishable", async () => {
    const { spawner, calls } = succeedingSpawner();
    const images = {
      generate: vi.fn().mockRejectedValue(new Error("gateway down")),
    };

    // A thumbnail is an enhancement: without one YouTube picks a frame, and
    // the video still publishes.
    expect(await new ThumbnailService(images, spawner).generate(userId, videoId)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await prisma.thumbnail.findUnique({ where: { videoId } })).toBeNull();
  });

  it("falls back to the raw image when compositing fails", async () => {
    const { spawner } = createSpawner(async (child) => {
      child.emit("close", 1);
    });

    const path = await new ThumbnailService(fakeImageProvider(), spawner).generate(
      userId,
      videoId,
    );
    storedPaths.push(path!);

    // A thumbnail without a headline still beats YouTube picking a frame from
    // stock footage.
    expect(path).toBeTruthy();
    const thumbnail = await prisma.thumbnail.findUniqueOrThrow({ where: { videoId } });
    expect(thumbnail.activeVersionId).not.toBeNull();
  });

  it("returns null for a video with no approved script", async () => {
    const project = await projectService.create(userId, { name: `thumb-bare-${RUN}` });
    // `topic` is required by createVideoSchema (min 3 chars) even though this
    // video is never meant to get a script — there is no "no topic" video to
    // create.
    const bare = await videoService.create(userId, {
      projectId: project.id,
      title: "No script",
      topic: "no script yet",
    });

    const { spawner } = succeedingSpawner();
    const images = fakeImageProvider();

    // The script's opening is what the thumbnail illustrates; without one
    // there is nothing to build a prompt from.
    expect(await new ThumbnailService(images, spawner).generate(userId, bare.id)).toBeNull();
    expect(images.generate).not.toHaveBeenCalled();
  });
});
