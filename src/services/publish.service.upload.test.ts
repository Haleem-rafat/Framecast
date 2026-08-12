import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { TITLE_MAX } from "@/lib/youtube-limits";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import { PublishService } from "@/services/publish.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The half of `publish()` that is about *what gets sent to YouTube* rather
 * than about the render file getting there.
 *
 * Separate from publish.service.test.ts, and stubbing one seam that file
 * deliberately exercises for real: `getRenderFile`. Everything asserted here
 * is a property of the `videos.insert` request body, and the body is built
 * from the `Video` row — the render's bytes are a `Buffer` parameter handed
 * to `uploadToYouTube` and are never read, measured or inspected on the way
 * to any assertion below. Round-tripping ~26 bytes through the local render
 * store to reach them would test render-storage.ts, not this.
 *
 * The seam is a real one: `getRenderFile` returns a `RenderFileContent` whose
 * `stream` is a Web `ReadableStream`, which is exactly what the stub returns.
 * `writeRenderFile` and `deleteRenderFile` are stubbed only so the fixture
 * and cleanup below don't have to reach a store they never needed. The real
 * disk path — a real write, a real read, and the RenderFileMissingError a
 * genuinely absent file produces — stays covered by publish.service.test.ts,
 * which is where it belongs.
 *
 * YouTube itself is never called: `fetch` is injected, same as in that file.
 */
vi.mock("@/lib/render-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/render-storage")>();
  return {
    ...actual,
    writeRenderFile: vi.fn(async (videoId: string) => `renders/${videoId}.mp4`),
    deleteRenderFile: vi.fn(async () => {}),
    getRenderFile: vi.fn(async () => ({
      stream: new Blob([Buffer.from("fake-rendered-mp4")]).stream(),
      contentType: "video/mp4",
      sizeBytes: 17,
      contentLength: 17,
      contentRange: null,
    })),
  };
});

const RUN = randomUUID().slice(0, 8);

vi.setConfig({ testTimeout: 15_000 });

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("publish-upload");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** The same fake resumable-upload endpoint publish.service.test.ts uses,
 *  trimmed to the success path — every test here asserts on what was sent,
 *  not on how a failure is handled. */
function createUploadFetch(): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fetchImpl: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("uploadType=resumable")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ location: "https://upload.example.invalid/resumable/abc" }),
        json: async () => ({}),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: `yt_${randomUUID().slice(0, 8)}` }),
    } as unknown as Response;
  }) as FetchLike;

  return { fetchImpl, calls };
}

/** A video eligible to publish, with `title` under the caller's control —
 *  the field `createVideoSchema` caps at 120 characters, twenty past
 *  YouTube's own limit. */
async function makePublishableVideo(title: string): Promise<string> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  const project = await projectService.create(userId, {
    name: `test-publish-upload-${RUN}-${randomUUID().slice(0, 8)}`,
    channelId: channel.id,
  });

  const video = await videoService.create(userId, {
    projectId: project.id,
    title,
    topic: "inflation",
  });

  await prisma.renderJob.create({
    data: {
      videoId: video.id,
      status: "SUCCEEDED",
      progress: 100,
      outputUrl: `renders/${video.id}.mp4`,
    },
  });

  await prisma.video.update({ where: { id: video.id }, data: { status: "READY" } });

  return video.id;
}

describe("publishService.publish — title limits", () => {
  it("clamps the operator's own title, which nothing upstream ever clamps", async () => {
    // 120 characters: the longest title createVideoSchema accepts, and the
    // exact shape of the fallback path the spec designed — a video whose
    // metadata stage never ran, so `generatedTitle` is null and `video.title`
    // is what gets published. metadata.service.ts clamps what it generates;
    // nothing has ever clamped this.
    const longTitle = "How inflation actually works and why the numbers you keep hearing about it are not measuring what you think";
    expect(longTitle.length).toBeGreaterThan(TITLE_MAX);
    expect(longTitle.length).toBeLessThanOrEqual(120);

    const videoId = await makePublishableVideo(longTitle);

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    // Over-limit is not cosmetic here: videos.insert answers 400 *after* the
    // whole file is uploaded, publish() marks the video FAILED, and the
    // Publication row it deliberately keeps then blocks every retry — so an
    // unclamped title costs the operator the video permanently.
    const body = JSON.parse(calls[0].init!.body as string);
    expect((body.snippet.title as string).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(body.snippet.title).toContain("How inflation actually works");

    // And what was recorded matches what YouTube was actually sent.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.title).toBe(body.snippet.title);
  });

  it("leaves a title already inside the limit exactly as the operator wrote it", async () => {
    // Clamping must not become "every title gets trimmed": a short title has
    // to survive character-for-character, trailing punctuation included.
    const title = "How inflation actually works!";
    const videoId = await makePublishableVideo(title);

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe(title);
  });
});
