import { describe, expect, it } from "vitest";

import {
  FOOTAGE_STYLES,
  footageStyleLabel,
  isGeneratedFootage,
  needsCharacterSheet,
} from "@/lib/footage-styles";

describe("FOOTAGE_STYLES", () => {
  it("offers the mixed style, so a channel can be set to it at all", () => {
    expect(FOOTAGE_STYLES.map((option) => option.value)).toContain("MIXED");
    expect(footageStyleLabel("MIXED")).toBe("Mixed");
  });

  it("says in the picker that a movement shot with no clip is drawn instead", () => {
    // The one thing an operator cannot infer from the setting's name, and the
    // reason the cartoon style's description exists in the same shape: a video
    // that quietly cost more than the estimate is read as a billing bug unless
    // the trade-off was stated where the choice was made.
    const mixed = FOOTAGE_STYLES.find((option) => option.value === "MIXED")!;

    expect(mixed.description).toMatch(/drawn instead/i);
  });
});

describe("isGeneratedFootage", () => {
  it("counts the mixed style, because most of its shots are still paid for", () => {
    // Every caller is asking "will approving this script start spending money
    // on pictures". A mixed video generates every shot its writer did not tag
    // `motion`, which is most of them — false here would warn nobody about a
    // real invoice.
    expect(isGeneratedFootage("MIXED")).toBe(true);
    expect(isGeneratedFootage("ILLUSTRATED")).toBe(true);
    expect(isGeneratedFootage("CINEMATIC")).toBe(true);
    expect(isGeneratedFootage("LIVE_ACTION")).toBe(false);
    expect(isGeneratedFootage("CARTOON")).toBe(false);
  });
});

describe("needsCharacterSheet", () => {
  it("still asks for a sheet only from the one style that holds a character", () => {
    // A list video's shots are thirty different subjects, and the ones tagged
    // `motion` are stock clips that could not hold a recurring character even
    // if the format wanted one — so a mixed channel must not be blocked on the
    // branding screen before its first video.
    expect(needsCharacterSheet("MIXED")).toBe(false);
    expect(needsCharacterSheet("ILLUSTRATED")).toBe(true);
    expect(needsCharacterSheet("CINEMATIC")).toBe(false);
  });
});
