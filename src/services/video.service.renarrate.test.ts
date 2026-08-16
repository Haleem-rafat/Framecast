import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Alignment } from "@/lib/captions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";
import { channelService } from "@/services/channel.service";
import { narrationNeedsSynthesis } from "@/services/pipeline-runner";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { SpeechProvider } from "@/services/providers/types";
import { videoService } from "@/services/video.service";
import { VoiceOverService } from "@/services/voiceover.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * Changing a finished video's narration voice.
 *
 * The whole feature is a re-run of the pipeline from narration onward, so
 * these tests are about the two halves of that: `VideoService.requestRenarration`
 * (what it refuses, what it destroys, and that two clicks cannot queue two
 * runs) and `VoiceOverService.generate` honouring the request (which voice it
 * asks for, that the alignment is genuinely rewritten, and that the request is
 * consumed exactly once).
 *
 * ElevenLabs is never called. The speech provider is the injected fake below —
 * the same seam `voiceover.service.test.ts` uses, and for the same reason: the
 * operator is on a 10,000-character-a-month allowance and a real call from a
 * test suite is real money. The fake returns a *different* alignment on each
 * call, which is what makes "the alignment was regenerated, not reused"
 * something this file can actually prove rather than assert.
 *
 * Every test gets its own throwaway User (see src/test/fixtures.ts) against
 * the shared Postgres database.
 */
const RUN = randomUUID().slice(0, 8);
const SCRIPT_CONTENT = "hello";
const FAKE_API_KEY = `fake-elevenlabs-key-${RUN}`;

/** The voice the channel is branded with — what an ordinary run narrates in. */
const CHANNEL_VOICE = { voiceId: "AbC123channel", voiceName: "Roger" };
/** The voice the operator picks in the dialog. */
const CHOSEN_VOICE = { voiceId: "XyZ789chosen", voiceName: "Charlotte" };

/**
 * A fake ElevenLabs whose every synthesis is distinguishable from the last.
 *
 * The alignment's character times shift by a tenth of a second per call, which
 * stands in for the thing that actually makes re-narration necessary: a
 * different voice speaks at a different rate, so every caption boundary and
 * every clip's start time moves. A test that returned the same alignment twice
 * could not tell a rewritten alignment from a reused one.
 */
function makeFakeProvider(): SpeechProvider & { calls: number } {
  const state = { calls: 0 };

  return {
    get calls() {
      return state.calls;
    },
    synthesize: vi.fn(async () => {
      state.calls += 1;
      const shift = state.calls * 0.1;

      return {
        audio: Buffer.from(`fake-mp3-bytes-${state.calls}`),
        alignment: {
          characters: [...SCRIPT_CONTENT],
          characterStartTimesSeconds: [0, 1, 2, 3, 4].map((n) => n * shift),
          characterEndTimesSeconds: [1, 2, 3, 4, 5].map((n) => n * shift),
        },
        characterCount: SCRIPT_CONTENT.length,
      };
    }),
  } as SpeechProvider & { calls: number };
}

let userId: string;
let videoId: string;
let service: VoiceOverService;
let fakeProvider: SpeechProvider & { calls: number };

/**
 * A video in the state the "Change voice" button is actually offered in: a
 * channel with its own voice, an approved script, a real narration synthesised
 * through the service (so the `VoiceOver` row, the audio object and the
 * SUBTITLE alignment asset all genuinely exist), and a succeeded render.
 */
async function narratedVideo(): Promise<string> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Test channel",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  await prisma.channelBrand.create({
    data: { channelId: channel.id, ...CHANNEL_VOICE },
  });

  const project = await projectService.create(userId, {
    name: `test-renarrate-${randomUUID().slice(0, 8)}`,
    channelId: channel.id,
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
      content: SCRIPT_CONTENT,
      wordCount: 1,
    },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  // The real first narration, through the real service, so everything
  // downstream of it exists exactly as a live video's does.
  await prisma.video.update({
    where: { id: video.id },
    data: { status: "QUEUED" },
  });
  await service.generate(userId, video.id);

  // …and a render on top of it, so this is a video an operator has watched.
  await prisma.renderJob.create({
    data: {
      videoId: video.id,
      status: "SUCCEEDED",
      outputUrl: `renders/${video.id}.mp4`,
      progress: 100,
      finishedAt: new Date(),
    },
  });
  await prisma.video.update({
    where: { id: video.id },
    data: { status: "READY" },
  });

  return video.id;
}

