import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { MusicService } from "@/services/music.service";
import type { MusicTrack } from "@/services/providers/types";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts). An Asset carries no videoId column — it is scoped by its
// `videos/{videoId}/` storage prefix, the same convention render.service.ts
// queries by — so a throwaway uuid is a sufficient tenant here and no Video
// row is needed. Jamendo is never contacted: the provider is injected, the
// same shape VoiceOverService uses for its own.
vi.setConfig({ testTimeout: 15_000 });

const ORIGINAL_FETCH = global.fetch;

const track: MusicTrack = {
  externalId: "1",
  url: "https://example.test/1.mp3",
  title: "Test Track",
  artistName: "Artist",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
  durationSeconds: 180,
};

/**
 * Answers the track download and passes everything else to the real `fetch`.
 *
 * Replacing `global.fetch` outright is not an option here: the Supabase
 * storage client uses `fetch` internally, so a blanket stub makes `putObject`
 * receive the fake audio response and fail with "result.json is not a
 * function" — a test artefact that looks exactly like a bug in the service.
 */
function stubTrackDownload(response: Partial<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input.toString().startsWith("https://example.test/")) {
      return response as Response;
    }
    return ORIGINAL_FETCH(input, init);
  });

  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

const downloadedAudio = {
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode("audio").buffer,
};

let videoId: string;

beforeEach(() => {
  videoId = randomUUID();
});

afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  await prisma.asset.deleteMany({
    where: { storagePath: { startsWith: `videos/${videoId}/` } },
  });
});

describe("MusicService.collect", () => {
  it("returns null rather than throwing when the provider fails", async () => {
    const service = new MusicService({
      search: async () => {
        throw new ProviderError("JAMENDO", "down", true);
      },
    });

    // Music is an enhancement to a video that is already publishable. A
    // Jamendo outage must not turn a renderable video into a failed one.
    expect(await service.collect(videoId, "calm ambient")).toBeNull();
  });

  it("returns null when the search finds nothing usable", async () => {
    const service = new MusicService({ search: async () => [] });
    expect(await service.collect(videoId, "calm ambient")).toBeNull();
  });

  it("returns null when the download fails, leaving no asset behind", async () => {
    stubTrackDownload({ ok: false, status: 404 });
    const service = new MusicService({ search: async () => [track] });

    expect(await service.collect(videoId, "calm ambient")).toBeNull();
    expect(
      await prisma.asset.count({
        where: { storagePath: { startsWith: `videos/${videoId}/` } },
      }),
    ).toBe(0);
  });

  it("stores the credit so publishing needs no second Jamendo call", async () => {
    stubTrackDownload(downloadedAudio);
    const service = new MusicService({ search: async () => [track] });

    await service.collect(videoId, "calm ambient");
    const asset = await prisma.asset.findFirst({
      where: { kind: "MUSIC", storagePath: { startsWith: `videos/${videoId}/` } },
      select: { prompt: true, provider: true, externalId: true },
    });

    expect(asset?.provider).toBe("JAMENDO");
    expect(asset?.externalId).toBe("1");
    expect(asset?.prompt).toContain("Artist");
  });

  it("reuses the stored track instead of fetching twice", async () => {
    stubTrackDownload(downloadedAudio);
    const search = vi.fn().mockResolvedValue([track]);
    const service = new MusicService({ search });

    const first = await service.collect(videoId, "calm ambient");
    const second = await service.collect(videoId, "calm ambient");

    // A re-render must not silently swap the music under a video the operator
    // has already watched and approved.
    expect(second).toBe(first);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
