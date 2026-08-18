import { describe, expect, it } from "vitest";

import { estimateCostUsd } from "@/lib/cost";

describe("estimateCostUsd", () => {
  it("prices a known model per million tokens", () => {
    // 1M in at $3, 1M out at $15
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });

  it("scales linearly below a million tokens", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 1_000, 2_000)).toBeCloseTo(0.033, 6);
  });

  it("returns 0 for an unknown model rather than guessing", () => {
    expect(estimateCostUsd("unknown/model", 1_000, 1_000)).toBe(0);
  });

  it("treats zero tokens as free", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 0, 0)).toBe(0);
  });

  it("prices the image models, which are billed per token like the text ones", () => {
    // The measured 1024x1536 illustration behind cost.ts's own comment. $0.047
    // is the figure every cost table in the long-form spec is written against,
    // so it is pinned here rather than left to be re-derived.
    expect(estimateCostUsd("openai/gpt-image-2", 1150, 1372)).toBeCloseTo(0.04691, 8);

    // And the same picture with the output half of the bill missing, which is
    // what a gateway response that omits `outputTokens` produces: $0.00575,
    // rendered by `.toFixed(3)` as the "$0.006" that has been quoted as a
    // price. The two numbers below are the same generation, and the only thing
    // separating them is a field that may or may not arrive.
    expect(estimateCostUsd("openai/gpt-image-2", 1150, 0)).toBeCloseTo(0.00575, 8);

    // Thumbnails and channel logos. Unlisted until now, and therefore priced at
    // exactly $0.00 by the rule above — indistinguishable from an image that
    // was never generated.
    expect(estimateCostUsd("openai/gpt-image-1", 1_000_000, 1_000_000)).toBeCloseTo(45, 6);
  });
});
