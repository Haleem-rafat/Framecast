import { describe, expect, it } from "vitest";

import {
  describeProviderFailure,
  isRetryableProviderFailure,
  providerStatusCode,
  repairDoubleEncodedObject,
} from "@/lib/structured-output";

/**
 * The answer `anthropic/claude-sonnet-5` actually returned through the AI
 * Gateway for the shorts moment-selection call, trimmed to two moments.
 *
 * Kept verbatim rather than hand-written, because the entire point of the
 * repair is that it matches what a real model really did — a tidied-up
 * approximation would let a change that no longer handles the real shape pass
 * this file.
 */
const REAL_DOUBLE_ENCODED =
  '{"moments":"{\\"moments\\":[{\\"startSection\\":1,\\"endSection\\":7,' +
  '\\"title\\":\\"How Apple Built a Trillion Dollar Ecosystem\\",' +
  '\\"description\\":\\"A quick breakdown of the foundation.\\",' +
  '\\"reason\\":\\"A self-contained intro arc.\\"},' +
  '{\\"startSection\\":8,\\"endSection\\":14,' +
  '\\"title\\":\\"The Services Money Machine\\",' +
  '\\"description\\":\\"How services became a revenue engine.\\",' +
  '\\"reason\\":\\"A distinct middle-video concept.\\"}]}"}';

describe("repairDoubleEncodedObject", () => {
  it("un-nests the answer a model encoded into its own single property", () => {
    const repaired = repairDoubleEncodedObject(REAL_DOUBLE_ENCODED);

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired as string)).toEqual({
      moments: [
        {
          startSection: 1,
          endSection: 7,
          title: "How Apple Built a Trillion Dollar Ecosystem",
          description: "A quick breakdown of the foundation.",
          reason: "A self-contained intro arc.",
        },
        {
          startSection: 8,
          endSection: 14,
          title: "The Services Money Machine",
          description: "How services became a revenue engine.",
          reason: "A distinct middle-video concept.",
        },
      ],
    });
  });

  it("puts a bare encoded value back into the property it belongs to", () => {
    // The same mistake without the re-wrapping: the string holds only what the
    // property should have contained, so it has to be put back rather than
    // returned as the whole answer.
    const repaired = repairDoubleEncodedObject('{"moments":"[{\\"startSection\\":2}]"}');

    expect(JSON.parse(repaired as string)).toEqual({ moments: [{ startSection: 2 }] });
  });

  it("decodes an answer whose whole object was encoded as one JSON string", () => {
    const repaired = repairDoubleEncodedObject('"{\\"moments\\":[{\\"startSection\\":3}]}"');

    expect(JSON.parse(repaired as string)).toEqual({ moments: [{ startSection: 3 }] });
  });

  it("does not touch an answer that is merely wrong, or one that is not JSON", () => {
    // Every one of these is a real failure the SDK would also report through
    // repairText, and none of them is the fault this function repairs. Turning
    // any of them into "repaired" text would replace a clear schema error with
    // a confusing one.
    expect(repairDoubleEncodedObject("Here are three good moments:")).toBeNull();
    expect(repairDoubleEncodedObject('{"moments":[{"startSection":1}]}')).toBeNull();
    expect(repairDoubleEncodedObject('{"moments":42}')).toBeNull();
    expect(repairDoubleEncodedObject('{"moments":"not json at all"}')).toBeNull();
    expect(repairDoubleEncodedObject("[1,2,3]")).toBeNull();
    expect(repairDoubleEncodedObject('"just a string"')).toBeNull();
  });

  it("leaves a multi-field answer alone even when one field holds JSON text", () => {
    // A title that legitimately contains JSON is not a fault to repair, and
    // unwrapping it would destroy a valid answer rather than rescue a broken
    // one. Only the single-property shape is ever touched.
    expect(
      repairDoubleEncodedObject('{"title":"{\\"a\\":1}","description":"hi"}'),
    ).toBeNull();
  });
});

describe("providerStatusCode / isRetryableProviderFailure", () => {
  it("finds a status code nested inside the cause chain", () => {
    // What the AI SDK actually hands over: the status lives on the API error,
    // which is the *cause*, while the thrown value is the generic wrapper. A
    // top-level-only read would call this rate limit permanent.
    const apiError = Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
    const thrown = new Error("No object generated.", { cause: apiError });

    expect(providerStatusCode(thrown)).toBe(429);
    expect(isRetryableProviderFailure(thrown)).toBe(true);
  });

  it("treats 5xx as retryable and a schema failure with no status as not", () => {
    expect(
      isRetryableProviderFailure(Object.assign(new Error("bad gateway"), { statusCode: 502 })),
    ).toBe(true);
    expect(
      isRetryableProviderFailure(Object.assign(new Error("bad request"), { statusCode: 400 })),
    ).toBe(false);
    expect(isRetryableProviderFailure(new Error("response did not match schema"))).toBe(false);
  });

  it("terminates on a self-referential cause", () => {
    const looping = new Error("round and round");
    (looping as { cause?: unknown }).cause = looping;

    expect(providerStatusCode(looping)).toBeUndefined();
  });
});

describe("describeProviderFailure", () => {
  it("carries the whole chain, the status, and the answer the schema rejected", () => {
    const validation = Object.assign(new Error("Type validation failed: expected array"), {
      name: "AI_TypeValidationError",
    });
    const thrown = Object.assign(
      new Error("No object generated: response did not match schema.", {
        cause: validation,
      }),
      { name: "AI_NoObjectGeneratedError", text: '{"moments":"{}"}' },
    );

    const described = describeProviderFailure(thrown);

    expect(described).toContain("AI_NoObjectGeneratedError");
    expect(described).toContain("response did not match schema");
    expect(described).toContain("AI_TypeValidationError");
    expect(described).toContain("expected array");
    // The rejected answer itself, which is the one thing that makes a
    // wrong-shape failure diagnosable without reproducing it.
    expect(described).toContain('body {"moments":"{}"}');
  });

  it("reports a gateway rejection with its status, url and response body", () => {
    const apiError = Object.assign(new Error("Unauthorized"), {
      name: "AI_APICallError",
      statusCode: 401,
      url: "https://ai-gateway.vercel.sh/v1/ai",
      responseBody: '{"error":"invalid api key"}',
    });

    const described = describeProviderFailure(apiError);

    expect(described).toContain("status 401");
    expect(described).toContain("https://ai-gateway.vercel.sh/v1/ai");
    expect(described).toContain("invalid api key");
  });

  it("bounds what a chatty model can write into the log", () => {
    const huge = Object.assign(new Error("x".repeat(5000)), { name: "AI_TypeValidationError" });

    const described = describeProviderFailure(huge);

    expect(described.length).toBeLessThan(1200);
    expect(described).toContain("(5000 chars)");
  });

  it("describes a non-Error throw rather than losing it", () => {
    expect(describeProviderFailure("gateway went away")).toContain("gateway went away");
    expect(describeProviderFailure(undefined)).toBe("unknown failure (no error value)");
  });
});
