import { afterEach, describe, expect, it, vi } from "vitest";

import { ElevenLabsProvider } from "@/services/providers/elevenlabs.provider";

// `fetch` is stubbed for every test, so ElevenLabs is never contacted and no
// quota is spent — the same network-free convention
// stock-footage.provider.test.ts established for the providers below it.
const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

/** The with-timestamps endpoint's shape: base64 audio plus a character-level
 *  alignment, which lib/captions.ts turns straight into SRT. */
function timestampedResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      audio_base64: Buffer.from("audio").toString("base64"),
      alignment: {
        characters: ["H", "i"],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      },
    }),
  } as Response;
}

function bodyOf(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(mock.mock.calls[0][1].body);
}

describe("ElevenLabsProvider error reporting", () => {
  function errorResponse(status: number, body: string): Response {
    return {
      ok: false,
      status,
      statusText: "Unauthorized",
      text: async () => body,
    } as Response;
  }

  it("names quota_exceeded rather than leaving a bare 401", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      errorResponse(
        401,
        JSON.stringify({
          detail: { status: "quota_exceeded", message: "You have 12 characters left" },
        }),
      ),
    ) as unknown as typeof fetch;

    // ElevenLabs reports an exhausted allowance as 401, not 429, so a bare
    // status code is indistinguishable from a bad key — which is exactly the
    // dead end this exists to remove.
    await expect(
      new ElevenLabsProvider().synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" }),
    ).rejects.toThrow(/quota_exceeded/);
  });

  it("never echoes the provider's message text back", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      errorResponse(
        401,
        JSON.stringify({
          detail: { status: "quota_exceeded", message: "secret script content here" },
        }),
      ),
    ) as unknown as typeof fetch;

    // Only the machine-readable status is safe to repeat: the message field
    // can quote back the request, which is why the body was dropped entirely
    // before this.
    const error = await new ElevenLabsProvider()
      .synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" })
      .catch((caught: Error) => caught);

    expect((error as Error).message).toContain("quota_exceeded");
    expect((error as Error).message).not.toContain("secret script content");
  });

  it("still finds the status in a body far past any truncation point", async () => {
    // The regression this covers: the body used to be sliced to 2000 bytes
    // before parsing, which turned a long-but-valid JSON error into invalid
    // JSON and lost the status entirely — precisely when the response was
    // large, and precisely for the one condition (an exhausted allowance)
    // that no amount of retrying can fix.
    global.fetch = vi.fn().mockResolvedValue(
      errorResponse(
        401,
        JSON.stringify({
          detail: {
            status: "quota_exceeded",
            message: `x`.repeat(5000),
          },
        }),
      ),
    ) as unknown as typeof fetch;

    const error = await new ElevenLabsProvider()
      .synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" })
      .catch((caught: Error) => caught);

    expect((error as Error).message).toContain("quota_exceeded");
    // And the long message itself still never leaves this module.
    expect((error as Error).message).not.toContain("xxxx");
  });

  it("repeats nothing when the status field is not a short token", async () => {
    // The length bound moved from the body onto the token, so a body that
    // puts something long where the status belongs still gets nowhere.
    global.fetch = vi.fn().mockResolvedValue(
      errorResponse(401, JSON.stringify({ detail: { status: "y".repeat(500) } })),
    ) as unknown as typeof fetch;

    const error = await new ElevenLabsProvider()
      .synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" })
      .catch((caught: Error) => caught);

    expect((error as Error).message).not.toContain("yyyy");
  });

  it("still reports a status when the body is not JSON at all", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(500, "<html>gateway error</html>")) as unknown as typeof fetch;

    await expect(
      new ElevenLabsProvider().synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" }),
    ).rejects.toThrow(/500/);
  });
});

describe("ElevenLabsProvider.getQuota", () => {
  it("reports what is used and what is allowed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ character_count: 8958, character_limit: 10000, tier: "free" }),
    } as Response) as unknown as typeof fetch;

    expect(await new ElevenLabsProvider().getQuota("k")).toEqual({
      usedCharacters: 8958,
      limitCharacters: 10000,
    });
  });

  it("returns null rather than throwing when the check itself fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 } as Response) as unknown as typeof fetch;

    // A failed quota check must never be the reason narration does not happen.
    expect(await new ElevenLabsProvider().getQuota("k")).toBeNull();
  });
});

describe("ElevenLabsProvider request body", () => {
  it("sends voice settings and a fixed seed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ElevenLabsProvider().synthesize({
      text: "Hello",
      voiceId: "v1",
      apiKey: "k",
      voice: { stability: 0.5, style: 0.3, speed: 1, seed: 20260811 },
    });

    const body = bodyOf(fetchMock) as {
      voice_settings: Record<string, number>;
      seed: number;
    };

    expect(body.voice_settings.stability).toBe(0.5);
    expect(body.voice_settings.style).toBe(0.3);
    expect(body.voice_settings.speed).toBe(1);
    // A fixed seed is what makes re-synthesising unchanged text reproducible.
    expect(body.seed).toBe(20260811);
  });

  it("sends dictionary locators and never markup in the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ElevenLabsProvider().synthesize({
      text: "Ada Lovelace",
      voiceId: "v1",
      apiKey: "k",
      dictionaryLocators: [{ id: "d1", versionId: "ver1" }],
    });

    const body = bodyOf(fetchMock) as {
      text: string;
      pronunciation_dictionary_locators: { pronunciation_dictionary_id: string }[];
    };

    // The returned alignment describes this exact string and captions.ts turns
    // it straight into SRT, so markup here would corrupt the captions in order
    // to fix the audio. That is the whole reason dictionaries are used.
    expect(body.text).toBe("Ada Lovelace");
    expect(body.pronunciation_dictionary_locators).toHaveLength(1);
    expect(body.pronunciation_dictionary_locators[0].pronunciation_dictionary_id).toBe("d1");
  });

  it("sends at most three locators, which is the endpoint's limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ElevenLabsProvider().synthesize({
      text: "Hi",
      voiceId: "v1",
      apiKey: "k",
      dictionaryLocators: [
        { id: "a", versionId: "1" },
        { id: "b", versionId: "2" },
        { id: "c", versionId: "3" },
        { id: "d", versionId: "4" },
      ],
    });

    const body = bodyOf(fetchMock) as { pronunciation_dictionary_locators: unknown[] };
    expect(body.pronunciation_dictionary_locators).toHaveLength(3);
  });

  it("omits both when the caller supplies neither", async () => {
    const fetchMock = vi.fn().mockResolvedValue(timestampedResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ElevenLabsProvider().synthesize({ text: "Hi", voiceId: "v1", apiKey: "k" });

    const body = bodyOf(fetchMock);

    // An existing caller's request must be byte-for-byte what it was before.
    expect(body.voice_settings).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.pronunciation_dictionary_locators).toBeUndefined();
  });
});
