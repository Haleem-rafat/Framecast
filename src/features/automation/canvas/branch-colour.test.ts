import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { branchColour } from "@/features/automation/canvas/branch-colour";

describe("branchColour", () => {
  it("gives the same channel the same colour every time", () => {
    // The whole reason this is a hash rather than a stored column: stable
    // across devices and sessions with nothing written down.
    const id = randomUUID();

    expect(branchColour(id)).toEqual(branchColour(id));
  });

  it("gives different channels different hues", () => {
    const hues = new Set(
      Array.from({ length: 20 }, () => branchColour(randomUUID()).hue),
    );

    // Twenty random uuids colliding on a hue would mean the hash is not
    // avalanching, which is the failure a naive char-code sum has.
    expect(hues.size).toBeGreaterThan(18);
  });

  it("separates ids that differ by one character", () => {
    // The case a weak hash gets wrong, and the common one: sequential or
    // near-identical uuids sitting side by side in the same list.
    const a = branchColour("11111111-1111-1111-1111-111111111111");
    const b = branchColour("11111111-1111-1111-1111-111111111112");

    const apart = Math.abs(a.hue - b.hue);

    expect(Math.min(apart, 360 - apart)).toBeGreaterThan(20);
  });

  it("keeps every hue in range", () => {
    for (let index = 0; index < 200; index += 1) {
      const { hue } = branchColour(randomUUID());

      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("draws the unrooted branch grey rather than as a channel", () => {
    // It belongs to no channel and must not look like one.
    const orphan = branchColour(null);

    expect(orphan.hue).toBe(0);
    expect(orphan.light).toContain(" 0 0");
    expect(orphan.dark).toContain(" 0 0");
  });

  it("emits colours a browser can parse", () => {
    const { light, dark } = branchColour(randomUUID());

    expect(light).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/);
    expect(dark).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/);
  });

  it("gives light and dark the same hue at different lightness", () => {
    const { light, dark } = branchColour(randomUUID());

    const hueOf = (value: string) => value.split(" ")[2];
    const lightnessOf = (value: string) => value.split(" ")[0];

    expect(hueOf(light)).toBe(hueOf(dark));
    expect(lightnessOf(light)).not.toBe(lightnessOf(dark));
  });
});
