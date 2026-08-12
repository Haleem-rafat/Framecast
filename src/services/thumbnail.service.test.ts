import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { objectContentType, putObject, removeObjects, storagePath } from "@/lib/storage";
import { channelService } from "@/services/channel.service";
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
  /** Records the signal the service asked for, so the timeout test can assert
   *  the child was actually killed rather than merely given up on — a promise
   *  that rejects while ffmpeg keeps running is exactly the leak the timeout
   *  exists to prevent. */
  readonly signals: string[] = [];

  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM");
    // A killed process still closes. Mirroring that is what makes the
    // timeout path a real exercise of the close handler rather than of a
    // promise nothing ever settles.
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
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

function fakeImageProvider(bytes: string | Buffer = "raw-image-bytes") {
  return {
    generate: vi.fn().mockResolvedValue({
      data: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      model: "test/image-model",
    }),
  };
}

/** The real 8-byte PNG magic number, padded with filler so the buffer isn't
 *  suspiciously tiny. Passed as a `Buffer` rather than a string to
 *  `fakeImageProvider`: `Buffer.from(str, "utf8")` — the string overload's
 *  default — re-encodes any code point above 0x7f as multiple UTF-8 bytes,
 *  which corrupts exactly the high bytes (0x89, 0x8a) this signature needs
 *  to survive intact. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`fake-png-body-${RUN}`),
]);

/**
 * A channel with a real logo object in the bucket and a `ChannelBrand`
 * pointing at it, plus a video whose project is assigned to that channel —
 * i.e. exactly what an operator gets after `logoService.choose`.
 *
 * `ChannelBrand.logoPath` is a Supabase object key, not a filesystem path;
 * writing a real object and storing its real key is the whole point, since a
 * key that happens to exist locally would prove nothing about the download
 * this exercises.
 */
async function makeVideoWithLogo(): Promise<{
  videoId: string;
  channelId: string;
  logoPath: string;
}> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  const logoPath = storagePath(channel.id, "logos", `logo-${RUN}.png`);
  await putObject(logoPath, PNG_BYTES, "image/png");
  storedPaths.push(logoPath);

  await prisma.channelBrand.create({ data: { channelId: channel.id, logoPath } });

  const videoId = await makeVideoWithScript(channel.id);
  return { videoId, channelId: channel.id, logoPath };
}

