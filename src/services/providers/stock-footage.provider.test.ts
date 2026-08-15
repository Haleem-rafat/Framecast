import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors";
import {
  PexelsProvider,
  PixabayProvider,
  pixabayCartoonProvider,
} from "@/services/providers/stock-footage.provider";

// Both providers read a real API key off `env` at call time (loaded from
// .env.local by src/test/setup.ts) so they never hit the "not configured"
// guard — but `fetch` itself is stubbed for every test below, so neither
// Pexels nor Pixabay is ever actually contacted. Matches the network-free
// convention footage.service.test.ts already established for this pipeline
// stage, just one layer lower: this file exercises the duration/size
// filtering the providers themselves are responsible for.

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as Response;
}

/** A fake `HEAD` response, matching the shape `fetchContentLength` reads:
 * `response.ok` and `response.headers.get("content-length")`. */
function headResponse(contentLengthBytes: number | null): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && contentLengthBytes !== null
          ? String(contentLengthBytes)
          : null,
    },
  } as unknown as Response;
}

function pexelsVideo(id: number, durationSeconds: number) {
  return {
    id,
    duration: durationSeconds,
    video_files: [
      {
        file_type: "video/mp4",
        width: 1920,
        height: 1080,
        link: `https://cdn.pexels.invalid/${id}.mp4`,
      },
    ],
  };
}

describe("PexelsProvider.search", () => {
  it("overfetches per_page, drops clips outside the duration band before ever issuing a HEAD, and drops oversized ones after", async () => {
    const searchUrls: string[] = [];
    const headUrls: string[] = [];

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "HEAD") {
        headUrls.push(url);
        if (url.endsWith("/2.mp4")) return headResponse(35 * 1024 * 1024); // under the 40MB cap
        if (url.endsWith("/3.mp4")) return headResponse(45 * 1024 * 1024); // over the cap
        return headResponse(null);
      }
      searchUrls.push(url);
      return jsonResponse({
        videos: [
          pexelsVideo(1, 3), // too short (< 6s) — must never reach the HEAD step
          pexelsVideo(2, 15), // in band, under size cap — kept
          pexelsVideo(3, 15), // in band, over size cap — dropped
          pexelsVideo(4, 40), // too long (> 30s) — must never reach the HEAD step
        ],
      });
    }) as unknown as typeof fetch;

    const clips = await new PexelsProvider().search("skyline", 5);

    expect(clips.map((c) => c.externalId)).toEqual(["2"]);
    // count=5, OVERFETCH_FACTOR=3 -> per_page=15.
    expect(searchUrls[0]).toContain("per_page=15");
    // Only the two in-band candidates (2, 3) triggered a size check — the
    // out-of-band ones (1, 4) were filtered before ever costing a round trip.
    expect(headUrls).toHaveLength(2);
    expect(headUrls.some((u) => u.endsWith("/1.mp4"))).toBe(false);
    expect(headUrls.some((u) => u.endsWith("/4.mp4"))).toBe(false);
  });

  it("fails closed — drops a clip whose HEAD response has no content-length", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return headResponse(null);
      return jsonResponse({ videos: [pexelsVideo(1, 15)] });
    }) as unknown as typeof fetch;

    const clips = await new PexelsProvider().search("skyline", 1);

    expect(clips).toEqual([]);
  });

  it("clamps per_page to Pexels' hard max of 80 even after overfetching", async () => {
    const searchUrls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return headResponse(1024);
      searchUrls.push(input.toString());
      return jsonResponse({ videos: [] });
    }) as unknown as typeof fetch;

    await new PexelsProvider().search("skyline", 50); // 50*3=150, clamps to 80

    expect(searchUrls[0]).toContain("per_page=80");
  });
});

function pixabayHit(id: number, durationSeconds: number, mediumSizeBytes: number) {
  return {
    id,
    duration: durationSeconds,
    videos: {
      large: {
        url: `https://cdn.pixabay.invalid/${id}-large.mp4`,
        width: 1920,
        height: 1080,
        size: mediumSizeBytes * 2,
      },
      medium: {
        url: `https://cdn.pixabay.invalid/${id}-medium.mp4`,
        width: 1280,
        height: 720,
        size: mediumSizeBytes,
      },
      small: {
        url: `https://cdn.pixabay.invalid/${id}-small.mp4`,
        width: 640,
        height: 360,
        size: Math.round(mediumSizeBytes / 2),
      },
      tiny: {
        url: `https://cdn.pixabay.invalid/${id}-tiny.mp4`,
        width: 320,
        height: 180,
        size: Math.round(mediumSizeBytes / 4),
      },
    },
  };
}

