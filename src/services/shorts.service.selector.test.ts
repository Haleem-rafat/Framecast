import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The default `MomentSelector` — the one piece of the shorts feature that talks
 * to a model, and therefore the one piece `shorts.service.test.ts` cannot cover
 * at all: that file injects a fake selector on purpose so nothing in it ever
 * makes a network call.
 *
 * It is a file of its own rather than a describe block over there because the
 * only way to exercise this code is to mock the `ai` module wholesale, and
 * doing that in the service test would take the real SDK away from every other
 * test in it. Same shape, and the same reasoning, as
 * `providers/gateway.provider.test.ts`.
 *
 * What is locked in here is the fix for the failure that meant shorts never
 * once succeeded in production: `anthropic/claude-sonnet-5` returned its whole
 * answer JSON-encoded inside its own `moments` property, schema validation
 * rejected it, and the catch block reported "the model provider failed" while
 * logging nothing an operator could act on.
 */
const generateObjectMock = vi.fn();

vi.mock("ai", () => {
  // Declared inside the factory because `vi.mock` is hoisted above every
  // declaration in this file; a class referenced from out here would be in its
  // temporal dead zone by the time the factory runs.
  class MockNoObjectGeneratedError extends Error {
    readonly text: string | undefined;

    constructor(options: { message: string; cause?: unknown; text?: string }) {
      super(options.message, { cause: options.cause });
      this.name = "AI_NoObjectGeneratedError";
      this.text = options.text;
    }

    static isInstance(error: unknown): boolean {
      return error instanceof MockNoObjectGeneratedError;
    }
  }

  return {
    createGateway: () => ({ languageModel: (model: string) => `mock-model:${model}` }),
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    NoObjectGeneratedError: MockNoObjectGeneratedError,
  };
});

import { NoObjectGeneratedError } from "ai";

import { ProviderError } from "@/lib/errors";
import { gatewayMomentSelector } from "@/services/shorts.service";

/** The real class demands `response`, `usage` and `finishReason` that mean
 *  nothing to the branch under test; the mock above takes only what does. */
const NoObjectGenerated = NoObjectGeneratedError as unknown as new (options: {
  message: string;
  cause?: unknown;
  text?: string;
}) => Error;

/** Verbatim from the AI Gateway: what the model returned for this exact prompt
 *  and schema, on every attempt, trimmed to one moment. */
const REAL_DOUBLE_ENCODED =
  '{"moments":"{\\"moments\\":[{\\"startSection\\":1,\\"endSection\\":7,' +
  '\\"title\\":\\"How Apple Built a Trillion Dollar Ecosystem\\",' +
  '\\"description\\":\\"A quick breakdown of the foundation.\\",' +
  '\\"reason\\":\\"A self-contained intro arc.\\"}]}"}';

const INPUT = {
  sections: "1. [12.0s] Everyone thinks inflation is about prices rising.",
  count: 3,
  tone: "confident",
  niche: "economics",
  apiKey: "test-key",
};

beforeEach(() => {
  generateObjectMock.mockReset();
});

describe("gatewayMomentSelector — the double-encoded answer", () => {
  it("hands generateObject a repair that rescues the answer the model really sent", async () => {
    generateObjectMock.mockResolvedValue({ object: { moments: [] } });

    await gatewayMomentSelector(INPUT);

    const call = generateObjectMock.mock.calls[0][0] as {
      repairText?: (options: { text: string }) => Promise<string | null>;
    };

    expect(call.repairText).toBeTypeOf("function");

    // Run the repair over the real malformed answer, exactly as the SDK does
    // once validation has failed. This is the assertion that would have caught
    // the production failure.
    const repaired = await call.repairText!({ text: REAL_DOUBLE_ENCODED });

    expect(JSON.parse(repaired as string)).toEqual({
      moments: [
        {
          startSection: 1,
          endSection: 7,
          title: "How Apple Built a Trillion Dollar Ecosystem",
          description: "A quick breakdown of the foundation.",
          reason: "A self-contained intro arc.",
        },
      ],
    });
  });

  it("returns the model's moments untouched when nothing needed repairing", async () => {
    const moments = [
      {
        startSection: 2,
        endSection: 4,
        title: "A title",
        description: "A description.",
        reason: "A reason.",
      },
    ];
    generateObjectMock.mockResolvedValue({ object: { moments } });

    await expect(gatewayMomentSelector(INPUT)).resolves.toEqual(moments);
  });
});

describe("gatewayMomentSelector — what a failure says and logs", () => {
  it("blames the model, not the provider, when the answer was the wrong shape", async () => {
    const validation = Object.assign(new Error("Type validation failed: expected array"), {
      name: "AI_TypeValidationError",
    });
    generateObjectMock.mockRejectedValue(
      new NoObjectGenerated({
        message: "No object generated: response did not match schema.",
        cause: validation,
        text: REAL_DOUBLE_ENCODED,
      }),
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const error = await gatewayMomentSelector(INPUT).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;

      // The message an operator reads. "The model provider failed" sent the
      // first production failure of this feature to an investigation; a
      // wrong-shape answer is worth clicking again, and must say so.
      expect(providerError.message).toContain("The model answered");
      expect(providerError.message).not.toContain("provider failed");
      expect(providerError.retryable).toBe(false);
      // The wrapper must not swallow what it wrapped.
      expect(providerError.cause).toBeDefined();

      // …and the server log must hold the whole chain, including the answer
      // the schema rejected, so the next failure is one `docker compose logs`
      // rather than another investigation.
      const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("gatewayMomentSelector");
      expect(logged).toContain("AI_NoObjectGeneratedError");
      expect(logged).toContain("AI_TypeValidationError");
      expect(logged).toContain("expected array");
      expect(logged).toContain('{"moments":');
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a rate limit retryable even though the status is one level down", async () => {
    const apiError = Object.assign(new Error("Too Many Requests"), {
      name: "AI_APICallError",
      statusCode: 429,
      responseBody: '{"error":"rate limited"}',
    });
    generateObjectMock.mockRejectedValue(
      new Error("Failed after 2 attempts.", { cause: apiError }),
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const error = (await gatewayMomentSelector(INPUT).catch(
        (thrown: unknown) => thrown,
      )) as ProviderError;

      expect(error).toBeInstanceOf(ProviderError);
      // Nothing answered, so this one really is the provider's fault.
      expect(error.message).toContain("provider failed");
      expect(error.retryable).toBe(true);

      expect(consoleError.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "status 429",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
