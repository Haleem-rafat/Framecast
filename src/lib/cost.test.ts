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
});
