import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { SpeechProvider } from "@/services/providers/types";
import { StudioService } from "@/services/studio.service";
import type { ThumbnailService } from "@/services/thumbnail.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same arrangement as script.service.test.ts: these run against a real,
// shared Postgres that also holds the operator's own data, so every test gets
// its own throwaway User rather than the first row in the table.
//
// Two users, not one, and that is the point of half this file. Every read in
// StudioService reaches its rows by walking back to Video.userId — Script,
// VoiceOver and Thumbnail carry no owner column of their own — so the failure
// mode worth testing is not "does it return rows" but "does it return only
// this operator's". `otherUserId` exists in every fixture below purely to be
// absent from every result.
const RUN = randomUUID().slice(0, 8);

/** Neither the image provider nor FFmpeg is ever reached: `regenerateThumbnail`
 *  delegates to ThumbnailService, and a test that let the real one run would
 *  bill a real image generation. */
function makeFakeThumbnails(result: string | null = "videos/x/thumbnails/t.jpg") {
  return { generate: vi.fn(async () => result) } satisfies Pick<
    ThumbnailService,
    "generate"
  >;
}

/** `getQuota` is the only method StudioService calls. `synthesize` is stubbed
 *  to satisfy the interface and throws if anything ever reaches it — a voice
 *  page that synthesised audio would be a serious bug, not a missing feature. */
function makeFakeSpeech(quota: { usedCharacters: number; limitCharacters: number } | null) {
  return {
    synthesize: vi.fn(async () => {
      throw new Error("StudioService must never synthesise anything.");
    }),
    getQuota: vi.fn(async () => quota),
  } as unknown as SpeechProvider;
}

let userId: string;
let otherUserId: string;
let videoId: string;
let otherVideoId: string;
let service: StudioService;

/** A video owned by `ownerId`, with its own project. Returns the video id. */
async function createVideo(ownerId: string, title: string): Promise<string> {
  const project = await projectService.create(ownerId, {
    name: `studio-${RUN}-${title}`,
  });
  const video = await videoService.create(ownerId, {
    projectId: project.id,
    title,
    topic: "how interest rates work",
  });

  return video.id;
}

/**
 * A `Script` with one version, made active — the shape every downstream stage
 * assumes. `cues` and `sources` are passed through as-is so the "legacy row"
 * cases (null, and a value that is not an array) can be exercised.
 */
async function createScript(
  targetVideoId: string,
  opts: {
    content?: string;
    cues?: unknown;
    sources?: unknown;
    model?: string | null;
  } = {},
): Promise<string> {
  const script = await prisma.script.create({ data: { videoId: targetVideoId } });
  const version = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: 1,
      content: opts.content ?? "Hook. Body. Close.",
      wordCount: 4,
      cues: opts.cues as never,
      sources: opts.sources as never,
      model: opts.model ?? "test-model",
      prompt: "Write a script about interest rates.",
    },
  });

  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return version.id;
}

/** A `Thumbnail` with `count` versions, the newest of them active — what
 *  ThumbnailService leaves behind after `count` generations. */
async function createThumbnail(
  targetVideoId: string,
  count = 1,
): Promise<{ thumbnailId: string; versionIds: string[] }> {
  const thumbnail = await prisma.thumbnail.create({
    data: { videoId: targetVideoId },
  });

  const versionIds: string[] = [];
  for (let version = 1; version <= count; version += 1) {
    const created = await prisma.thumbnailVersion.create({
      data: {
        thumbnailId: thumbnail.id,
        version,
        imageUrl: `videos/${targetVideoId}/thumbnails/thumbnail-00${version}.jpg`,
        prompt: "A cinematic thumbnail background.",
        model: "test-image-model",
      },
    });
    versionIds.push(created.id);
  }

  await prisma.thumbnail.update({
    where: { id: thumbnail.id },
    data: { activeVersionId: versionIds[versionIds.length - 1] },
  });

  return { thumbnailId: thumbnail.id, versionIds };
}

