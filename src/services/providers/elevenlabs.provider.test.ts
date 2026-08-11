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