describe("PixabayProvider.search", () => {
  it("filters by duration band and Pixabay's own `size` field — no HEAD request involved", async () => {
    let searchUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      searchUrl = input.toString();
      return jsonResponse({
        hits: [
          pixabayHit(1, 3, 10 * 1024 * 1024), // too short
          pixabayHit(2, 15, 20 * 1024 * 1024), // in band, under cap — kept
          pixabayHit(3, 15, 45 * 1024 * 1024), // in band, over cap — dropped
          pixabayHit(4, 40, 5 * 1024 * 1024), // too long
        ],
      });
    }) as unknown as typeof fetch;

    const clips = await new PixabayProvider().search("skyline", 5);

    expect(clips.map((c) => c.externalId)).toEqual(["2"]);
    // count=5, OVERFETCH_FACTOR=3 -> per_page=15.
    expect(searchUrl).toContain("per_page=15");
  });

  it("clamps per_page to Pixabay's [3, 200] range even after overfetching", async () => {
    let searchUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      searchUrl = input.toString();
      return jsonResponse({ hits: [] });
    }) as unknown as typeof fetch;

    await new PixabayProvider().search("skyline", 100); // 100*3=300, clamps to 200

    expect(searchUrl).toContain("per_page=200");
  });

  it("asks for live action by default — no safesearch, video_type=all", async () => {
    let searchUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      searchUrl = input.toString();
      return jsonResponse({ hits: [] });
    }) as unknown as typeof fetch;

    await new PixabayProvider().search("skyline", 5);

    const params = new URL(searchUrl).searchParams;
    expect(params.get("video_type")).toBe("all");
    expect(params.get("q")).toBe("skyline");
    // Absent, not "false": turning safesearch on for the default provider
    // would silently change what every existing channel collects.
    expect(params.has("safesearch")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cartoon variant
//
// `video_type=animation` alone is not what makes these results cartoons —
// Pixabay's "animation" bucket is "rendered rather than filmed", and includes
// photoreal 3D creatures and abstract motion graphics. Measured live against
// the real API over ten representative cues, the share of top-20 results
// carrying a cartoon-ish tag was 9% unfiltered, 25% with `video_type=animation`
// alone, and 56% with the filter plus the `cartoon` query prefix. Both levers
// are load-bearing, so both are asserted here.
// ---------------------------------------------------------------------------

describe("pixabayCartoonProvider.search", () => {
  it("filters to animation, forces safesearch, and prefixes the query with cartoon", async () => {
    let searchUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      searchUrl = input.toString();
      return jsonResponse({ hits: [pixabayHit(7, 12, 5 * 1024 * 1024)] });
    }) as unknown as typeof fetch;

    const clips = await pixabayCartoonProvider.search("a friendly dinosaur waves", 4);

    const params = new URL(searchUrl).searchParams;
    expect(params.get("video_type")).toBe("animation");
    expect(params.get("safesearch")).toBe("true");
    expect(params.get("q")).toBe("cartoon a friendly dinosaur waves");

    // Still tagged PIXABAY, not a new source: same account, same licence, and
    // therefore the same credit publish.service.ts already writes into every
    // description. See the provider's own doc comment.
    expect(clips).toHaveLength(1);
    expect(clips[0].source).toBe("PIXABAY");
    expect(clips[0].externalId).toBe("7");
  });

  it("clamps the prefixed query to Pixabay's 100-character limit", async () => {
    let searchUrl = "";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      searchUrl = input.toString();
      return jsonResponse({ hits: [] });
    }) as unknown as typeof fetch;

    await pixabayCartoonProvider.search("d".repeat(120), 4);

    // The prefix is part of what gets sent, so the clamp has to happen after
    // it is applied — Pixabay 400s on a `q` over 100 characters.
    const q = new URL(searchUrl).searchParams.get("q") ?? "";
    expect(q).toHaveLength(100);
    expect(q.startsWith("cartoon ")).toBe(true);
  });

  it("returns an empty list when the animation library has nothing for the cue", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ hits: [] })) as unknown as typeof fetch;

    // Not a throw: an empty animation library for one cue is an ordinary
    // outcome, and footage.service.ts's caller distinguishes it from a
    // provider failure. A children's video ends up with a gap at that
    // section rather than a live-action clip.
    await expect(pixabayCartoonProvider.search("quantum chromodynamics", 4)).resolves.toEqual(
      [],
    );
  });

  it("raises a non-retryable ProviderError when Pixabay rejects the key", async () => {
    // Pixabay answers a bad key with 400, not 401 — retrying cannot fix it,
    // so the error must not be marked retryable or job.service.ts would
    // burn its whole retry budget on a key that will never work.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    })) as unknown as typeof fetch;

    const error = await pixabayCartoonProvider
      .search("cartoon bear", 4)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "PIXABAY", retryable: false });
  });

  it("marks a 429 retryable so the job can back off instead of failing the video", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    })) as unknown as typeof fetch;

    const error = await pixabayCartoonProvider
      .search("cartoon bear", 4)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ provider: "PIXABAY", retryable: true });
  });
});
