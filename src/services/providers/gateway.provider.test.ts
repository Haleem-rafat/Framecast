import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// generateScript has callers other than script generation: a
// pronunciation-respelling prompt (voiceover.service.ts) and a bare API-key
// check (provider-credential.service.ts), both of which send their own
// free-form prompt and expect free-form text back. `withSections` exists so
// the structured-output schema is only ever sent when a caller actually asks
// for it — this file locks that default in, so a future change can't quietly
// route every caller through the sections schema again the way Task 2
// originally did.
const generateTextMock = vi.fn();
const generateObjectMock = vi.fn();

vi.mock("ai", () => ({
  createGateway: () => ({ languageModel: () => "mock-model" }),
  generateText: (...args: unknown[]) => generateTextMock(...args),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

import { GatewayProvider } from "@/services/providers/gateway.provider";

beforeEach(() => {
  generateTextMock.mockReset();
  generateObjectMock.mockReset();
});

describe("GatewayProvider.generateScript — structured output is opt-in", () => {
  it("without withSections, calls generateText, sends no schema, and returns no sections", async () => {
    generateTextMock.mockResolvedValue({
      text: "For each term, a plain-English respelling: [{...}]",
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const provider = new GatewayProvider();
    const result = await provider.generateScript({
      prompt: "Reply with the single word: ok",
      apiKey: "test-key",
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateObjectMock).not.toHaveBeenCalled();

    // generateText's call shape has no `schema` field to begin with — this
    // confirms it's the one that fired, not merely that some function did.
    const call = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("schema");
    expect(call.prompt).toBe("Reply with the single word: ok");

    expect(result.content).toBe(
      "For each term, a plain-English respelling: [{...}]",
    );
    expect(result.sections).toBeUndefined();
  });

  it("with withSections: true, calls generateObject with the sections schema", async () => {
    generateObjectMock.mockResolvedValue({
      object: { sections: [{ text: "Hi.", cue: "a wave" }] },
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const provider = new GatewayProvider();
    const result = await provider.generateScript({
      prompt: "Write a script about greetings.",
      apiKey: "test-key",
      withSections: true,
    });

    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();

    const call = generateObjectMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call).toHaveProperty("schema");

    expect(result.content).toBe("Hi.");
    expect(result.sections).toEqual([{ text: "Hi.", cue: "a wave" }]);
  });
});

describe("GatewayProvider.generateScript — citations stay out of the narration", () => {
  it("returns the model's sources without letting them reach content", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        sections: [
          { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
          { text: "It is money losing value.", cue: "printing press running" },
        ],
        sources: ["https://example.com/h6-release", "SEC filing, 2001"],
      },
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const provider = new GatewayProvider();
    const result = await provider.generateScript({
      prompt: "Write a script about inflation.",
      apiKey: "test-key",
      withSections: true,
    });

    expect(result.sources).toEqual([
      "https://example.com/h6-release",
      "SEC filing, 2001",
    ]);

    // The whole reason the field exists. `content` is sent verbatim to
    // ElevenLabs, so a url that leaks into it is a url read aloud in the
    // finished video.
    expect(result.content).toBe(
      "Inflation is not prices going up. It is money losing value.",
    );
    expect(result.content).not.toContain("example.com");
    expect(result.content).not.toContain("SEC filing");
  });

  it("leaves sources undefined when the model cited nothing", async () => {
    generateObjectMock.mockResolvedValue({
      object: { sections: [{ text: "Hi.", cue: "a wave" }] },
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const provider = new GatewayProvider();
    const result = await provider.generateScript({
      prompt: "Write a script about greetings.",
      apiKey: "test-key",
      withSections: true,
    });

    // Undefined, not an empty array: script.service.ts stores it as SQL NULL,
    // which is what lets an older script's inline SOURCES block still be the
    // description's fallback.
    expect(result.sources).toBeUndefined();
  });

  it("tells the model in the schema itself that sources are never spoken", async () => {
    generateObjectMock.mockResolvedValue({
      object: { sections: [{ text: "Hi.", cue: "a wave" }] },
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const provider = new GatewayProvider();
    await provider.generateScript({
      prompt: "Write a script.",
      apiKey: "test-key",
      withSections: true,
    });

    // The operator's stored prompt template is editable and an older one may
    // still ask for an inline SOURCES section, so the instruction that keeps
    // urls out of the audio has to travel with the schema rather than only
    // with the prompt.
    // Read the way the SDK reads it — a Zod schema keeps `.describe()` text
    // in a registry rather than on the object, so stringifying the schema
    // itself would assert nothing.
    const call = generateObjectMock.mock.calls[0][0] as { schema: z.ZodType };
    expect(JSON.stringify(z.toJSONSchema(call.schema))).toContain("never spoken");
  });
});