/** The alignment currently stored for a video, read back out of storage
 *  through the newest SUBTITLE asset — the same lookup render.service.ts and
 *  shorts.service.ts both use to find it. */
async function storedAlignment(id: string): Promise<Alignment> {
  const asset = await prisma.asset.findFirstOrThrow({
    where: {
      kind: "SUBTITLE",
      deletedAt: null,
      storagePath: { startsWith: `videos/${id}/` },
    },
    orderBy: { createdAt: "desc" },
    select: { storagePath: true },
  });

  return JSON.parse((await getObject(asset.storagePath)).toString("utf-8")) as Alignment;
}

/** The voice id the fake provider was asked for on its nth call. */
function requestedVoice(call: number): string {
  return (fakeProvider.synthesize as ReturnType<typeof vi.fn>).mock.calls[call][0]
    .voiceId;
}

beforeEach(async () => {
  userId = await createTestUser("renarrate");
  fakeProvider = makeFakeProvider();
  service = new VoiceOverService(fakeProvider);

  // generate() resolves an ELEVENLABS credential before ever reaching the
  // (injected, fake) provider. This throwaway user stores none, so the lookup
  // is stubbed rather than left to legitimately return null.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(FAKE_API_KEY);

  videoId = await narratedVideo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
});

describe("videoService.requestRenarration — what it refuses", () => {
  it("refuses a published video, naming YouTube and the reclaimed render", async () => {
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "PUBLISHED" },
    });

    const error = await videoService
      .requestRenarration(userId, videoId, CHOSEN_VOICE)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    // The two facts that make this unrecoverable rather than merely blocked:
    // the upload cannot be replaced, and the local material is gone.
    expect((error as Error).message).toContain("YouTube");
    expect((error as Error).message).toContain("reclaimed");
    // And the one thing the operator can actually do instead.
    expect((error as Error).message).toContain("upload it as its own video");
  });

  it("refuses a video the worker is holding, rather than fighting it for the row", async () => {
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: "RENDERING",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const error = await videoService
      .requestRenarration(userId, videoId, CHOSEN_VOICE)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toContain("render worker is holding this video");
    // Cancellation is the operator's actual next move — the worker owns the
    // FFmpeg child process, so nothing here can stop it.
    expect((error as Error).message).toContain("Cancel it");

    // Nothing was written: the video is still the worker's, and its shorts are
    // still there.
    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(after.status).toBe("RENDERING");
    expect(after.renarrateVoiceId).toBeNull();
  });

  it("refuses a READY video whose lease is still live (metadata/thumbnail in flight)", async () => {
    // render.service.ts commits READY the moment the encode succeeds, while
    // runPipeline is still running metadata and thumbnail behind it and the
    // worker is still renewing the lease. Status alone reads as finished here;
    // only the lease says a worker is still inside.
    await prisma.video.update({
      where: { id: videoId },
      data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
    });

    await expect(
      videoService.requestRenarration(userId, videoId, CHOSEN_VOICE),
    ).rejects.toThrow(/render worker is holding this video/);
  });

  it("allows a stranded video whose lease has lapsed", async () => {
    // The mirror of the test above, and the reason the guard is the lease
    // rather than the status: a GENERATING video with an expired lease is one
    // whose worker died, and recovering it is exactly what an operator needs.
    await prisma.video.update({
      where: { id: videoId },
      data: {
        status: "GENERATING",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await expect(
      videoService.requestRenarration(userId, videoId, CHOSEN_VOICE),
    ).resolves.toEqual({ shortsRemoved: 0 });
  });

  it("refuses a video that has never been narrated, as not-yet rather than broken", async () => {
    const project = await projectService.create(userId, {
      name: `test-renarrate-draft-${randomUUID().slice(0, 8)}`,
    });
    const draft = await videoService.create(userId, {
      projectId: project.id,
      title: "Not narrated yet",
      topic: "x",
    });

    const error = await videoService
      .requestRenarration(userId, draft.id, CHOSEN_VOICE)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toContain("no narration yet");
    // Nothing to replace — the answer is to run it, not to fix it.
    expect((error as Error).message).toContain("nothing to replace");
  });

  it("hides another operator's video behind NotFound", async () => {
    const otherUserId = await createTestUser("renarrate-other");

    try {
      await expect(
        videoService.requestRenarration(otherUserId, videoId, CHOSEN_VOICE),
      ).rejects.toThrow(NotFoundError);

      // And nothing was written to it.
      const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      expect(after.renarrateVoiceId).toBeNull();
      expect(after.status).toBe("READY");
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("videoService.requestRenarration — what it does", () => {
  it("records the chosen voice and re-queues the video so the render cannot be skipped", async () => {
    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);

    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });

    expect(after.renarrateVoiceId).toBe(CHOSEN_VOICE.voiceId);
    expect(after.renarrateVoiceName).toBe(CHOSEN_VOICE.voiceName);
    // QUEUED is what makes this a re-run rather than a note on a finished
    // video. runPipeline's render stage returns "already READY — skipped" for a
    // READY video, and renderService.render refuses anything but GENERATING —
    // so leaving the status alone would produce new audio under the old render.
    expect(after.status).toBe("QUEUED");
    expect(after.leaseExpiresAt).toBeNull();
    // A deliberate operator action gets a fresh three attempts, like
    // JobService.retry: a video that had exhausted them would otherwise be
    // queued for a worker that will never claim it.
    expect(after.attempts).toBe(0);
  });

  it("leaves the script-derived metadata and thumbnail alone", async () => {
    await prisma.video.update({
      where: { id: videoId },
      data: { generatedTitle: "A title the model wrote" },
    });

    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);

    // Metadata and the thumbnail are derived from the script, not from the
    // narration, and runPipeline re-runs both stages unconditionally anyway.
    // Clearing them would only widen the window where a publishable video has
    // no title.
    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(after.generatedTitle).toBe("A title the model wrote");
  });

  it("records the re-narration in the video's own history", async () => {
    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);

    const event = await prisma.videoStatusEvent.findFirstOrThrow({
      where: { videoId, to: "QUEUED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.from).toBe("READY");
    expect(event.message).toContain(CHOSEN_VOICE.voiceName);
  });

  it("normalises away a name sent without an id it belongs to", async () => {
    await videoService.requestRenarration(userId, videoId, {
      voiceId: CHOSEN_VOICE.voiceId,
      voiceName: null,
    });

    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(after.renarrateVoiceId).toBe(CHOSEN_VOICE.voiceId);
    expect(after.renarrateVoiceName).toBeNull();
  });

  it("queues one run when two clicks arrive together", async () => {
    // The read inside requestRenarration only produces a precise message; the
    // guard is the conditional update repeating the status it just read. Both
    // callers see READY, only one update can still match the row.
    const results = await Promise.allSettled([
      videoService.requestRenarration(userId, videoId, CHOSEN_VOICE),
      videoService.requestRenarration(userId, videoId, CHOSEN_VOICE),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    // One transition, not two — the losing click appended nothing.
    const events = await prisma.videoStatusEvent.findMany({
      where: { videoId, to: "QUEUED", from: "READY" },
    });
    expect(events).toHaveLength(1);

    // And, downstream, exactly one narration: the worker claims the queued
    // video once, and generate() consumes the request inside the transaction
    // that fulfils it.
    const callsBefore = fakeProvider.calls;
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    expect(fakeProvider.calls).toBe(callsBefore + 1);
    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.calls).toBe(callsBefore + 1);
  });
});

describe("videoService.requestRenarration — the shorts cut from the old narration", () => {
  async function addShort(index: number) {
    return prisma.short.create({
      data: {
        videoId,
        index,
        startSeconds: 10 + index,
        endSeconds: 40 + index,
        title: `Short ${index}`,
        status: "READY",
        // A path that was never written: `deleteShortFile` is documented to
        // no-op on a file that is already gone, which is what keeps this
        // best-effort cleanup from being a reason the request fails.
        outputPath: `shorts/${randomUUID()}.mp4`,
      },
    });
  }

  it("discards them, because their windows and captions are measured against the old audio", async () => {
    await addShort(0);
    await addShort(1);

    const result = await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);

    expect(result.shortsRemoved).toBe(2);
    // Hard-deleted, not soft: `@@unique([videoId, index])` is what stops a
    // regenerated set colliding, and a soft-deleted row would keep occupying
    // its slot while being filtered out of every read.
    expect(await prisma.short.count({ where: { videoId } })).toBe(0);
  });

  it("says so in the activity log, so the loss is on the record", async () => {
    await addShort(0);

    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);

    const entry = await prisma.activityLog.findFirstOrThrow({
      where: { entityType: "Video", entityId: videoId, action: "video.renarrate" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.message).toContain("1 short");
  });

  it("reports none for a video that had none", async () => {
    await expect(
      videoService.requestRenarration(userId, videoId, CHOSEN_VOICE),
    ).resolves.toEqual({ shortsRemoved: 0 });
  });
});

describe("the re-narration itself", () => {
  it("narrates in the chosen voice rather than the channel's", async () => {
    // The first narration, in the fixture, used the channel's voice.
    expect(requestedVoice(0)).toBe(CHANNEL_VOICE.voiceId);

    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    expect(requestedVoice(1)).toBe(CHOSEN_VOICE.voiceId);

    // And the VoiceOver row now records the voice the audio is actually in,
    // name included, which is what the picker preselects next time and what
    // the narration library prints.
    const voiceOver = await prisma.voiceOver.findUniqueOrThrow({ where: { videoId } });
    expect(voiceOver.voiceId).toBe(CHOSEN_VOICE.voiceId);
    expect(voiceOver.voiceName).toBe(CHOSEN_VOICE.voiceName);
  });

  it("regenerates the alignment rather than reusing the old one", async () => {
    // This is the defect the whole feature is built around avoiding: new audio
    // with the old caption timings would render, publish and look fine in a
    // status column.
    const before = await storedAlignment(videoId);

    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    const after = await storedAlignment(videoId);

    expect(after.characterEndTimesSeconds).not.toEqual(
      before.characterEndTimesSeconds,
    );
    // The duration the render and the timeline both read is the last end time
    // of that alignment, so it moved with it.
    const voiceOver = await prisma.voiceOver.findUniqueOrThrow({ where: { videoId } });
    expect(voiceOver.durationSeconds).toBe(
      Math.round(after.characterEndTimesSeconds[after.characterEndTimesSeconds.length - 1]),
    );
  });

  it("leaves the video ready to render again rather than skipping it", async () => {
    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    // Not READY, so runPipeline's `if (video.status === "READY") return
    // "skipped"` does not fire and renderService.render's GENERATING guard is
    // satisfied — the encode runs again over the new audio and new captions.
    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(after.status).toBe("GENERATING");
    // The previous render's row is left as history; render.service.ts writes a
    // new RenderJob and overwrites the file at its deterministic path.
    expect(
      await prisma.renderJob.count({ where: { videoId, status: "SUCCEEDED" } }),
    ).toBe(1);
  });

  it("consumes the request exactly once, so a later retry does not re-bill ElevenLabs", async () => {
    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    const after = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(after.renarrateVoiceId).toBeNull();
    expect(after.renarrateVoiceName).toBeNull();

    // A retry after a failure further down the pipeline — footage, the render —
    // finds narration already done and skips it, exactly as an ordinary retry
    // always has.
    const calls = fakeProvider.calls;
    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.calls).toBe(calls);
  });

  it("goes back to the channel's voice for the next video, having changed nothing on the channel", async () => {
    await videoService.requestRenarration(userId, videoId, CHOSEN_VOICE);
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "GENERATING" },
    });
    await service.generate(userId, videoId);

    // The operator asked to hear *this* video in another voice, not to re-brand
    // the channel — that is what the branding screen is for.
    const brand = await prisma.channelBrand.findFirstOrThrow({
      where: { channel: { userId } },
    });
    expect(brand.voiceId).toBe(CHANNEL_VOICE.voiceId);
  });
});

/**
 * The single line between "new audio and new captions" and "new audio and old
 * captions".
 *
 * Pulled out of `runPipeline` as a pure function precisely so it can be tested
 * without a bucket, a footage provider and an encoder: getting it wrong in the
 * skip direction produces a video that is silently mistimed, which is the one
 * defect in this feature that no status column would show.
 */
describe("narrationNeedsSynthesis", () => {
  it("skips a narration that already exists on an ordinary run", () => {
    expect(
      narrationNeedsSynthesis({ voiceOver: {}, renarrateVoiceId: null }, false),
    ).toBe(false);
  });

  it("synthesises when there is no narration at all", () => {
    expect(
      narrationNeedsSynthesis({ voiceOver: null, renarrateVoiceId: null }, false),
    ).toBe(true);
  });

  it("synthesises for the CLI's --force-narration", () => {
    expect(
      narrationNeedsSynthesis({ voiceOver: {}, renarrateVoiceId: null }, true),
    ).toBe(true);
  });

  it("synthesises for a standing re-narration request", () => {
    expect(
      narrationNeedsSynthesis({ voiceOver: {}, renarrateVoiceId: "XyZ789chosen" }, false),
    ).toBe(true);
  });
});
