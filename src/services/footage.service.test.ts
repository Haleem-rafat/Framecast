import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { ClipDownloader, FootageProviders } from "@/services/footage.service";
import { FootageService } from "@/services/footage.service";
import { projectService } from "@/services/project.service";
import type { StockClip, StockFootageProvider } from "@/services/providers/types";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts) instead of the operator's real account. The
// stock-footage providers and the clip downloader are always the injected
// fakes below: neither Pexels nor Pixabay, nor any real CDN, is ever
// contacted from this file — real-API verification is done by hand, see the
// task report.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-footage-${RUN}`;

// Several tests in this file upload small fake clips to the real bucket and
// round-trip through a live, shared remote Postgres instance — comfortably
// past Vitest's 5s default under any network variance.
vi.setConfig({ testTimeout: 20_000 });

function makeClip(source: "PEXELS" | "PIXABAY", externalId: string): StockClip {
  return {
    source,
    externalId,
    url: `https://example.invalid/${source.toLowerCase()}/${externalId}.mp4`,
    width: 1280,
    height: 720,
    durationSeconds: 12,
  };
}

function fakeProvider(clips: StockClip[]): StockFootageProvider {
  return { search: vi.fn(async () => clips) };
}

function makeDownloader(): ClipDownloader {
  return vi.fn(async (clip: StockClip) =>
    Buffer.from(`fake-clip-bytes-${clip.source}-${clip.externalId}`),
  );
}

let userId: string;
let projectId: string;
let videoId: string;

async function createVoiceOverFixture(durationSeconds: number) {
  await prisma.voiceOver.create({
    data: {
      videoId,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      durationSeconds,
    },
  });
}

/** Asset carries no direct videoId column (see footage.service.ts and
 * render.service.ts) — every clip's storagePath is scoped under
 * `videos/{videoId}/...`, so that prefix is how a video's clips are found. */
function findClipAssets() {
  return prisma.asset.findMany({
    where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
  });
}

