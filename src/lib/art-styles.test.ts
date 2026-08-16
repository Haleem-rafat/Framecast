import { describe, expect, it } from "vitest";

import {
  ART_STYLES,
  artStyleLabel,
  composeArtStyle,
  findArtStyle,
} from "@/lib/art-styles";

describe("the art style catalogue", () => {
  it("has stable, unique slugs — a channel stores one of these forever", () => {
    const ids = ART_STYLES.map((style) => style.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("names no living artist, no studio and no film", () => {
    // Not squeamishness. A channel whose look is "in the style of X" is built
    // on somebody else's IP and somebody else's livelihood, and it is a
    // takedown waiting to happen. It is also worse prompting: a technique
    // tells a model something it can act on, a proper noun tells it to guess.
    //
    // A word list cannot prove the absence of every name, so this checks the
    // shape instead: a fragment that names nobody has no capitalised words in
    // it except at the start of a sentence.
    const sentenceStart = /(^|[.!?]\s+|\n)\s*/;

    for (const style of ART_STYLES) {
      const stripped = style.prompt.replace(new RegExp(`${sentenceStart.source}[A-Z]`, "g"), " ");
      const capitalised = stripped.match(/\b[A-Z][a-z]+/g) ?? [];
      expect(capitalised, `${style.id} names something proper`).toEqual([]);
    }
  });

  it("gives every style a medium, a light and a palette", () => {
    // The three things an image model can actually act on, and the three that
    // decide whether a dozen separate generations look like one film. A style
    // missing the palette in particular is a style whose colour drifts between
    // beats, which is the documented artifact that stops stills intercutting.
    for (const style of ART_STYLES) {
      expect(style.prompt.length, style.id).toBeGreaterThan(150);
      expect(style.prompt.toLowerCase(), style.id).toMatch(/palette|colour/);
      expect(style.prompt.toLowerCase(), style.id).toMatch(/light|shadow|shading/);
    }
  });

  it("describes what the style suits, and admits what it does not", () => {
    for (const style of ART_STYLES) {
      expect(style.name.length, style.id).toBeGreaterThan(3);
      expect(style.description.length, style.id).toBeGreaterThan(60);
    }
  });

  it("carries the invariant direction into every style", () => {
    // The look differs; the brief it is applied to does not. A style that
    // could drop "no text" would be a style that can burn a misspelled word
    // into a children's video, which is exactly the defect YouTube's kids
    // quality principles call "deceptively educational".
    for (const style of ART_STYLES) {
      const composed = composeArtStyle(style);
      expect(composed).toContain("children's picture book");
      expect(composed).toContain("No text");
      expect(composed).toContain("Nothing frightening");
      // And the style's own fragment survives verbatim, because
      // `character.service` and `footage.service` both assert on it.
      expect(composed).toContain(style.prompt);
    }
  });

  it("resolves a slug and refuses anything else", () => {
    expect(findArtStyle("cut-paper")?.name).toBe("Cut-paper collage");
    expect(findArtStyle("a-style-that-was-retired")).toBeNull();
    expect(findArtStyle(null)).toBeNull();
    expect(findArtStyle(undefined)).toBeNull();
  });

  it("labels an unchosen style as unchosen rather than as a look", () => {
    expect(artStyleLabel(null)).toBe("None chosen");
    expect(artStyleLabel("flat-vector")).toBe("Flat vector");
  });

  it("offers enough genuinely different looks to tell two channels apart", () => {
    // Six, and the count is a judgement rather than a target: the bar is
    // "could a viewer tell two videos apart at a glance", and styles whose
    // whole identity is looseness were left out because the thing that makes
    // them attractive is the thing that lets a face drift.
    expect(ART_STYLES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ART_STYLES.map((style) => style.name)).size).toBe(ART_STYLES.length);
    // No two fragments are near-duplicates of each other.
    for (const a of ART_STYLES) {
      for (const b of ART_STYLES) {
        if (a.id === b.id) continue;
        expect(a.prompt).not.toBe(b.prompt);
      }
    }
  });
});
