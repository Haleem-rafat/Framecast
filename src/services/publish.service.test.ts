import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import type { VideoStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import { extractSourcesSection, PublishService } from "@/services/publish.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts). YouTube itself is never called: `fetch` is
// injected into PublishService (per its constructor), matching the injection
// shape already used by RenderService's process spawner and
// FootageService's clip downloader.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-publish-${RUN}`;

// Several tests make multiple live round trips to Supabase storage/DB
// (connect a channel, create a project/video/script, upload fake render
// bytes, then download them back inside publish()) — comfortably past
// Vitest's 5s default under network variance, same rationale as
// render.service.test.ts's own timeout bump.
vi.setConfig({ testTimeout: 15_000 });

const SCRIPT_WITH_SOURCES = [
  "Hook: money is weirder than you think.",
  "",
  "Body: here is the full explanation of the topic.",
  "",
  "SOURCES",
  "- https://example.com/federal-reserve-report",
  "- https://example.com/inflation-study",
].join("\n");

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("publish");
});

afterEach(() => deleteTestUser(userId));

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * A fake resumable-upload endpoint: the first call (uploadType=resumable)
 * returns a `Location` header, the second (the PUT to that location) returns
 * the created video's id. Either leg can be made to fail.
 */
function createUploadFetch(
  opts: { failInit?: boolean; failUpload?: boolean; youtubeVideoId?: string } = {},
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const youtubeVideoId = opts.youtubeVideoId ?? `yt_${randomUUID().slice(0, 8)}`;

  const fetchImpl: FetchLike = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("uploadType=resumable")) {
      if (opts.failInit) {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ location: "https://upload.example.invalid/resumable/abc123" }),
        json: async () => ({}),
      } as unknown as Response;
    }

    // The PUT of the actual bytes to the resumable location.
    if (opts.failUpload) {
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: youtubeVideoId }),
    } as unknown as Response;
  }) as FetchLike;

  return { fetchImpl, calls };
}

/**
 * Builds a video that is fully eligible to publish: a connected channel
 * assigned to its project, a READY status, and a RenderJob whose outputUrl
 * points at real bytes in the (test) storage bucket. Rows this stage doesn't
 * own (Channel, Script, RenderJob) are created directly rather than through
 * their owning services, same approach render.service.test.ts takes for its
 * upstream fixtures.
 */
async function makePublishableVideo(
  opts: { scriptContent?: string | null; status?: VideoStatus } = {},
): Promise<{ videoId: string; channelId: string; outputPath: string }> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
    channelId: channel.id,
  });

  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "How inflation actually works",
    topic: "inflation",
  });

  if (opts.scriptContent !== null) {
    const script = await prisma.script.create({ data: { videoId: video.id } });
    const version = await prisma.scriptVersion.create({
      data: {
        scriptId: script.id,
        version: 1,
        content: opts.scriptContent ?? SCRIPT_WITH_SOURCES,
      },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });
  }

  const outputPath = storagePath(video.id, "output", "video.mp4");
  await putObject(outputPath, Buffer.from(`fake-rendered-mp4-${RUN}`), "video/mp4");
  await prisma.renderJob.create({
    data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl: outputPath },
  });

  await prisma.video.update({
    where: { id: video.id },
    data: { status: opts.status ?? "READY" },
  });

  return { videoId: video.id, channelId: channel.id, outputPath };
}

describe("publishService.publish — extractSourcesSection", () => {
  it("returns everything from the SOURCES heading to the end", () => {
    expect(extractSourcesSection(SCRIPT_WITH_SOURCES)).toBe(
      ["SOURCES", "- https://example.com/federal-reserve-report", "- https://example.com/inflation-study"].join(
        "\n",
      ),
    );
  });

  it("returns an empty string when there is no SOURCES heading", () => {
    expect(extractSourcesSection("Just a script with no citations.")).toBe("");
  });
});

describe("publishService.publish — Gate 2", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    const service = new PublishService(createUploadFetch().fetchImpl);
    await expect(service.publish(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  const nonReadyStatuses: VideoStatus[] = [
    "DRAFT",
    "QUEUED",
    "GENERATING",
    "RENDERING",
    "PUBLISHED",
    "FAILED",
  ];

  it.each(nonReadyStatuses)("refuses to publish a video in %s", async (status) => {
    const { videoId } = await makePublishableVideo({ status });
    const service = new PublishService(createUploadFetch().fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow(ConflictError);

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(0);
  });

  it("refuses to publish a READY video with no successful RenderJob output", async () => {
    const { videoId } = await makePublishableVideo();
    // The video is READY, but its only RenderJob never produced an outputUrl —
    // e.g. render() flipped it to READY through a path this fixture doesn't
    // model. Simulate that directly.
    await prisma.renderJob.deleteMany({ where: { videoId } });

    const service = new PublishService(createUploadFetch().fetchImpl);
    await expect(service.publish(userId, videoId)).rejects.toThrow(ConflictError);
  });

  it("uploads with privacyStatus always unlisted, regardless of channel default visibility", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl, calls } = createUploadFetch();
    const service = new PublishService(fetchImpl);

    await service.publish(userId, videoId);

    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
    expect(initCall).toBeDefined();
    const body = JSON.parse(initCall!.init!.body as string);
    expect(body.status.privacyStatus).toBe("unlisted");
    expect(body.status.selfDeclaredMadeForKids).toBe(false);
  });

  it("carries the script's SOURCES section and a Pixabay credit in the description", async () => {
    const { videoId } = await makePublishableVideo();
    const service = new PublishService(createUploadFetch().fetchImpl);

    await service.publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toContain("SOURCES");
    expect(publication.description).toContain("https://example.com/federal-reserve-report");
    expect(publication.description).toContain("Pixabay");
  });

  it("still credits Pixabay even when the script has no SOURCES section", async () => {
    const { videoId } = await makePublishableVideo({ scriptContent: "No citations here." });
    const service = new PublishService(createUploadFetch().fetchImpl);

    await service.publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toContain("Pixabay");
  });

  it("moves the video READY → PUBLISHED and records the youtubeVideoId", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ youtubeVideoId: "yt_abc123" });
    const service = new PublishService(fetchImpl);

    const result = await service.publish(userId, videoId);
    expect(result.youtubeVideoId).toBe("yt_abc123");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.youtubeVideoId).toBe("yt_abc123");
    expect(publication.status).toBe("PUBLISHED");
    expect(publication.visibility).toBe("UNLISTED");

    const events = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("READY->PUBLISHED");
  });

  it("a failed upload sets the video FAILED without creating a Publication", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ failUpload: true });
    const service = new PublishService(fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.failureReason).toBeTruthy();

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(0);

    const events = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("READY->FAILED");
  });

  it("a failed upload init also sets FAILED without creating a Publication", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ failInit: true });
    const service = new PublishService(fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(0);
  });
});

describe("publishService.publish — concurrency", () => {
  it("Gate 2: two concurrent publishes produce exactly one Publication and one VideoStatusEvent", async () => {
    const { videoId } = await makePublishableVideo();

    const results = await Promise.allSettled([
      new PublishService(createUploadFetch().fetchImpl).publish(userId, videoId),
      new PublishService(createUploadFetch().fetchImpl).publish(userId, videoId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(1);

    const events = await prisma.videoStatusEvent.count({
      where: { videoId, to: "PUBLISHED" },
    });
    expect(events).toBe(1);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");
  });
});