beforeEach(async () => {
  userId = await createTestUser("footage");
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
  videoId = (
    await videoService.create(userId, {
      projectId,
      title: "How inflation actually works",
      topic: "inflation",
    })
  ).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Asset carries no FK back to Video/User (see findClipAssets' comment), so
  // deleteTestUser()'s cascade can't reach the clip rows this file creates —
  // swept explicitly so this file doesn't leave orphans in the shared DB.
  await prisma.asset.deleteMany({
    where: { storagePath: { startsWith: `videos/${videoId}/` } },
  });
  await deleteTestUser(userId);
});

describe("footageService.collect", () => {
  it("refuses a video with no narration yet, since clip count depends on its duration", async () => {
    const providers: FootageProviders = { PEXELS: fakeProvider([]), PIXABAY: fakeProvider([]) };
    const service = new FootageService(providers, makeDownloader());

    await expect(service.collect(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
    expect(providers.PEXELS.search).not.toHaveBeenCalled();
    expect(providers.PIXABAY.search).not.toHaveBeenCalled();

    const assets = await findClipAssets();
    expect(assets).toHaveLength(0);
  });

  it("refuses a video that doesn't belong to the caller", async () => {
    await createVoiceOverFixture(25);
    const service = new FootageService(
      { PEXELS: fakeProvider([]), PIXABAY: fakeProvider([]) },
      makeDownloader(),
    );

    await expect(service.collect(randomUUID(), videoId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("computes clip count as ceil(duration / 12) + 2", async () => {
    await createVoiceOverFixture(13); // ceil(13/12) + 2 = 2 + 2 = 4
    const pexelsClips = [1, 2, 3, 4].map((n) => makeClip("PEXELS", `p-${n}`));
    const pixabayClips = [1, 2, 3, 4].map((n) => makeClip("PIXABAY", `x-${n}`));
    const service = new FootageService(
      { PEXELS: fakeProvider(pexelsClips), PIXABAY: fakeProvider(pixabayClips) },
      makeDownloader(),
    );

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(4);
  });

  it("caps the number of unique clips fetched even for a long video, relying on render-time repetition for coverage", async () => {
    // A real ~7-minute (420s) narration would want ceil(420/12)+2 = 37
    // unique clips uncapped — the exact shape of the bug that made a real
    // render OOM (see render-oom-report.md). The cap keeps the fetch itself
    // bounded regardless of narration length.
    await createVoiceOverFixture(420);
    const pexelsClips = Array.from({ length: 20 }, (_, n) => makeClip("PEXELS", `p-${n}`));
    const pixabayClips = Array.from({ length: 20 }, (_, n) => makeClip("PIXABAY", `x-${n}`));
    const service = new FootageService(
      { PEXELS: fakeProvider(pexelsClips), PIXABAY: fakeProvider(pixabayClips) },
      makeDownloader(),
    );

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(12);
    const assets = await findClipAssets();
    expect(assets).toHaveLength(12);
  });

  it("stores one Asset of kind VIDEO with a storagePath per clip", async () => {
    await createVoiceOverFixture(25); // ceil(25/12) + 2 = 3 + 2 = 5
    const pexelsClips = [1, 2, 3, 4, 5].map((n) => makeClip("PEXELS", `pex-${n}`));
    const pixabayClips = [1, 2, 3, 4, 5].map((n) => makeClip("PIXABAY", `pix-${n}`));
    const service = new FootageService(
      { PEXELS: fakeProvider(pexelsClips), PIXABAY: fakeProvider(pixabayClips) },
      makeDownloader(),
    );

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(5);
    expect((result.bySource.PEXELS ?? 0) + (result.bySource.PIXABAY ?? 0)).toBe(5);

    const assets = await findClipAssets();
    expect(assets).toHaveLength(5);
    for (const asset of assets) {
      expect(asset.kind).toBe("VIDEO");
      expect(asset.storagePath).toContain(videoId);
      expect(asset.storagePath).toContain("/clips/");
      expect(asset.externalId).not.toBeNull();
    }
  });

  it("alternates between sources", async () => {
    await createVoiceOverFixture(1); // ceil(1/12) + 2 = 1 + 2 = 3
    const pexelsClips = [1, 2, 3].map((n) => makeClip("PEXELS", `pex-${n}`));
    const pixabayClips = [1, 2, 3].map((n) => makeClip("PIXABAY", `pix-${n}`));
    const downloadClip = makeDownloader();
    const service = new FootageService(
      { PEXELS: fakeProvider(pexelsClips), PIXABAY: fakeProvider(pixabayClips) },
      downloadClip,
    );

    await service.collect(userId, videoId);

    const order = vi
      .mocked(downloadClip)
      .mock.calls.map(([clip]) => clip.source);
    expect(order).toEqual(["PEXELS", "PIXABAY", "PEXELS"]);
  });

  it("never uses the same externalId twice in one video, even across sources", async () => {
    await createVoiceOverFixture(1); // needs 3 clips
    // A coincidental id collision between the two sources — the dedup rule
    // must hold regardless of which source it comes from.
    const pexelsClips = [makeClip("PEXELS", "shared-1"), makeClip("PEXELS", "pex-2")];
    const pixabayClips = [makeClip("PIXABAY", "shared-1"), makeClip("PIXABAY", "pix-2")];
    const service = new FootageService(
      { PEXELS: fakeProvider(pexelsClips), PIXABAY: fakeProvider(pixabayClips) },
      makeDownloader(),
    );

    await service.collect(userId, videoId);

    const assets = await findClipAssets();
    const externalIds = assets.map((asset) => asset.externalId);
    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("is idempotent: re-running neither re-downloads nor duplicates assets", async () => {
    await createVoiceOverFixture(25); // 5 clips
    const pexelsClips = [1, 2, 3, 4, 5].map((n) => makeClip("PEXELS", `pex-${n}`));
    const pixabayClips = [1, 2, 3, 4, 5].map((n) => makeClip("PIXABAY", `pix-${n}`));
    const providers: FootageProviders = {
      PEXELS: fakeProvider(pexelsClips),
      PIXABAY: fakeProvider(pixabayClips),
    };
    const downloadClip = makeDownloader();
    const service = new FootageService(providers, downloadClip);

    const first = await service.collect(userId, videoId);
    expect(first.clipCount).toBe(5);

    vi.mocked(downloadClip).mockClear();
    vi.mocked(providers.PEXELS.search).mockClear();
    vi.mocked(providers.PIXABAY.search).mockClear();

    const second = await service.collect(userId, videoId);

    expect(second.clipCount).toBe(5);
    expect(downloadClip).not.toHaveBeenCalled();
    expect(providers.PEXELS.search).not.toHaveBeenCalled();
    expect(providers.PIXABAY.search).not.toHaveBeenCalled();

    const assets = await findClipAssets();
    expect(assets).toHaveLength(5);
  });

  it("tops up remaining clips on a re-run without re-downloading what's already stored", async () => {
    await createVoiceOverFixture(25); // 5 clips
    // First run: only Pexels has candidates, and only 3 of them — short of
    // the target of 5.
    const round1 = new FootageService(
      { PEXELS: fakeProvider([1, 2, 3].map((n) => makeClip("PEXELS", `pex-${n}`))), PIXABAY: fakeProvider([]) },
      makeDownloader(),
    );
    const first = await round1.collect(userId, videoId);
    expect(first.clipCount).toBe(3);

    // Second run: both sources now have candidates, including the same
    // Pexels ids already stored — those must be skipped, not re-downloaded.
    const pexelsRound2 = fakeProvider(
      [1, 2, 3, 4].map((n) => makeClip("PEXELS", `pex-${n}`)),
    );
    const pixabayRound2 = fakeProvider([1, 2].map((n) => makeClip("PIXABAY", `pix-${n}`)));
    const downloadClip2 = makeDownloader();
    const round2 = new FootageService(
      { PEXELS: pexelsRound2, PIXABAY: pixabayRound2 },
      downloadClip2,
    );

    const second = await round2.collect(userId, videoId);

    expect(second.clipCount).toBe(5);
    const downloadedIds = vi
      .mocked(downloadClip2)
      .mock.calls.map(([clip]) => clip.externalId);
    expect(downloadedIds).not.toContain("pex-1");
    expect(downloadedIds).not.toContain("pex-2");
    expect(downloadedIds).not.toContain("pex-3");

    const assets = await findClipAssets();
    expect(assets).toHaveLength(5);
    const externalIds = assets.map((asset) => asset.externalId);
    expect(new Set(externalIds).size).toBe(5);
  });

  it("collects from the surviving source when the other's search fails transiently", async () => {
    await createVoiceOverFixture(1); // needs 3 clips
    const pexelsClips = [1, 2, 3].map((n) => makeClip("PEXELS", `pex-${n}`));
    const providers: FootageProviders = {
      PEXELS: fakeProvider(pexelsClips),
      PIXABAY: {
        search: vi.fn(async () => {
          throw new ProviderError("PIXABAY", "Pixabay request failed with status 503.", true);
        }),
      },
    };
    const service = new FootageService(providers, makeDownloader());

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(3);
    expect(result.bySource.PEXELS).toBe(3);

    const assets = await findClipAssets();
    expect(assets).toHaveLength(3);
  });

  it("throws when every source's search fails", async () => {
    await createVoiceOverFixture(1);
    const providers: FootageProviders = {
      PEXELS: {
        search: vi.fn(async () => {
          throw new ProviderError("PEXELS", "PEXELS_API_KEY is not configured.", false);
        }),
      },
      PIXABAY: {
        search: vi.fn(async () => {
          throw new ProviderError("PIXABAY", "PIXABAY_API_KEY is not configured.", false);
        }),
      },
    };
    const service = new FootageService(providers, makeDownloader());

    await expect(service.collect(userId, videoId)).rejects.toBeInstanceOf(ProviderError);

    const assets = await findClipAssets();
    expect(assets).toHaveLength(0);
  });
});

describe("footageService.collect with anchored cues", () => {
  // Cue-aware stock footage double: every query except the sentinel
  // "__no_results__" returns a fixed pair of candidates — one clip whose id
  // is the same no matter which cue asked for it, followed by one clip whose
  // id is unique to that exact query. The shared first candidate is what
  // lets "never uses the same stock clip for two different cues" prove a
  // second cue walks past an already-claimed top result instead of taking it
  // anyway; the sentinel is what "falls back to the topic pool" uses to
  // force a cue past both per-cue tiers without needing a real "no results"
  // response from either provider.
  function cueAwareSearch(source: "PEXELS" | "PIXABAY") {
    return vi.fn(async (query: string): Promise<StockClip[]> => {
      if (query === "__no_results__") {
        return [];
      }
      return [makeClip(source, `${source}-shared`), makeClip(source, `${source}-${query}`)];
    });
  }

  let footageService: FootageService;
  let pexelsSearch: ReturnType<typeof cueAwareSearch>;
  let pixabaySearch: ReturnType<typeof cueAwareSearch>;
  let cueVideoIds: string[];

  beforeEach(() => {
    pexelsSearch = cueAwareSearch("PEXELS");
    pixabaySearch = cueAwareSearch("PIXABAY");
    footageService = new FootageService(
      { PEXELS: { search: pexelsSearch }, PIXABAY: { search: pixabaySearch } },
      makeDownloader(),
    );
    cueVideoIds = [];
  });

  afterEach(async () => {
    // Each test below builds its own Video (so its cues can differ from the
    // narration-only fixture the outer beforeEach sets up on the module-level
    // `videoId`), under the same throwaway user, so the outer afterEach's
    // user cascade removes the Video/Script/ScriptVersion/VoiceOver rows.
    // Asset rows still need sweeping by hand, same as findClipAssets()'s own
    // comment explains: Asset carries no FK back to Video.
    for (const id of cueVideoIds) {
      await prisma.asset.deleteMany({ where: { storagePath: { startsWith: `videos/${id}/` } } });
    }
  });

  /**
   * Builds a video whose active script version carries the given cues,
   * anchored against narration `content` assembled from those same cues —
   * each cue becomes its own section, `${anchor} <filler>`, joined in the
   * given order, so `content.indexOf` finds every anchor after the previous
   * one the way `anchorCues` requires. A voiceOver is created too, since
   * `collect` refuses a video with no narration regardless of cues.
   */
  async function makeVideoWithCues(cues: { anchor: string; cue: string }[]): Promise<string> {
    const video = await videoService.create(userId, {
      projectId,
      title: "Cue-anchored test video",
      topic: "inflation",
    });
    cueVideoIds.push(video.id);

    const content = cues
      .map((c) => `${c.anchor} — the rest of this section's narration follows here.`)
      .join(" ");

    const script = await prisma.script.create({ data: { videoId: video.id } });
    const version = await prisma.scriptVersion.create({
      data: { scriptId: script.id, version: 1, content, cues },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });

    await prisma.voiceOver.create({
      data: {
        videoId: video.id,
        provider: "ELEVENLABS",
        voiceId: "test-voice",
        durationSeconds: cues.length * 12,
      },
    });

    return video.id;
  }

  /** Exposes the two providers' recorded calls so a test can assert Pixabay
   * was never reached, without caring what either provider returned. */
  function trackProviderCalls() {
    return {
      pexelsCalls: () => pexelsSearch.mock.calls,
      pixabayCalls: () => pixabaySearch.mock.calls,
    };
  }

  it("stores one clip per cue, named in play order", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "Inflation is not prices going", cue: "supermarket shelves" },
      { anchor: "It is money losing value", cue: "printing press" },
    ]);

    await footageService.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
      orderBy: { storagePath: "asc" },
    });

    expect(assets.map((a) => a.storagePath)).toEqual([
      `videos/${videoId}/clips/section-000.mp4`,
      `videos/${videoId}/clips/section-001.mp4`,
    ]);
  });

  it("never uses the same stock clip for two different cues", async () => {
    // Both cues' searches return the SAME clip first. The second must take
    // its next-best result rather than repeating the picture.
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
      { anchor: "second section opening words here", cue: "cash" },
    ]);

    await footageService.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    const externalIds = assets.map((a) => a.externalId);

    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("falls back to the topic pool for a cue that finds nothing", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "__no_results__" },
    ]);

    await footageService.collect(userId, videoId);

    // A section with no match still gets a picture; a black screen is worse
    // than a loosely-related clip.
    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets).toHaveLength(1);
  });

  it("searches Pixabay only when Pexels returns nothing for a cue", async () => {
    const { pexelsCalls, pixabayCalls } = trackProviderCalls();
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
    ]);

    await footageService.collect(userId, videoId);

    // Pexels allows 200 searches an hour; querying both per cue would
    // exhaust it in two videos.
    expect(pexelsCalls().length).toBeGreaterThan(0);
    expect(pixabayCalls()).toHaveLength(0);
  });

  it("still collects the topic-level pool for a video with no cues at all", async () => {
    // Guards the other direction: a video whose script predates this feature
    // (cues === null) must not accidentally fall into the per-cue path and
    // come away with zero clips.
    await createVoiceOverFixture(25); // ceil(25/12) + 2 = 5
    const providers: FootageProviders = {
      PEXELS: fakeProvider([1, 2, 3, 4, 5].map((n) => makeClip("PEXELS", `pex-${n}`))),
      PIXABAY: fakeProvider([1, 2, 3, 4, 5].map((n) => makeClip("PIXABAY", `pix-${n}`))),
    };
    const service = new FootageService(providers, makeDownloader());

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(5);
    const assets = await findClipAssets();
    expect(assets).toHaveLength(5);
  });
});
