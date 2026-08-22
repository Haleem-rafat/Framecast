import { describe, expect, it } from "vitest";

import { ART_STYLES } from "@/lib/art-styles";
import { SCRIPT_STYLES } from "@/lib/script-styles";
import {
  findStylePreset,
  presetFieldValues,
  STYLE_PRESETS,
  stylePresetLabel,
} from "@/lib/style-presets";
import { stylePicksArtStyle } from "@/lib/footage-styles";

/**
 * The catalogue is data, so these are the assertions that would otherwise be a
 * reviewer checking every preset against four other files by hand.
 */
describe("STYLE_PRESETS", () => {
  it("has unique ids", () => {
    const ids = STYLE_PRESETS.map((preset) => preset.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  // A preset naming a slug that no longer exists would resolve to nothing at
  // the moment somebody generates, which is the worst time to find out.
  it("names only art styles that exist", () => {
    for (const preset of STYLE_PRESETS) {
      if (preset.artStyle) {
        expect(ART_STYLES.map((style) => style.id)).toContain(preset.artStyle);
      }
    }
  });

  it("names only script styles that exist", () => {
    for (const preset of STYLE_PRESETS) {
      if (preset.scriptStyleId) {
        expect(SCRIPT_STYLES.map((style) => style.id)).toContain(preset.scriptStyleId);
      }
    }
  });

  // Exactly one, because the two are alternative ways for a script to get
  // written and a preset carrying both would leave the caller to guess.
  it("says how the script is written, one way or the other", () => {
    for (const preset of STYLE_PRESETS) {
      const ways = [preset.scriptStyleId, preset.scriptFormat].filter(Boolean);

      expect(ways).toHaveLength(1);
    }
  });

  // The refusal these would otherwise hit is at footage collection, after the
  // script has been written and the narration paid for.
  it("gives an art style to every preset whose footage style reads one", () => {
    for (const preset of STYLE_PRESETS) {
      if (stylePicksArtStyle(preset.footageStyle)) {
        expect(preset.artStyle).toBeTruthy();
      } else {
        expect(preset.artStyle).toBeUndefined();
      }
    }
  });

  it("resolves by id and falls back honestly", () => {
    expect(findStylePreset("marker-doodle")?.name).toBe("Marker doodle");
    expect(findStylePreset("nope")).toBeNull();
    expect(stylePresetLabel(null)).toBe("None chosen");
  });
});

describe("presetFieldValues", () => {
  // What the picker writes into the form when a card is clicked. A pure
  // function so the *set of fields a preset touches* is pinned by a test
  // rather than living only in a JSX callback — a preset that quietly stopped
  // setting the cadence would otherwise be invisible until a video came out
  // at the wrong speed.
  it("fills every column the preset carries", () => {
    const doodle = findStylePreset("marker-doodle");

    expect(presetFieldValues(doodle!)).toEqual({
      footageStyle: "DOODLE",
      artStyle: "doodle-marker",
      beatSeconds: "7",
    });
  });

  // Absent is a real answer, not a gap: CINEMATIC reads no art style, and the
  // insight format decides its own cadence. Both must clear the field rather
  // than leave a stale value from whatever the channel was before.
  it("clears the fields a preset deliberately does not carry", () => {
    const insight = findStylePreset("insight-short");

    expect(presetFieldValues(insight!)).toEqual({
      footageStyle: "CINEMATIC",
      artStyle: "",
      beatSeconds: "",
    });
  });

  // The form holds every control's value as a string.
  it("returns strings, because that is what the controls hold", () => {
    for (const preset of STYLE_PRESETS) {
      const values = presetFieldValues(preset);

      expect(typeof values.artStyle).toBe("string");
      expect(typeof values.beatSeconds).toBe("string");
    }
  });
});
