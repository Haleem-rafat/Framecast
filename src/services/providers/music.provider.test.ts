import { afterEach, describe, expect, it, vi } from "vitest";

import { JamendoProvider } from "@/services/providers/music.provider";

// `fetch` is stubbed for every test, so Jamendo is never actually contacted —
// the same network-free convention stock-footage.provider.test.ts established
// one layer down. The client id is injected rather than read off `env` so
// these tests do not depend on a key being present in .env.local.
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

function errorResponse(status: number): Response {
  return { ok: false, status, statusText: "Error" } as Response;
}

const track = {
  id: "1",
  name: "Test Track",
  artist_name: "Artist",
  license_ccurl: "https://creativecommons.org/licenses/by/3.0/",
  duration: 180,
  audiodownload: "https://example.test/1.mp3",
  audiodownload_allowed: true,
};

function provider(): JamendoProvider {
  return new JamendoProvider("test-client-id");
}

describe("JamendoProvider", () => {
  it("excludes non-commercial licences at the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [track] }));
    global.fetch = fetchMock;

    await provider().search("calm ambient", 3);

    // A non-commercial licence is unusable on a channel meant to be monetised,
    // so it is excluded before the results arrive rather than filtered after.
    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("ccnc")).toBe("false");
  });

  it("excludes no-derivatives licences too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [track] }));
    global.fetch = fetchMock;

    await provider().search("calm ambient", 3);

    // The bed is trimmed, gain-staged and ducked under narration, which is
    // plausibly an adaptation. A real search does return BY-ND tracks.
    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("ccnd")).toBe("false");
  });

  it("skips a track whose artist has disabled downloads", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ ...track, audiodownload_allowed: false }] }));

    // Artists can switch downloads off independently of the licence.
    expect(await provider().search("calm", 3)).toEqual([]);
  });

  it("skips a track with no download url at all", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ results: [{ ...track, audiodownload: "" }] }));

    expect(await provider().search("calm", 3)).toEqual([]);
  });

  it("returns the attribution fields the description needs", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ results: [track] }));

    const [result] = await provider().search("calm", 3);

    expect(result.title).toBe("Test Track");
    expect(result.artistName).toBe("Artist");
    expect(result.licenseUrl).toContain("creativecommons.org");
    expect(result.externalId).toBe("1");
  });

  it("marks a 5xx as retryable and a 400 as not", async () => {
    global.fetch = vi.fn().mockResolvedValue(errorResponse(503));
    await expect(provider().search("calm", 3)).rejects.toMatchObject({ retryable: true });

    global.fetch = vi.fn().mockResolvedValue(errorResponse(400));
    await expect(provider().search("calm", 3)).rejects.toMatchObject({ retryable: false });
  });

  it("refuses to search when no client id is configured", async () => {
    // An empty string rather than `undefined`: the constructor defaults an
    // omitted argument to env.JAMENDO_CLIENT_ID, so passing undefined would
    // pick up a real key wherever one is configured and make this test pass or
    // fail depending on the machine. Both values are equally unconfigured to
    // the guard; only this one is independent of the environment.
    await expect(new JamendoProvider("").search("calm", 3)).rejects.toMatchObject({
      retryable: false,
    });
  });
});