beforeEach(async () => {
  userId = await createTestUser("studio");
  otherUserId = await createTestUser("studio-other");
  videoId = await createVideo(userId, "Ours");
  otherVideoId = await createVideo(otherUserId, "Theirs");
  service = new StudioService(makeFakeSpeech(null), makeFakeThumbnails());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
  await deleteTestUser(otherUserId);
});

describe("listScripts", () => {
  it("returns only the calling operator's scripts", async () => {
    await createScript(videoId);
    await createScript(otherVideoId);

    const scripts = await service.listScripts(userId);

    expect(scripts).toHaveLength(1);
    expect(scripts[0].videoId).toBe(videoId);
  });

  it("counts cues and sources off the active version", async () => {
    await createScript(videoId, {
      cues: [
        { anchor: "Hook", cue: "city skyline" },
        { anchor: "Body", cue: "trading floor" },
      ],
      sources: ["https://example.invalid/a", "https://example.invalid/b"],
    });

    const [entry] = await service.listScripts(userId);

    expect(entry.activeVersion?.cueCount).toBe(2);
    expect(entry.activeVersion?.sourceCount).toBe(2);
    expect(entry.versionCount).toBe(1);
  });

  it("reads a script written before cues and sources existed as having none", async () => {
    // Both columns are nullable with no backfill (see ScriptVersion), so this
    // is the shape of every script the operator wrote before those features
    // landed — it must read as "none", never blow up on a null.
    await createScript(videoId, { cues: null, sources: null });

    const [entry] = await service.listScripts(userId);

    expect(entry.activeVersion?.cueCount).toBe(0);
    expect(entry.activeVersion?.sourceCount).toBe(0);
  });

  it("treats a non-array JSON value as none rather than trusting the column", async () => {
    // `Json?` guarantees nothing about shape. A hand-edited row must degrade,
    // not throw — the same allowance publish.service.ts makes when it reads
    // the same column.
    await createScript(videoId, { sources: { note: "not an array" } });

    const [entry] = await service.listScripts(userId);

    expect(entry.activeVersion?.sourceCount).toBe(0);
  });

  it("reports a script whose active version was deleted rather than omitting it", async () => {
    // Script.activeVersionId is onDelete: SetNull, so this is reachable.
    await prisma.script.create({ data: { videoId } });

    const [entry] = await service.listScripts(userId);

    expect(entry.activeVersion).toBeNull();
    expect(entry.versionCount).toBe(0);
  });
});

