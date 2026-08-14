import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { TITLE_MAX } from "@/lib/youtube-limits";
import { PUBLISHING_DEFAULTS } from "@/lib/youtube-categories";
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
 *  YouTube's own limit. The channel comes back too, because the snippet's
 *  language and category are the *channel's* and the tests below have to be
 *  able to brand it. */
async function makePublishableVideo(
  title: string,
): Promise<{ videoId: string; channelId: string }> {
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

  return { videoId: video.id, channelId: channel.id };
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

    const { videoId } = await makePublishableVideo(longTitle);

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
    const { videoId } = await makePublishableVideo(title);

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe(title);
  });
});

const TITLE = "How inflation actually works";

describe("publishService.publish — language and category", () => {
  it("sends the channel's language and category on the snippet", async () => {
    // Both are properties of the channel, not of one video: a channel's
    // videos are written, narrated and categorised the same way every time.
    const { videoId, channelId } = await makePublishableVideo(TITLE);
    await prisma.channelBrand.create({
      data: { channelId, language: "en-GB", categoryId: "28" },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    // The metadata language and the spoken language are the same value here
    // by construction — the description is built from the script the voice
    // reads — so one column feeds both fields.
    expect(body.snippet.defaultLanguage).toBe("en-GB");
    expect(body.snippet.defaultAudioLanguage).toBe("en-GB");
    expect(body.snippet.categoryId).toBe("28");
  });

  it("falls back to en and Education for a channel with no brand row", async () => {
    // The whole point of the defaults: every channel connected before this
    // shipped keeps publishing with nothing asked of the operator. YouTube
    // guesses the language from the text when the field is absent, and files
    // the video under its own default category — both decide who ever sees it.
    const { videoId, channelId } = await makePublishableVideo(TITLE);
    expect(await prisma.channelBrand.count({ where: { channelId } })).toBe(0);

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.defaultLanguage).toBe(PUBLISHING_DEFAULTS.language);
    expect(body.snippet.defaultAudioLanguage).toBe(PUBLISHING_DEFAULTS.language);
    expect(body.snippet.categoryId).toBe(PUBLISHING_DEFAULTS.categoryId);
  });

  it("uses the column defaults for a brand row that names neither", async () => {
    // A brand row created for a logo, a colour or a tone — the common case,
    // and the one a migration that added nullable columns would have left
    // sending `undefined` to YouTube.
    const { videoId, channelId } = await makePublishableVideo(TITLE);
    await prisma.channelBrand.create({
      data: { channelId, tone: "dry and factual" },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.defaultLanguage).toBe(PUBLISHING_DEFAULTS.language);
    expect(body.snippet.categoryId).toBe(PUBLISHING_DEFAULTS.categoryId);
  });
});