async function makeVideoWithScript(channelId?: string) {
  const project = await projectService.create(userId, {
    name: `thumb-${RUN}-${randomUUID().slice(0, 8)}`,
    channelId,
  });
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

  it("stores the raw fallback image under its real content type, not a guessed one", async () => {
    const { spawner } = createSpawner(async (child) => {
      child.emit("close", 1);
    });

    // The provider's bytes carry a real PNG signature this time, unlike the
    // opaque ASCII fixture the other tests use — that fixture matches no
    // known image signature, so every other test's fallback path exercises
    // only detectImageFormat's default branch, never its PNG branch.
    const path = await new ThumbnailService(fakeImageProvider(PNG_BYTES), spawner).generate(
      userId,
      videoId,
    );
    storedPaths.push(path!);

    // Not just that the path exists: what Supabase actually recorded as the
    // object's content type must match the bytes it received, or a later
    // reader (e.g. Task 8's YouTube upload) trusting the declared type over
    // the bytes gets misled the same way an unconditional "image/jpeg"
    // fallback would have misled it.
    expect(await objectContentType(path!)).toBe("image/png");
  });

  it("hands FFmpeg a real file for the logo, not the object key stored on the brand", async () => {
    const { videoId: brandedVideoId, logoPath } = await makeVideoWithLogo();

    // Read from inside the spawner, standing where the real FFmpeg stands:
    // `generate()` deletes its temp dir in a `finally`, so by the time it
    // returns the only moment the file was ever openable has passed. That is
    // precisely the property under test — the path has to resolve *while the
    // process runs*, not merely look different from the object key.
    let logoBytes: Buffer | Error | null = null;
    const { spawner, calls } = createSpawner(async (child, args) => {
      const filterArg = args[args.indexOf("-vf") + 1];
      // `escapeDrawtextValue` escapes the path's separators for the filter
      // parser, so unescape before opening it.
      const source = /movie=([^,]+)/.exec(filterArg)?.[1]?.replace(/\\(.)/g, "$1");
      if (source) {
        logoBytes = await readFile(source).catch((error: Error) => error);
      }
      await writeFile(args[args.length - 1], `composited-${RUN}`);
      child.emit("close", 0);
    });

    const path = await new ThumbnailService(fakeImageProvider(), spawner).generate(
      userId,
      brandedVideoId,
    );
    storedPaths.push(path!);

    const filter = calls[0][calls[0].indexOf("-vf") + 1];
    const movieSource = /movie=([^,]+)/.exec(filter)?.[1];
    expect(movieSource).toBeDefined();

    // The bug this exists for: `ChannelBrand.logoPath` is a Supabase object
    // key, and passing it straight through put it inside `movie=` where
    // FFmpeg tried to open it as a file. It cannot, and a `movie=` source
    // that won't open fails the entire filter graph — so choosing a logo
    // silently cost the headline too, and every branded channel fell through
    // to the raw-image fallback.
    expect(movieSource).not.toBe(logoPath);
    // The bytes really came from the stored object, so this is a downloaded
    // logo and not just some file that happened to exist.
    expect(logoBytes).toEqual(PNG_BYTES);

    // And the headline survived alongside it — the half of the graph the
    // broken logo source used to take down with it.
    expect(filter).toContain("drawtext");
  });

  it("keeps the headline when the logo can't be downloaded", async () => {
    const { videoId: brandedVideoId, channelId } = await makeVideoWithLogo();
    // The brand points at an object that isn't there — a logo deleted from
    // the bucket, or a brand row restored against a different one. Scoped to
    // this test's own channel: the database is shared with the operator's
    // real data, so an unscoped `updateMany` would rewrite every brand row
    // they have.
    await prisma.channelBrand.update({
      where: { channelId },
      data: { logoPath: storagePath(randomUUID(), "logos", "missing.png") },
    });

    const { spawner, calls } = succeedingSpawner();
    const path = await new ThumbnailService(fakeImageProvider(), spawner).generate(
      userId,
      brandedVideoId,
    );
    storedPaths.push(path!);

    const filter = calls[0][calls[0].indexOf("-vf") + 1];
    // Degrading to "no watermark" is the point: letting the download failure
    // reach the filter graph would lose the headline as well, which is a far
    // bigger loss than the logo for a channel whose only fault is a storage
    // hiccup.
    expect(filter).not.toContain("movie=");
    expect(filter).toContain("drawtext");
    expect(path).toBeTruthy();
  });

  it("puts FFmpeg's stderr in the failure it reports, not just an exit code", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { spawner } = createSpawner(async (child) => {
      child.stderr.emit(
        "data",
        "[AVFilterGraph] Error initializing filter 'movie' with args 'videos/x/logos/y.png'",
      );
      child.emit("close", 1);
    });

    const path = await new ThumbnailService(fakeImageProvider(), spawner).generate(
      userId,
      videoId,
    );
    storedPaths.push(path!);

    // A bare "exited with code 1" is the same message for an unopenable
    // `movie=` source, a missing font and an unwritable output path. FFmpeg
    // says which on stderr and nowhere else, so a composite failure with the
    // stderr discarded is undiagnosable from production — which is exactly
    // how the object-key bug above presented for as long as it lasted.
    const logged = consoleError.mock.calls.flat().join("\n");
    expect(logged).toContain("Error initializing filter 'movie'");

    consoleError.mockRestore();
  });

  it("kills a composite that hangs instead of holding the video's lease forever", async () => {
    const children: FakeChildProcess[] = [];
    // A child that never exits on its own: no `close`, no `error`. Without a
    // deadline this promise never settles, and because the worker keeps
    // renewing `Video.leaseExpiresAt` for the whole of runPipeline, the video
    // keeps a live lease that `JobService.claimNext` refuses to reclaim —
    // wedging that worker and stranding the video permanently.
    const spawner = () => {
      const child = new FakeChildProcess();
      children.push(child);
      return child as never;
    };

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const path = await new ThumbnailService(fakeImageProvider(), spawner, 50).generate(
      userId,
      videoId,
    );
    storedPaths.push(path!);

    // Not merely "the promise settled": the process itself was killed, or
    // ffmpeg would go on running with nothing left waiting for it.
    expect(children[0].signals).toEqual(["SIGKILL"]);
    expect(consoleError.mock.calls.flat().join("\n")).toContain("did not finish compositing");
    // And the timeout degrades like any other composite failure rather than
    // failing the whole thumbnail.
    expect(path).toBeTruthy();

    consoleError.mockRestore();
  });

  it("stores nothing rather than a fallback image YouTube would reject", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { spawner } = createSpawner(async (child) => {
      child.emit("close", 1);
    });

    // 2.5MB, past YouTube's 2MB cap on a custom thumbnail — the ordinary
    // shape of a gpt-image-1 16:9 PNG, which is what the fallback path stores
    // untouched.
    const oversized = Buffer.alloc(2.5 * 1024 * 1024, 0x41);

    const path = await new ThumbnailService(fakeImageProvider(oversized), spawner).generate(
      userId,
      videoId,
    );

    // Storing it would cost a download and a `thumbnails.set` that fails, and
    // leave a ThumbnailVersion row claiming a thumbnail exists — arriving at
    // the same operator-visible outcome as no thumbnail, expensively and
    // dishonestly.
    expect(path).toBeNull();
    expect(await prisma.thumbnail.findUnique({ where: { videoId } })).toBeNull();

    consoleError.mockRestore();
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
