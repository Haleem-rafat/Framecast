import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/config/env";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { SpeechProvider } from "@/services/providers/types";
import { videoService } from "@/services/video.service";
import { VoiceOverService } from "@/services/voiceover.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database and the real storage root (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts) instead of the operator's real account, so this
// file's fixtures can never collide with — or be mistaken for — the
// operator's real projects/videos/usage. The provider is always the injected
// fake below: the real ElevenLabs API is never called from this file (see
// the operator's free-tier budget note on the "refuses to re-synthesise"
// test).
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-voiceover-${RUN}`;
const SCRIPT_CONTENT = "hello";
const FAKE_API_KEY = `fake-elevenlabs-key-${RUN}`;

function makeFakeProvider(): SpeechProvider {
  return {
    synthesize: vi.fn(async () => ({
      audio: Buffer.from("fake-mp3-bytes"),
      alignment: {
        characters: [..."hello"],
        characterStartTimesSeconds: [0, 0.1, 0.2, 0.3, 0.4],
        characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5],
      },
      characterCount: 5,
    })),
  };
}

let userId: string;
let projectId: string;
let videoId: string;
let service: VoiceOverService;
let fakeProvider: SpeechProvider;

/**
 * Creates an approved script directly (rather than through scriptService,
 * which needs a PromptTemplate fixture) and moves the video to QUEUED
 * directly (rather than through videoService.approveScript) — both are
 * upstream stages this file isn't exercising; only the resulting DB state
 * matters to voiceOverService.
 */
async function approveScriptFixture(
  content = SCRIPT_CONTENT,
  status: "QUEUED" | "GENERATING" = "QUEUED",
) {
  const script = await prisma.script.create({ data: { videoId } });
  const version = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: 1,
      content,
      wordCount: content.trim().split(/\s+/).filter(Boolean).length,
    },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });
  await prisma.video.update({ where: { id: videoId }, data: { status } });
}

beforeEach(async () => {
  userId = await createTestUser("voiceover");
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
  videoId = (
    await videoService.create(userId, {
      projectId,
      title: "How inflation actually works",
      topic: "inflation",
    })
  ).id;

  fakeProvider = makeFakeProvider();
  service = new VoiceOverService(fakeProvider);

  // generate() unconditionally resolves an ELEVENLABS credential for the
  // caller before ever reaching the (injected, mocked) provider. This
  // private test user never stores one, so resolveKey() would legitimately
  // return null on its own — it's stubbed here so every test controls it
  // explicitly and no test slows down on a real lookup.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(FAKE_API_KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
});

describe("voiceOverService.generate", () => {
  it("stores the audio and records duration", async () => {
    await approveScriptFixture();

    const result = await service.generate(userId, videoId);

    // Last characterEndTimesSeconds value is 0.5; VoiceOver.durationSeconds
    // is an Int column, so the service rounds rather than truncating.
    expect(result.durationSeconds).toBe(1);
    expect(result.characterCount).toBe(5);

    const voiceOver = await prisma.voiceOver.findUniqueOrThrow({ where: { videoId } });
    expect(voiceOver.provider).toBe("ELEVENLABS");
    expect(voiceOver.durationSeconds).toBe(1);
    expect(voiceOver.audioUrl).toBeTruthy();
    expect(voiceOver.audioUrl).toContain(videoId);
  });

  it("persists the alignment as an Asset so captions can be rebuilt", async () => {
    await approveScriptFixture();

    await service.generate(userId, videoId);

    const asset = await prisma.asset.findFirstOrThrow({
      where: { kind: "SUBTITLE", storagePath: { contains: videoId } },
    });
    expect(asset.provider).toBe("ELEVENLABS");
    expect(asset.storagePath).toContain(videoId);
  });

  it("refuses to re-synthesise when a VoiceOver already exists", async () => {
    // The operator is on a 10,000 character/month free tier and one script is
    // ~7,000. A silent re-run would burn the month.
    await approveScriptFixture();
    await service.generate(userId, videoId);

    (fakeProvider.synthesize as ReturnType<typeof vi.fn>).mockClear();

    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("re-synthesises when force is passed", async () => {
    await approveScriptFixture();
    await service.generate(userId, videoId);

    (fakeProvider.synthesize as ReturnType<typeof vi.fn>).mockClear();

    await expect(service.generate(userId, videoId, { force: true })).resolves.toBeTruthy();
    expect(fakeProvider.synthesize).toHaveBeenCalledTimes(1);
  });

  it("refuses before spending anything when the script cannot fit in the remaining quota", async () => {
    // 2,000 characters against the 1,042 that remain of a 10,000 allowance —
    // roughly the shape of a real script against an exhausted free tier.
    await approveScriptFixture("a".repeat(2000));
    fakeProvider.getQuota = vi.fn(async () => ({
      usedCharacters: 8958,
      limitCharacters: 10000,
    }));

    // ElevenLabs reports an exhausted allowance as a 401, which reads as a bad
    // key. Refusing up front says what is actually wrong, and says it before
    // the request rather than after it has already failed.
    const error = await service
      .generate(userId, videoId)
      .catch((caught: Error) => caught);

    expect((error as Error).message).toContain("2,000");
    expect((error as Error).message).toContain("1,042");
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("proceeds when the remaining quota is enough", async () => {
    await approveScriptFixture("a".repeat(100));
    fakeProvider.getQuota = vi.fn(async () => ({
      usedCharacters: 0,
      limitCharacters: 10000,
    }));

    await expect(service.generate(userId, videoId)).resolves.toBeTruthy();
    expect(fakeProvider.synthesize).toHaveBeenCalledTimes(1);
  });

  it("proceeds when the quota cannot be determined", async () => {
    await approveScriptFixture();
    fakeProvider.getQuota = vi.fn(async () => null);

    // A failed quota check must never become a new reason narration does not
    // happen — it only ever turns a later failure into an earlier refusal.
    await expect(service.generate(userId, videoId)).resolves.toBeTruthy();
    expect(fakeProvider.synthesize).toHaveBeenCalledTimes(1);
  });

  it("refuses when the video has no approved script", async () => {
    // No script created at all — but the video is still pushed to QUEUED
    // directly, bypassing videoService.approveScript's own guard, so this
    // exercises voiceOverService's guard in isolation.
    await prisma.video.update({ where: { id: videoId }, data: { status: "QUEUED" } });

    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("refuses when the video is not yet queued (script not approved)", async () => {
    // Video stays DRAFT even though a script exists — approval is what makes
    // narration eligible, per videoService.approveScript's Gate 1.
    const script = await prisma.script.create({ data: { videoId } });
    const version = await prisma.scriptVersion.create({
      data: { scriptId: script.id, version: 1, content: SCRIPT_CONTENT, wordCount: 1 },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });

    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("narrates a video the worker has claimed into GENERATING (C1 regression)", async () => {
    // JobService.claimNext (job.service.ts) moves QUEUED -> GENERATING
    // *before* runPipeline ever reads the video, so by the time this method
    // runs inside the worker, video.status is always GENERATING, never
    // QUEUED. Before the fix, generate() refused any status other than
    // exactly QUEUED, so every worker-claimed video with no existing
    // VoiceOver row failed narration immediately, burned all 3 attempts, and
    // became permanently unclaimable. This reproduces that claim.
    await approveScriptFixture(SCRIPT_CONTENT, "GENERATING");

    const result = await service.generate(userId, videoId);

    expect(result.characterCount).toBe(5);
    const voiceOver = await prisma.voiceOver.findUniqueOrThrow({ where: { videoId } });
    expect(voiceOver.audioUrl).toBeTruthy();
  });

  it("still refuses a DRAFT video (Gate 1 stays closed)", async () => {
    // GENERATING must be accepted without weakening Gate 1: a video that
    // never passed approveScript's DRAFT -> QUEUED gate must still be
    // refused.
    const script = await prisma.script.create({ data: { videoId } });
    const version = await prisma.scriptVersion.create({
      data: { scriptId: script.id, version: 1, content: SCRIPT_CONTENT, wordCount: 1 },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });
    // videoId's video is still DRAFT — never moved.

    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    await expect(service.generate(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("throws ProviderError when no ElevenLabs credential is configured", async () => {
    await approveScriptFixture();
    vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);

    await expect(service.generate(userId, videoId)).rejects.toThrow(ProviderError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("writes a ProviderUsage row recording the character count", async () => {
    await approveScriptFixture();

    const before = new Date();
    await service.generate(userId, videoId);
    const after = new Date();

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: {
        operation: "voiceover.generate",
        provider: "ELEVENLABS",
        createdAt: { gte: before, lte: after },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(usage.succeeded).toBe(true);
    expect(usage.inputTokens).toBe(5);
  });
});

/**
 * The voice used to be `env.ELEVENLABS_VOICE_ID` — one voice, from one
 * environment variable, for every video on every channel. It now comes from
 * the channel, and these tests are the contract that says so without ever
 * calling ElevenLabs: the provider is the same injected fake as above, so
 * "which voice was requested" is read off the fake's arguments and no
 * characters are spent.
 */
describe("voiceOverService.generate — which voice narrates", () => {
  /** A channel with an optional chosen voice, and a project pointed at it, so
   *  the video under test resolves a brand at all. */
  async function videoOnChannel(voice: { voiceId: string; voiceName: string } | null) {
    const channel = await channelService.connect(userId, {
      youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
      title: "Test channel",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });

    if (voice) {
      await prisma.channelBrand.create({ data: { channelId: channel.id, ...voice } });
    }

    const project = await projectService.create(userId, {
      name: `test-voiceover-channel-${randomUUID().slice(0, 8)}`,
      channelId: channel.id,
    });
    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "How inflation actually works",
      topic: "inflation",
    });

    const script = await prisma.script.create({ data: { videoId: video.id } });
    const version = await prisma.scriptVersion.create({
      data: { scriptId: script.id, version: 1, content: SCRIPT_CONTENT, wordCount: 1 },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });
    await prisma.video.update({
      where: { id: video.id },
      data: { status: "QUEUED" },
    });

    return video.id;
  }

  /** The voice id the fake provider was asked for on its nth call. */
  function requestedVoice(call: number): string {
    return (fakeProvider.synthesize as ReturnType<typeof vi.fn>).mock.calls[call][0]
      .voiceId;
  }

  it("narrates with the channel's chosen voice", async () => {
    const id = await videoOnChannel({
      voiceId: "AbC123kidsvoice",
      voiceName: "Charlotte",
    });

    await service.generate(userId, id);

    expect(requestedVoice(0)).toBe("AbC123kidsvoice");
    // And the name the operator saw when they chose it, so the narration
    // library prints a name rather than a 20-character id.
    const voiceOver = await prisma.voiceOver.findUniqueOrThrow({
      where: { videoId: id },
    });
    expect(voiceOver.voiceId).toBe("AbC123kidsvoice");
    expect(voiceOver.voiceName).toBe("Charlotte");
  });

  it("falls back to the deployment's voice for a channel that has not chosen one", async () => {
    // Every channel that existed before this feature is in exactly this state,
    // and has to narrate identically to how it did before.
    const id = await videoOnChannel(null);

    await service.generate(userId, id);

    expect(requestedVoice(0)).toBe(env.ELEVENLABS_VOICE_ID);
  });

  it("falls back for a video whose project has no channel at all", async () => {
    // The fixture at the top of this file is exactly that video.
    await approveScriptFixture();

    await service.generate(userId, videoId);

    expect(requestedVoice(0)).toBe(env.ELEVENLABS_VOICE_ID);
  });

  it("sends two different voices for two channels narrated back to back", async () => {
    // The reason this lives on the channel rather than on the operator: both
    // channels belong to the same person, and both need their own voice at the
    // same time. A per-user default could not express this.
    const finance = await videoOnChannel({
      voiceId: "AbC123finance",
      voiceName: "Roger",
    });
    const kids = await videoOnChannel({ voiceId: "XyZ789kids", voiceName: "Charlotte" });

    await service.generate(userId, finance);
    await service.generate(userId, kids);

    expect([requestedVoice(0), requestedVoice(1)]).toEqual([
      "AbC123finance",
      "XyZ789kids",
    ]);
  });
});
