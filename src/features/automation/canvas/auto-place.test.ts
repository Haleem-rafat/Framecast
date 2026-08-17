import { describe, expect, it } from "vitest";

import { autoPlace } from "@/features/automation/canvas/auto-place";

describe("autoPlace", () => {
  it("puts the first node exactly at the anchor", () => {
    expect(autoPlace([], { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it("steps down when the anchor is taken", () => {
    const placed = autoPlace([{ x: 100, y: 100 }], { x: 100, y: 100 });

    expect(placed.x).toBe(100);
    expect(placed.y).toBeGreaterThan(100);
  });

  it("keeps stepping past a run of taken slots", () => {
    const taken = [
      { x: 100, y: 100 },
      { x: 100, y: 220 },
      { x: 100, y: 340 },
    ];

    const placed = autoPlace(taken, { x: 100, y: 100 });

    expect(taken).not.toContainEqual(placed);
    expect(placed.y).toBeGreaterThan(340);
  });

  it("treats a near-miss as taken", () => {
    // Two cards four pixels apart overlap on screen. "Free" has to mean
    // visually free, or a node dropped a hair off another's position makes this
    // place the next one straight through both.
    const placed = autoPlace([{ x: 100, y: 104 }], { x: 100, y: 100 });

    expect(placed.y).toBeGreaterThan(104);
  });

  it("ignores a taken slot in a different column", () => {
    // Branches sit side by side. A busy channel column must not push the next
    // channel's first node down to match it.
    expect(autoPlace([{ x: 900, y: 100 }], { x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("is deterministic — the same tree twice places identically", () => {
    const taken = [{ x: 0, y: 0 }];

    expect(autoPlace(taken, { x: 0, y: 0 })).toEqual(autoPlace(taken, { x: 0, y: 0 }));
  });

  it("never loops forever, even against an absurd column", () => {
    // 600 nodes stacked in one column exceeds MAX_STEPS. The contract is that
    // this returns *something* visible rather than hanging a render.
    const taken = Array.from({ length: 600 }, (_, index) => ({
      x: 0,
      y: index * 120,
    }));

    expect(autoPlace(taken, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
