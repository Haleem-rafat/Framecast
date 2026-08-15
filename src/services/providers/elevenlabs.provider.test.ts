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

describe("ElevenLabsProvider.listVoices", () => {
  function voicesResponse(voices: unknown[]): Response {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ voices }),
    } as Response;
  }

  it("asks the voices endpoint with the key in the header and nowhere else", async () => {
    const fetchMock = vi.fn().mockResolvedValue(voicesResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ElevenLabsProvider().listVoices("sk_secret_1234");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices");
    // Not in the query string, where it would land in every access log and
    // every Referer along the way.
    expect(url).not.toContain("sk_secret_1234");
    expect(init.headers["xi-api-key"]).toBe("sk_secret_1234");
  });

  it("maps a voice to what a picker needs, labels and preview included", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      voicesResponse([
        {
          voice_id: "AbC123",
          name: "Charlotte",
          description: "  Warm and unhurried  ",
          labels: { accent: "british", use_case: "narration", age: "" },
          preview_url: "https://storage.googleapis.com/eleven/charlotte.mp3",
        },
      ]),
    ) as unknown as typeof fetch;

    const [voice] = await new ElevenLabsProvider().listVoices("k");

    expect(voice).toEqual({
      voiceId: "AbC123",
      name: "Charlotte",
      description: "Warm and unhurried",
      // `use_case` is an API identifier; this is the only place it is shown to
      // a person. An empty label is not a label.
      labels: [
        { name: "accent", value: "british" },
        { name: "use case", value: "narration" },
      ],
      previewUrl: "https://storage.googleapis.com/eleven/charlotte.mp3",
    });
  });

  it("keeps a voice that has no labels, no description and no sample", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(voicesResponse([{ voice_id: "AbC123", name: "Cloned" }])) as unknown as typeof fetch;

    const [voice] = await new ElevenLabsProvider().listVoices("k");

    // A cloned voice usually has none of the three. It is still choosable.
    expect(voice).toEqual({
      voiceId: "AbC123",
      name: "Cloned",
      description: null,
      labels: [],
      previewUrl: null,
    });
  });

  it("drops a voice with no id or no name rather than rendering a blank row", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      voicesResponse([
        { name: "Nameless id" },
        { voice_id: "AbC123" },
        { voice_id: "XyZ789", name: "Real" },
      ]),
    ) as unknown as typeof fetch;

    // The id is what gets saved and the name is the only thing anyone picks
    // by; a row missing either cannot be offered.
    expect(await new ElevenLabsProvider().listVoices("k")).toEqual([
      {
        voiceId: "XyZ789",
        name: "Real",
        description: null,
        labels: [],
        previewUrl: null,
      },
    ]);
  });

  it("refuses a preview URL that is not https", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      voicesResponse([
        { voice_id: "a", name: "Insecure", preview_url: "http://example.com/a.mp3" },
        { voice_id: "b", name: "Hostile", preview_url: "javascript:alert(1)" },
      ]),
    ) as unknown as typeof fetch;

    // This value becomes an `<audio src>` in the operator's page.
    const voices = await new ElevenLabsProvider().listVoices("k");
    expect(voices.map((voice) => voice.previewUrl)).toEqual([null, null]);
  });

  it("throws rather than returning an empty list when ElevenLabs refuses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ detail: { status: "invalid_api_key" } }),
    } as Response) as unknown as typeof fetch;

    // "This account has no voices" and "we could not ask" are different things
    // to put in front of an operator, and only a throw distinguishes them.
    await expect(new ElevenLabsProvider().listVoices("sk_secret_1234")).rejects.toThrow(
      /invalid_api_key/,
    );
    await expect(
      new ElevenLabsProvider().listVoices("sk_secret_1234"),
    ).rejects.not.toThrow(/sk_secret_1234/);
  });

  it("throws when ElevenLabs cannot be reached at all", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND")) as unknown as typeof fetch;

    await expect(new ElevenLabsProvider().listVoices("k")).rejects.toThrow(
      /Could not reach ElevenLabs/,
    );
  });
});
