import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "@/lib/errors";
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

describe("publishService.publish — the operator's visibility", () => {
  it.each([
    ["PUBLIC", "public"],
    ["UNLISTED", "unlisted"],
    ["PRIVATE", "private"],
  ] as const)(
    "sends %s as privacyStatus %s and records it",
    async (visibility, privacyStatus) => {
      // The picker in publish-video-button.tsx offers exactly these three, and
      // every one of them has to survive the whole way to the request body —
      // this action used to pin every publish to UNLISTED regardless of what
      // anything asked for.
      const { videoId } = await makePublishableVideo(TITLE);

      const { fetchImpl, calls } = createUploadFetch();
      await new PublishService(fetchImpl).publish(userId, videoId, { visibility });

      const body = JSON.parse(calls[0].init!.body as string);
      expect(body.status.privacyStatus).toBe(privacyStatus);

      // The row has to agree with the request. A Publication that records
      // UNLISTED for a video YouTube is showing publicly is worse than either
      // outcome on its own, because nothing downstream would ever say so.
      const publication = await prisma.publication.findUniqueOrThrow({
        where: { videoId },
      });
      expect(publication.visibility).toBe(visibility);
    },
  );

  it("still publishes only once, whichever visibility the second attempt asks for", async () => {
    // The picker is new; the one-shot property is not, and asking for a
    // different visibility must not read as a different publish that is
    // allowed to happen again. Two things stand in the way and neither moved:
    // the video is no longer READY, and `Publication.videoId` is @unique, so
    // the claim could not be taken a second time either.
    const { videoId } = await makePublishableVideo(TITLE);

    const first = createUploadFetch();
    await new PublishService(first.fetchImpl).publish(userId, videoId, {
      visibility: "PRIVATE",
    });

    const second = createUploadFetch();
    await expect(
      new PublishService(second.fetchImpl).publish(userId, videoId, {
        visibility: "PUBLIC",
      }),
    ).rejects.toThrow(ConflictError);

    // Not one byte of a second upload, and the first publish's own record is
    // untouched — a rejected retry must not quietly upgrade what is stored.
    expect(second.calls).toHaveLength(0);
    const publication = await prisma.publication.findUniqueOrThrow({
      where: { videoId },
    });
    expect(publication.visibility).toBe("PRIVATE");
  });

  it("refuses a scheduled publish at anything but public, and sends nothing", async () => {
    // YouTube's publishAt is valid only with privacyStatus: private, and what
    // it does at the timestamp is make the video *public* — there is no way to
    // schedule an unlisted one. The dialog offers no scheduling control at all
    // and `publishVideoSchema` accepts no timestamp, so this combination is
    // unreachable from the UI by construction; the service refusing it is what
    // keeps that true for the CLI and for whatever schedules publishes later.
    const { videoId } = await makePublishableVideo(TITLE);

    const { fetchImpl, calls } = createUploadFetch();
    await expect(
      new PublishService(fetchImpl).publish(userId, videoId, {
        visibility: "UNLISTED",
        scheduledFor: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/always goes live as public/);

    expect(calls).toHaveLength(0);
    // Refused before the claim, so the video is still publishable — a refusal
    // that consumed the one-shot would be worse than the combination it
    // rejected.
    expect(await prisma.publication.count({ where: { videoId } })).toBe(0);
  });

  it("accepts a scheduled PUBLIC publish, uploading it private with publishAt", async () => {
    const { videoId } = await makePublishableVideo(TITLE);
    const scheduledFor = new Date("2030-01-01T12:00:00.000Z");

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      scheduledFor,
    });

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status.privacyStatus).toBe("private");
    expect(body.status.publishAt).toBe(scheduledFor.toISOString());
  });
});

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