describe("readScriptVersion", () => {
  it("returns the narration, its citations and the prompt that produced it", async () => {
    const versionId = await createScript(videoId, {
      content: "Inflation is not a mystery.",
      sources: ["https://example.invalid/paper"],
    });

    const version = await service.readScriptVersion(userId, versionId);

    expect(version.content).toBe("Inflation is not a mystery.");
    expect(version.sources).toEqual(["https://example.invalid/paper"]);
    expect(version.prompt).toContain("interest rates");
  });

  it("refuses a version belonging to another operator", async () => {
    const foreignVersionId = await createScript(otherVideoId);

    // The whole point of scoping through the video: a version id is a UUID
    // somebody could hold, and holding it must not be enough.
    await expect(service.readScriptVersion(userId, foreignVersionId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("listNarrations", () => {
  it("returns only the calling operator's narration", async () => {
    await prisma.voiceOver.create({
      data: {
        videoId,
        provider: "ELEVENLABS",
        voiceId: "voice-ours",
        audioUrl: `videos/${videoId}/audio/narration.mp3`,
        durationSeconds: 420,
      },
    });
    await prisma.voiceOver.create({
      data: {
        videoId: otherVideoId,
        provider: "ELEVENLABS",
        voiceId: "voice-theirs",
        audioUrl: `videos/${otherVideoId}/audio/narration.mp3`,
      },
    });

    const narrations = await service.listNarrations(userId);

    expect(narrations).toHaveLength(1);
    expect(narrations[0].voiceId).toBe("voice-ours");
    expect(narrations[0].durationSeconds).toBe(420);
    expect(narrations[0].hasAudio).toBe(true);
  });

  it("reports a row whose audio was never stored as unplayable", async () => {
    // A VoiceOver with no audioUrl exists — the row is written in the same
    // transaction as the upload, but nothing forbids the column being null.
    // The player must not be offered for it.
    await prisma.voiceOver.create({
      data: { videoId, provider: "ELEVENLABS", voiceId: "voice-ours" },
    });

    const [entry] = await service.listNarrations(userId);

    expect(entry.hasAudio).toBe(false);
  });
});

describe("getVoiceAllowance", () => {
  it("reports no key rather than calling ElevenLabs when none is stored", async () => {
    const speech = makeFakeSpeech({ usedCharacters: 0, limitCharacters: 10_000 });
    const withSpeech = new StudioService(speech, makeFakeThumbnails());
    vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);

    expect(await withSpeech.getVoiceAllowance(userId)).toEqual({ state: "no-key" });
    expect(speech.getQuota).not.toHaveBeenCalled();
  });

  it("reports the allowance when the provider answers", async () => {
    const withSpeech = new StudioService(
      makeFakeSpeech({ usedCharacters: 6_500, limitCharacters: 10_000 }),
      makeFakeThumbnails(),
    );
    vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue("key");

    expect(await withSpeech.getVoiceAllowance(userId)).toEqual({
      state: "known",
      usedCharacters: 6_500,
      limitCharacters: 10_000,
    });
  });

  it("reports unknown rather than zero when the provider cannot answer", async () => {
    // getQuota returns null on any failure by contract. Reporting that as
    // "0 characters left" would tell the operator narration is impossible
    // when nothing of the sort has been established.
    const withSpeech = new StudioService(makeFakeSpeech(null), makeFakeThumbnails());
    vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue("key");

    expect(await withSpeech.getVoiceAllowance(userId)).toEqual({ state: "unavailable" });
  });
});

describe("listThumbnails", () => {
  it("returns only the calling operator's thumbnails, newest version first", async () => {
    const { versionIds } = await createThumbnail(videoId, 3);
    await createThumbnail(otherVideoId, 1);

    const thumbnails = await service.listThumbnails(userId);

    expect(thumbnails).toHaveLength(1);
    expect(thumbnails[0].videoId).toBe(videoId);
    expect(thumbnails[0].versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(thumbnails[0].activeVersionId).toBe(versionIds[2]);
  });

  it("reports whether a script exists to build another prompt from", async () => {
    await createThumbnail(videoId, 1);

    expect((await service.listThumbnails(userId))[0].hasScript).toBe(false);

    await createScript(videoId);

    expect((await service.listThumbnails(userId))[0].hasScript).toBe(true);
  });
});

describe("getThumbnailImagePath", () => {
  it("resolves the stored object path for a version this operator owns", async () => {
    const { versionIds } = await createThumbnail(videoId, 1);

    await expect(service.getThumbnailImagePath(userId, versionIds[0])).resolves.toContain(
      `videos/${videoId}/thumbnails/`,
    );
  });

  it("refuses a version belonging to another operator", async () => {
    // This is what stands between the image route and serving one operator's
    // unpublished artwork to another.
    const { versionIds } = await createThumbnail(otherVideoId, 1);

    await expect(
      service.getThumbnailImagePath(userId, versionIds[0]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("setActiveThumbnailVersion", () => {
  it("moves the active pointer to an earlier attempt", async () => {
    const { thumbnailId, versionIds } = await createThumbnail(videoId, 3);

    await service.setActiveThumbnailVersion(userId, videoId, versionIds[0]);

    const thumbnail = await prisma.thumbnail.findUniqueOrThrow({
      where: { id: thumbnailId },
      select: { activeVersionId: true },
    });
    expect(thumbnail.activeVersionId).toBe(versionIds[0]);
  });

  it("refuses a version that belongs to a different video's thumbnail", async () => {
    await createThumbnail(videoId, 1);
    const second = await createVideo(userId, "Second");
    const { versionIds: foreignVersionIds } = await createThumbnail(second, 1);

    await expect(
      service.setActiveThumbnailVersion(userId, videoId, foreignVersionIds[0]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses another operator's video", async () => {
    const { versionIds } = await createThumbnail(otherVideoId, 1);

    await expect(
      service.setActiveThumbnailVersion(userId, otherVideoId, versionIds[0]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses once the video is published, because YouTube already has one", async () => {
    const { versionIds } = await createThumbnail(videoId, 2);
    await prisma.video.update({ where: { id: videoId }, data: { status: "PUBLISHED" } });

    await expect(
      service.setActiveThumbnailVersion(userId, videoId, versionIds[0]),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("regenerateThumbnail", () => {
  it("generates when the video has an active script and has not published", async () => {
    await createScript(videoId);
    const thumbnails = makeFakeThumbnails("videos/x/thumbnails/new.jpg");
    const withThumbnails = new StudioService(makeFakeSpeech(null), thumbnails);

    await withThumbnails.regenerateThumbnail(userId, videoId);

    expect(thumbnails.generate).toHaveBeenCalledWith(userId, videoId);
  });

  it("refuses a published video without spending anything", async () => {
    // The refusal has to happen before the provider is reached, or it has
    // already failed at the one job it exists to do.
    await createScript(videoId);
    await prisma.video.update({ where: { id: videoId }, data: { status: "PUBLISHED" } });
    const thumbnails = makeFakeThumbnails();
    const withThumbnails = new StudioService(makeFakeSpeech(null), thumbnails);

    await expect(
      withThumbnails.regenerateThumbnail(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(thumbnails.generate).not.toHaveBeenCalled();
  });

  it("refuses a video with no active script without spending anything", async () => {
    // ThumbnailService builds its prompt from the script's opening and
    // returns null without one — so this call could only ever cost a round
    // trip and produce nothing.
    const thumbnails = makeFakeThumbnails();
    const withThumbnails = new StudioService(makeFakeSpeech(null), thumbnails);

    await expect(
      withThumbnails.regenerateThumbnail(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(thumbnails.generate).not.toHaveBeenCalled();
  });

  it("refuses another operator's video", async () => {
    await createScript(otherVideoId);
    const thumbnails = makeFakeThumbnails();
    const withThumbnails = new StudioService(makeFakeSpeech(null), thumbnails);

    await expect(
      withThumbnails.regenerateThumbnail(userId, otherVideoId),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(thumbnails.generate).not.toHaveBeenCalled();
  });

  it("turns the generator's silent null into a stated failure", async () => {
    // ThumbnailService never throws — it logs and answers null — which is
    // right for a pipeline stage and useless to an operator who just pressed
    // a button and was billed for it.
    await createScript(videoId);
    const withThumbnails = new StudioService(makeFakeSpeech(null), makeFakeThumbnails(null));

    await expect(
      withThumbnails.regenerateThumbnail(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("countReadyVideosWithoutThumbnail", () => {
  it("counts only this operator's READY videos with no thumbnail", async () => {
    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });
    await prisma.video.update({ where: { id: otherVideoId }, data: { status: "READY" } });

    expect(await service.countReadyVideosWithoutThumbnail(userId)).toBe(1);

    await createThumbnail(videoId, 1);

    expect(await service.countReadyVideosWithoutThumbnail(userId)).toBe(0);
  });

  it("ignores videos that have not reached the thumbnail stage or are already published", async () => {
    // A DRAFT has not had its chance yet and a PUBLISHED video's has gone —
    // neither is something an operator can act on, so neither belongs in a
    // number offered as a to-do.
    const published = await createVideo(userId, "Gone");
    await prisma.video.update({ where: { id: published }, data: { status: "PUBLISHED" } });

    expect(await service.countReadyVideosWithoutThumbnail(userId)).toBe(0);
  });
});
