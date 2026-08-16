import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { findArtStyle } from "@/lib/art-styles";
import { putObject, storagePath } from "@/lib/storage";
import type { ClipDownloader, FootageProviders } from "@/services/footage.service";
import { FootageService } from "@/services/footage.service";
import { projectService } from "@/services/project.service";
import type {
  ImageGenerationInput,
  ImageProvider,
  StockClip,
  StockFootageProvider,
} from "@/services/providers/types";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database and the real storage root (see
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

/**
 * The two slots a live-action channel actually searches. Every test in this
 * file below the cartoon block runs against a video whose project has no
 * channel, which resolves to LIVE_ACTION — so `PIXABAY_CARTOON` is never
 * reached and deliberately not injected. Naming the pair rather than using
 * `Partial<FootageProviders>` keeps `providers.PEXELS.search` non-optional at
 * the assertion sites.
 */
type LiveActionProviders = Pick<FootageProviders, "PEXELS" | "PIXABAY">;

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
    const providers: LiveActionProviders = { PEXELS: fakeProvider([]), PIXABAY: fakeProvider([]) };
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
    const providers: LiveActionProviders = {
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
    const providers: LiveActionProviders = {
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
    const providers: LiveActionProviders = {
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
  let downloadClip: ClipDownloader;
  let cueVideoIds: string[];

  beforeEach(() => {
    pexelsSearch = cueAwareSearch("PEXELS");
    pixabaySearch = cueAwareSearch("PIXABAY");
    downloadClip = makeDownloader();
    footageService = new FootageService(
      { PEXELS: { search: pexelsSearch }, PIXABAY: { search: pixabaySearch } },
      downloadClip,
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
   *
   * `topic` defaults to "inflation", which `cueAwareSearch` treats as any
   * other non-sentinel query (two real candidates back) — override it to
   * "__no_results__" when a test needs the topic-level fallback pool itself
   * to come up empty.
   */
  async function makeVideoWithCues(
    cues: { anchor: string; cue: string }[],
    options?: { topic?: string },
  ): Promise<string> {
    const video = await videoService.create(userId, {
      projectId,
      title: "Cue-anchored test video",
      topic: options?.topic ?? "inflation",
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
    const providers: LiveActionProviders = {
      PEXELS: fakeProvider([1, 2, 3, 4, 5].map((n) => makeClip("PEXELS", `pex-${n}`))),
      PIXABAY: fakeProvider([1, 2, 3, 4, 5].map((n) => makeClip("PIXABAY", `pix-${n}`))),
    };
    const service = new FootageService(providers, makeDownloader());

    const result = await service.collect(userId, videoId);

    expect(result.clipCount).toBe(5);
    const assets = await findClipAssets();
    expect(assets).toHaveLength(5);
  });

  it(
    "caps unique downloads per video and reuses the nearest section's clip beyond the cap",
    async () => {
      // 25 cues, each with a distinct query, comfortably clears
      // footage.service.ts's MAX_UNIQUE_SECTION_CLIPS (20) — the same
      // incident MAX_UNIQUE_CLIPS already guards on the topic-level path
      // (see that constant's comment), reachable here too because a real
      // script produces roughly one cue every 20-25 words.
      const cueCount = 25;
      const cap = 20;
      const cues = Array.from({ length: cueCount }, (_, i) => ({
        anchor: `Section number ${i} opens with these exact words`,
        cue: `topic-${i}`,
      }));
      const videoId = await makeVideoWithCues(cues);

      await footageService.collect(userId, videoId);

      const assets = await prisma.asset.findMany({
        where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
        orderBy: { storagePath: "asc" },
      });

      // Every section still gets a clip — numbering stays dense past the cap.
      expect(assets.map((a) => a.storagePath)).toEqual(
        Array.from(
          { length: cueCount },
          (_, i) => `videos/${videoId}/clips/section-${String(i).padStart(3, "0")}.mp4`,
        ),
      );

      // But only `cap` of those are genuinely distinct clips...
      const uniqueExternalIds = new Set(assets.map((a) => a.externalId));
      expect(uniqueExternalIds.size).toBe(cap);

      // ...because collection stopped downloading new ones once the cap was
      // hit, reusing an already-collected section's clip for the rest
      // instead of the unbounded per-section fetch this cap exists to
      // prevent.
      expect(downloadClip).toHaveBeenCalledTimes(cap);
    },
    30_000,
  );

  it("searches the topic pool once and shares it across every section that needs it", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "__no_results__" },
      { anchor: "second section opening words here", cue: "__no_results__" },
    ]);

    await footageService.collect(userId, videoId);

    // Both sections fall through their own search and Pixabay to the
    // shared topic pool (query = the video's topic, "inflation"), but that
    // pool must be searched only once, not once per needy section.
    const topicSearches = pexelsSearch.mock.calls.filter(([q]) => q === "inflation");
    expect(topicSearches).toHaveLength(1);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets).toHaveLength(2);

    // The pool has more than one candidate, so the two sections that shared
    // it still don't end up with the same picture.
    const externalIds = assets.map((a) => a.externalId);
    expect(new Set(externalIds).size).toBe(2);
  });

  it("reuses a sibling section's clip, keeping numbering dense, when the topic pool itself is dry", async () => {
    const videoId = await makeVideoWithCues(
      [
        { anchor: "first section opening words here", cue: "money" },
        { anchor: "second section opening words here", cue: "__no_results__" },
      ],
      { topic: "__no_results__" },
    );

    await footageService.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
      orderBy: { storagePath: "asc" },
    });

    // Section 1's own search, Pixabay, and the (dry) topic pool all come up
    // empty, but section 0 already has a clip — dense numbering wins over a
    // gap, so section 1 reuses it rather than being skipped.
    expect(assets.map((a) => a.storagePath)).toEqual([
      `videos/${videoId}/clips/section-000.mp4`,
      `videos/${videoId}/clips/section-001.mp4`,
    ]);
    expect(assets[1].externalId).toBe(assets[0].externalId);
  });

  it("leaves a genuine gap, without crashing, when nothing is available anywhere for a section", async () => {
    // Nothing to reuse either: this is the one video-wide case where every
    // tier — the cue's own search, Pixabay, and the topic pool — comes back
    // empty for every section, so there is no sibling clip to borrow from.
    const videoId = await makeVideoWithCues(
      [{ anchor: "first section opening words here", cue: "__no_results__" }],
      { topic: "__no_results__" },
    );

    await expect(footageService.collect(userId, videoId)).resolves.toBeDefined();

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets).toHaveLength(0);
  });

  it("degrades to the next tier, rather than aborting the video, when a per-cue provider throws", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
    ]);

    // Pexels fails outright for this cue (a transient 503, say) instead of
    // just returning no results — searchOrEmpty must absorb that the same
    // way it absorbs an empty result, falling through to Pixabay rather
    // than failing the whole collect() call over one section's bad luck.
    const throwingPexels: StockFootageProvider = {
      search: vi.fn(async () => {
        throw new ProviderError("PEXELS", "Pexels request failed with status 503.", true);
      }),
    };
    const rescueClip = makeClip("PIXABAY", "pix-rescue");
    const workingPixabay: StockFootageProvider = {
      search: vi.fn(async () => [rescueClip]),
    };
    const service = new FootageService(
      { PEXELS: throwingPexels, PIXABAY: workingPixabay },
      makeDownloader(),
    );

    await expect(service.collect(userId, videoId)).resolves.toBeDefined();

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].externalId).toBe("pix-rescue");
    expect(assets[0].provider).toBe("PIXABAY");
  });
});

// ---------------------------------------------------------------------------
// Per-channel footage style
//
// The pipeline never asks for a style — `collect()` reads it off the video's
// own channel, so these tests set it where the operator sets it (the brand
// row) and then call `collect()` exactly as pipeline-runner.ts does.
// ---------------------------------------------------------------------------

describe("footageService.collect for a cartoon channel", () => {
  let cartoonVideoIds: string[];

  beforeEach(() => {
    cartoonVideoIds = [];
  });

  afterEach(async () => {
    // Same reason as the cue block's own afterEach: Asset carries no FK back
    // to Video, so the user cascade cannot reach these rows.
    for (const id of cartoonVideoIds) {
      await prisma.asset.deleteMany({ where: { storagePath: { startsWith: `videos/${id}/` } } });
    }
  });

  /**
   * A video whose project points at a channel branded with `footageStyle`.
   * Its own project, not the module-level one, so a cartoon channel in one
   * test can't change what a live-action test in the same file collects.
   */
  async function makeStyledVideo(
    footageStyle: "LIVE_ACTION" | "CARTOON",
    /** Section cues, when the test needs the per-cue path rather than the
     *  topic-level one. A real generated script always has these, so this is
     *  the path a kids video actually takes in production. */
    cues?: { anchor: string; cue: string }[],
  ): Promise<string> {
    const channel = await prisma.channel.create({
      data: {
        userId,
        youtubeChannelId: `UC-footage-${randomUUID()}`,
        title: "Test cartoon channel",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await prisma.channelBrand.create({ data: { channelId: channel.id, footageStyle } });

    const project = await projectService.create(userId, {
      name: `test-footage-style-${randomUUID().slice(0, 8)}`,
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { channelId: channel.id },
    });

    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "Counting with dinosaurs",
      topic: "friendly dinosaur teaching numbers",
    });
    cartoonVideoIds.push(video.id);

    if (cues?.length) {
      // Same section shape as `makeVideoWithCues` above: each cue's anchor
      // opens its own sentence, so `anchorCues` finds every one of them in
      // order against the joined narration.
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
    }

    await prisma.voiceOver.create({
      data: {
        videoId: video.id,
        provider: "ELEVENLABS",
        voiceId: "test-voice",
        durationSeconds: 24,
      },
    });

    return video.id;
  }

  it("keeps a cued kids video on cartoon footage for every section, including the topic fallback", async () => {
    // The production path: a generated script has cues, so `collectPerCue`
    // runs. Section 1's own cue finds nothing, which is exactly the moment a
    // live-action clip could slip in — it must reach the cartoon topic pool
    // instead, never Pexels.
    const videoId = await makeStyledVideo("CARTOON", [
      { anchor: "Meet Rex the dinosaur", cue: "friendly dinosaur waving" },
      { anchor: "Rex can count to three", cue: "__no_results__" },
    ]);

    const pexels = fakeProvider([makeClip("PEXELS", "pex-live-action")]);
    const pixabay = fakeProvider([makeClip("PIXABAY", "pix-live-action")]);
    const cartoon: StockFootageProvider = {
      search: vi.fn(async (query: string) =>
        query === "__no_results__"
          ? []
          : [makeClip("PIXABAY", `pix-cartoon-${query.replace(/\W+/g, "-")}`)],
      ),
    };

    const service = new FootageService(
      { PEXELS: pexels, PIXABAY: pixabay, PIXABAY_CARTOON: cartoon },
      makeDownloader(),
    );

    await service.collect(userId, videoId);

    expect(pexels.search).not.toHaveBeenCalled();
    expect(pixabay.search).not.toHaveBeenCalled();

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
      orderBy: { storagePath: "asc" },
    });

    expect(assets.map((a) => a.storagePath)).toEqual([
      `videos/${videoId}/clips/section-000.mp4`,
      `videos/${videoId}/clips/section-001.mp4`,
    ]);
    expect(assets.every((a) => a.provider === "PIXABAY")).toBe(true);
    expect(assets.every((a) => a.externalId?.startsWith("pix-cartoon"))).toBe(true);
  });

  it("searches only the cartoon provider — never Pexels, never unfiltered Pixabay", async () => {
    const videoId = await makeStyledVideo("CARTOON");

    const pexels = fakeProvider([makeClip("PEXELS", "pex-live-action")]);
    const pixabay = fakeProvider([makeClip("PIXABAY", "pix-live-action")]);
    const cartoon = fakeProvider([
      makeClip("PIXABAY", "pix-cartoon-1"),
      makeClip("PIXABAY", "pix-cartoon-2"),
      makeClip("PIXABAY", "pix-cartoon-3"),
      makeClip("PIXABAY", "pix-cartoon-4"),
    ]);

    const service = new FootageService(
      { PEXELS: pexels, PIXABAY: pixabay, PIXABAY_CARTOON: cartoon },
      makeDownloader(),
    );

    await service.collect(userId, videoId);

    expect(cartoon.search).toHaveBeenCalled();
    // The two live-action slots are not merely deprioritised — they are not
    // in this channel's plan at all, so nothing can reach them.
    expect(pexels.search).not.toHaveBeenCalled();
    expect(pixabay.search).not.toHaveBeenCalled();

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.map((a) => a.externalId).every((id) => id?.startsWith("pix-cartoon"))).toBe(
      true,
    );
  });

  /**
   * The whole point of the feature: a children's video that cannot find a
   * cartoon must come back short, not come back with live action in it.
   */
  it("collects nothing rather than substituting live action when the cartoon search is empty", async () => {
    const videoId = await makeStyledVideo("CARTOON");

    const pexels = fakeProvider([makeClip("PEXELS", "pex-live-action")]);
    const pixabay = fakeProvider([makeClip("PIXABAY", "pix-live-action")]);
    const service = new FootageService(
      { PEXELS: pexels, PIXABAY: pixabay, PIXABAY_CARTOON: fakeProvider([]) },
      makeDownloader(),
    );

    const messages: string[] = [];
    const result = await service.collect(userId, videoId, (line) => messages.push(line));

    expect(result.clipCount).toBe(0);
    expect(await prisma.asset.count({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    })).toBe(0);
    expect(pexels.search).not.toHaveBeenCalled();
    expect(pixabay.search).not.toHaveBeenCalled();

    // And it says which providers it looked at, so "three clips" on a kids
    // video reads as a thin animation library rather than a broken stage.
    expect(messages.some((line) => line.includes("footage style CARTOON"))).toBe(true);
  });

  it("records the source on every stored clip, so the description's credit is derived and not assumed", async () => {
    const videoId = await makeStyledVideo("CARTOON");

    const service = new FootageService(
      {
        PIXABAY_CARTOON: fakeProvider([
          makeClip("PIXABAY", "pix-cartoon-1"),
          makeClip("PIXABAY", "pix-cartoon-2"),
          makeClip("PIXABAY", "pix-cartoon-3"),
          makeClip("PIXABAY", "pix-cartoon-4"),
        ]),
      },
      makeDownloader(),
    );

    const result = await service.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });

    // `PIXABAY`, not a new provider value. Cartoon clips come from the same
    // Pixabay account under the same licence, so the credit publish.service.ts
    // already writes ("Video clips courtesy of Pixabay") is the correct one
    // and needs no new branch — the attribution is still derived from what
    // the render actually used, which is the property that matters.
    expect(assets.every((a) => a.provider === "PIXABAY")).toBe(true);
    expect(assets.every((a) => a.externalId !== null)).toBe(true);
    expect(result.bySource).toEqual({ PIXABAY: assets.length });
  });

  it("leaves a live-action channel searching both providers exactly as before", async () => {
    const videoId = await makeStyledVideo("LIVE_ACTION");

    const pexels = fakeProvider([makeClip("PEXELS", "pex-1"), makeClip("PEXELS", "pex-2")]);
    const pixabay = fakeProvider([makeClip("PIXABAY", "pix-1"), makeClip("PIXABAY", "pix-2")]);
    const cartoon = fakeProvider([makeClip("PIXABAY", "pix-cartoon-1")]);

    const service = new FootageService(
      { PEXELS: pexels, PIXABAY: pixabay, PIXABAY_CARTOON: cartoon },
      makeDownloader(),
    );

    await service.collect(userId, videoId);

    expect(pexels.search).toHaveBeenCalled();
    expect(pixabay.search).toHaveBeenCalled();
    expect(cartoon.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Illustrated channels: the pictures are generated, not searched for.
// ---------------------------------------------------------------------------

describe("footageService.collect for an illustrated channel", () => {
  let illustratedVideoIds: string[];

  beforeEach(() => {
    illustratedVideoIds = [];
  });

  afterEach(async () => {
    // Asset carries no FK back to Video, so the user cascade cannot reach
    // these rows — same reason the two blocks above clean up by prefix.
    for (const id of illustratedVideoIds) {
      await prisma.asset.deleteMany({ where: { storagePath: { startsWith: `videos/${id}/` } } });
    }
  });

  const SHEET_BYTES = Buffer.from("fake-character-sheet-png");

  /** An image provider that never touches the network, records what it was
   *  asked for, and can be told to refuse specific calls. */
  function fakeImages(options: { failOn?: number[] } = {}): ImageProvider & {
    calls: ImageGenerationInput[];
  } {
    const calls: ImageGenerationInput[] = [];
    const failOn = new Set(options.failOn ?? []);

    return {
      calls,
      generate: vi.fn(async (input: ImageGenerationInput) => {
        const index = calls.length;
        calls.push(input);

        if (failOn.has(index)) {
          // The shape a real refusal arrives in — see `GatewayImageProvider`.
          throw new ProviderError("GATEWAY", "Your request was rejected.", false);
        }

        return {
          data: Buffer.from(`fake-illustration-${index}`),
          model: "openai/gpt-image-2",
          costUsd: 0.047,
        };
      }),
    };
  }

  /**
   * A video on a channel branded ILLUSTRATED, with `cueCount` sections and a
   * narration of `durationSeconds`.
   *
   * Its own channel and project rather than the module-level ones, so an
   * illustrated channel in one test cannot change what another test collects.
   */
  async function makeIllustratedVideo(options: {
    cueCount: number;
    durationSeconds: number;
    characterBrief?: string | null;
    artStyle?: string | null;
    withSheet?: boolean;
    format?: "LANDSCAPE" | "VERTICAL";
    ownerId?: string;
  }): Promise<{ videoId: string; channelId: string; sheetPath: string | null }> {
    const owner = options.ownerId ?? userId;

    const channel = await prisma.channel.create({
      data: {
        userId: owner,
        youtubeChannelId: `UC-illus-${randomUUID()}`,
        title: "Test illustrated channel",
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      },
    });

    let sheetPath: string | null = null;
    if (options.withSheet !== false) {
      sheetPath = storagePath(channel.id, "characters", `sheet-${randomUUID().slice(0, 8)}.png`);
      await putObject(sheetPath, SHEET_BYTES, "image/png");
    }

    await prisma.channelBrand.create({
      data: {
        channelId: channel.id,
        footageStyle: "ILLUSTRATED",
        characterBrief:
          options.characterBrief === undefined
            ? "Pip, a small round brown bear cub in a red knitted scarf."
            : options.characterBrief,
        characterSheetPath: sheetPath,
        artStyle: options.artStyle === undefined ? "storybook-watercolour" : options.artStyle,
        tone: "warm and gentle",
      },
    });

    const project = await projectService.create(owner, {
      name: `test-illustrated-${randomUUID().slice(0, 8)}`,
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { channelId: channel.id },
    });

    const video = await videoService.create(owner, {
      projectId: project.id,
      title: "Pip and the moonlit meadow",
      topic: "a bear cub who cannot sleep",
    });
    illustratedVideoIds.push(video.id);

    if (options.format) {
      await prisma.video.update({
        where: { id: video.id },
        data: { format: options.format },
      });
    }

    // Same section shape as the blocks above: each cue's anchor opens its own
    // sentence, so `anchorCues` finds every one in order.
    const cues = Array.from({ length: options.cueCount }, (_, index) => ({
      anchor: `Section number ${index} opens here`,
      cue: `scene ${index}`,
    }));
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
        durationSeconds: options.durationSeconds,
      },
    });

    return { videoId: video.id, channelId: channel.id, sheetPath };
  }

  function beatAssets(videoId: string) {
    return prisma.asset.findMany({
      where: { kind: "IMAGE", storagePath: { startsWith: `videos/${videoId}/beats/` } },
      orderBy: { storagePath: "asc" },
    });
  }

  it("draws one picture per story beat, not one per section", async () => {
    // The whole reason the feature exists in this shape. Twenty-seven sections
    // across four minutes is what a real script produces; twenty-seven
    // illustrations is not what this genre does, and `planStoryBeats` says
    // twelve. Also asserts nothing is searched for — an illustrated channel
    // has no stock provider in its plan at all.
    const pexels = fakeProvider([makeClip("PEXELS", "pex-1")]);
    const pixabay = fakeProvider([makeClip("PIXABAY", "pix-1")]);
    const cartoon = fakeProvider([makeClip("PIXABAY", "pix-cartoon-1")]);
    const images = fakeImages();

    const { videoId } = await makeIllustratedVideo({ cueCount: 27, durationSeconds: 240 });

    const result = await new FootageService(
      { PEXELS: pexels, PIXABAY: pixabay, PIXABAY_CARTOON: cartoon },
      makeDownloader(),
      images,
    ).collect(userId, videoId);

    expect(images.calls).toHaveLength(12);
    expect(result.clipCount).toBe(12);
    expect(result.missingBeats).toEqual([]);

    const assets = await beatAssets(videoId);
    expect(assets.map((a) => a.storagePath)).toEqual(
      Array.from({ length: 12 }, (_, i) => `videos/${videoId}/beats/beat-${String(i).padStart(3, "0")}.png`),
    );
    expect(assets.every((a) => a.provider === "OPENAI")).toBe(true);

    expect(pexels.search).not.toHaveBeenCalled();
    expect(pixabay.search).not.toHaveBeenCalled();
    expect(cartoon.search).not.toHaveBeenCalled();
  });

  it("puts the character sheet into every scene, which is the point of having one", async () => {
    // Without this every picture invents a different protagonist, which is the
    // exact failure the whole feature exists to avoid — and it is invisible in
    // any test that only counts images.
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({ cueCount: 12, durationSeconds: 120 });

    await new FootageService({}, makeDownloader(), images).collect(userId, videoId);

    expect(images.calls.length).toBeGreaterThan(1);
    for (const call of images.calls) {
      expect(call.referenceImages).toHaveLength(1);
      expect(Buffer.from(call.referenceImages![0])).toEqual(SHEET_BYTES);
      // And the brief travels as text alongside it, because the reference
      // carries appearance but not the character's name or manner.
      expect(call.prompt).toContain("Pip, a small round brown bear cub");
      expect(call.prompt).toContain("reference sheet");
      // And so does the channel's art style, verbatim — the sheet was drawn
      // in it and a scene asked for in a different one is a fight the model
      // resolves differently every time.
      expect(call.prompt).toContain(findArtStyle("storybook-watercolour")!.prompt);
    }
  });

  it("gives each beat its own sections' cues, so consecutive pictures differ", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({ cueCount: 12, durationSeconds: 120 });

    await new FootageService({}, makeDownloader(), images).collect(userId, videoId);

    const scenes = images.calls.map((call) => call.prompt);
    expect(new Set(scenes).size).toBe(scenes.length);
    // Every section's cue reaches some beat — no section's words go undrawn.
    for (let index = 0; index < 12; index += 1) {
      expect(scenes.some((prompt) => prompt.includes(`scene ${index}`))).toBe(true);
    }
  });

  it("says which beat has no picture rather than silently leaving a gap", async () => {
    // A refusal is not the same event as a stock search coming back empty:
    // nothing can be substituted for it, the render will refuse, and the
    // operator needs to know which beat before deciding what to do.
    const images = fakeImages({ failOn: [1, 3] });
    const { videoId } = await makeIllustratedVideo({ cueCount: 12, durationSeconds: 120 });

    const lines: string[] = [];
    const result = await new FootageService({}, makeDownloader(), images).collect(
      userId,
      videoId,
      (line) => lines.push(line),
    );

    expect(result.missingBeats).toEqual([2, 4]);
    // The other beats were still drawn and still stored — one refusal must not
    // throw away the pictures already paid for.
    expect((await beatAssets(videoId)).map((a) => a.storagePath)).toEqual([
      `videos/${videoId}/beats/beat-000.png`,
      `videos/${videoId}/beats/beat-002.png`,
      `videos/${videoId}/beats/beat-004.png`,
      `videos/${videoId}/beats/beat-005.png`,
    ]);

    expect(lines.some((line) => line.includes("NO PICTURE") && line.includes("beat 2/6"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("no picture: 2, 4"))).toBe(true);
  });

  it("redraws only the beats that have none when collected again", async () => {
    // What makes a partial failure cost the price of the beats that failed
    // rather than the whole video again — and it only works because
    // `planStoryBeats` is deterministic.
    const first = fakeImages({ failOn: [1] });
    const { videoId } = await makeIllustratedVideo({ cueCount: 12, durationSeconds: 120 });

    await new FootageService({}, makeDownloader(), first).collect(userId, videoId);
    expect(first.calls).toHaveLength(6);

    const second = fakeImages();
    const result = await new FootageService({}, makeDownloader(), second).collect(
      userId,
      videoId,
    );

    expect(second.calls).toHaveLength(1);
    expect(result.missingBeats).toEqual([]);
    expect(result.clipCount).toBe(6);
    expect(await beatAssets(videoId)).toHaveLength(6);
  });

  it("reports what it actually spent, from the provider's own token counts", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({ cueCount: 12, durationSeconds: 120 });

    const result = await new FootageService({}, makeDownloader(), images).collect(
      userId,
      videoId,
    );

    expect(result.costUsd).toBeCloseTo(6 * 0.047, 6);
  });

  it("asks for a portrait picture for a vertical video and a landscape one otherwise", async () => {
    const portrait = fakeImages();
    const { videoId: verticalId } = await makeIllustratedVideo({
      cueCount: 6,
      durationSeconds: 60,
      format: "VERTICAL",
    });
    await new FootageService({}, makeDownloader(), portrait).collect(userId, verticalId);
    expect(portrait.calls.every((call) => call.size === "1024x1536")).toBe(true);

    const landscape = fakeImages();
    const { videoId: landscapeId } = await makeIllustratedVideo({
      cueCount: 6,
      durationSeconds: 60,
    });
    await new FootageService({}, makeDownloader(), landscape).collect(userId, landscapeId);
    expect(landscape.calls.every((call) => call.size === "1536x1024")).toBe(true);
  });

  it("draws every beat in the channel's chosen style, not a default one", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({
      cueCount: 12,
      durationSeconds: 120,
      artStyle: "gouache-night",
    });

    await new FootageService({}, makeDownloader(), images).collect(userId, videoId);

    expect(images.calls.length).toBeGreaterThan(0);
    for (const call of images.calls) {
      expect(call.prompt).toContain(findArtStyle("gouache-night")!.prompt);
      expect(call.prompt).not.toContain(findArtStyle("flat-vector")!.prompt);
    }
  });

  it("refuses before spending anything when no art style is chosen", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({
      cueCount: 12,
      durationSeconds: 120,
      artStyle: null,
    });

    await expect(
      new FootageService({}, makeDownloader(), images).collect(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.calls).toHaveLength(0);
  });

  it("refuses before spending anything when the channel has no character sheet", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({
      cueCount: 12,
      durationSeconds: 120,
      withSheet: false,
    });

    await expect(
      new FootageService({}, makeDownloader(), images).collect(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.calls).toHaveLength(0);
    expect(await beatAssets(videoId)).toHaveLength(0);
  });

  it("refuses before spending anything when nobody has described the character", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({
      cueCount: 12,
      durationSeconds: 120,
      characterBrief: null,
    });

    await expect(
      new FootageService({}, makeDownloader(), images).collect(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.calls).toHaveLength(0);
  });

  it("never draws for another operator's video", async () => {
    // Every query in this service is scoped to the signed-in operator, and the
    // scoping has to hold on the path that spends money as much as on the ones
    // that do not. A foreign video is not found at all — no brand is read, no
    // character sheet is fetched, nothing is generated.
    const otherUserId = await createTestUser("test-illustrated-other");
    const images = fakeImages();

    try {
      const { videoId } = await makeIllustratedVideo({
        cueCount: 12,
        durationSeconds: 120,
        ownerId: otherUserId,
      });

      await expect(
        new FootageService({}, makeDownloader(), images).collect(userId, videoId),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(images.calls).toHaveLength(0);
      expect(await beatAssets(videoId)).toHaveLength(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("refuses a script with no cues rather than drawing one picture for the whole video", async () => {
    const images = fakeImages();
    const { videoId } = await makeIllustratedVideo({ cueCount: 0, durationSeconds: 120 });

    await expect(
      new FootageService({}, makeDownloader(), images).collect(userId, videoId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.calls).toHaveLength(0);
  });
});
