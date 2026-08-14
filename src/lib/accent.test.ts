import { describe, expect, it } from "vitest";

import {
  ACCENTS,
  ACCENT_ORDER,
  DEFAULT_ACCENT,
  MIN_NON_TEXT_CONTRAST,
  MIN_TEXT_CONTRAST,
  STUDIO_BACKGROUND,
  accentStyleSheet,
  contrastRatio,
  formatOklch,
  isInGamut,
  relativeLuminance,
  resolveAccent,
} from "@/lib/accent";

/**
 * This file is the accessibility guarantee, not a description of it.
 *
 * src/lib/accent.ts claims every accent clears 4.5:1 on its own foreground in
 * both themes. Nothing enforces that at runtime — the palette is frozen
 * constants, so there is no input to validate. The enforcement is here: the
 * ratios are recomputed from the stored numbers, so an accent added or nudged
 * without re-solving its lightness fails the build's test run rather than
 * shipping an unreadable button.
 */

const THEMES = ["light", "dark"] as const;

describe("contrastRatio", () => {
  /**
   * Anchors the maths against values WCAG fixes by definition, so a transposed
   * matrix coefficient in `oklchToLinearSrgb` cannot pass unnoticed while every
   * accent below still "clears" a ratio computed the same wrong way.
   */
  it("gives 21:1 for black on white and 1:1 for a colour on itself", () => {
    const white = [1, 0, 0] as const;
    const black = [0, 0, 0] as const;

    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    const a = [0.517, 0.145, 250] as const;
    const b = [0.985, 0, 0] as const;

    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("puts pure white and pure black at the ends of the luminance range", () => {
    expect(relativeLuminance([1, 0, 0])).toBeCloseTo(1, 3);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 3);
  });
});

describe("every accent is readable", () => {
  for (const name of ACCENT_ORDER) {
    const definition = ACCENTS[name];

    for (const theme of THEMES) {
      const tokens = definition[theme];

      // The headline requirement: a button label on a button fill. Both halves
      // come from this file, so this ratio is the one an operator actually sees.
      it(`${name} ${theme}: button text clears ${MIN_TEXT_CONTRAST}:1`, () => {
        const ratio = contrastRatio(tokens.primary, tokens.primaryForeground);

        expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      });

      // The hover/selected surface carries text too — a dropdown item under the
      // cursor, the active sidebar row — so it is held to the same 4.5:1.
      it(`${name} ${theme}: hover-surface text clears ${MIN_TEXT_CONTRAST}:1`, () => {
        const ratio = contrastRatio(tokens.surface, tokens.surfaceForeground);

        expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      });

      it(`${name} ${theme}: every token is inside the sRGB gamut`, () => {
        // An out-of-gamut oklch is clipped by the browser to a colour that is
        // not the one measured above, which would quietly falsify every ratio
        // in this file.
        for (const [token, colour] of Object.entries(tokens)) {
          expect(isInGamut(colour), `${token} = ${formatOklch(colour)}`).toBe(
            true,
          );
        }
      });
    }
  }
});

describe("focus rings are visible against the page", () => {
  /**
   * GRAPHITE is excluded, and the exclusion is the point rather than a
   * loophole: its ring is globals.css's `oklch(0.708 0 0)`, which measures
   * 2.59:1 on white and so does not meet SC 1.4.11 today. This feature does not
   * introduce that and must not silently change it — GRAPHITE emits no CSS at
   * all, by design, so that an operator who has never chosen an accent sees the
   * studio exactly as it shipped. Fixing the monochrome ring is a separate
   * change to globals.css, which this work does not own.
   *
   * Every accent that *does* emit CSS replaces that ring and is held to 3:1.
   */
  const emitted = ACCENT_ORDER.filter((name) => name !== DEFAULT_ACCENT);

  it("has ten accents to check", () => {
    expect(emitted).toHaveLength(10);
  });

  for (const name of emitted) {
    for (const theme of THEMES) {
      it(`${name} ${theme}: ring clears ${MIN_NON_TEXT_CONTRAST}:1 on the page`, () => {
        const ratio = contrastRatio(
          ACCENTS[name][theme].ring,
          STUDIO_BACKGROUND[theme],
        );

        expect(ratio).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);
      });
    }
  }

  it("improves on the monochrome ring it replaces", () => {
    // Not a vanity check: it records that adopting an accent is never a
    // regression in focus visibility, which is the one way this feature could
    // have made the studio less accessible than it was.
    const graphite = contrastRatio(
      ACCENTS.GRAPHITE.light.ring,
      STUDIO_BACKGROUND.light,
    );

    for (const name of ACCENT_ORDER.filter((one) => one !== DEFAULT_ACCENT)) {
      expect(
        contrastRatio(ACCENTS[name].light.ring, STUDIO_BACKGROUND.light),
      ).toBeGreaterThan(graphite);
    }
  });
});

describe("accentStyleSheet", () => {
  it("emits nothing for the default, so an untouched studio is untouched", () => {
    expect(accentStyleSheet(DEFAULT_ACCENT)).toBe("");
  });

  it("falls back to the default for a value that is not an accent", () => {
    // The column is enum-typed, so this is defence against a hand-edited row or
    // a stale value rather than an expected path — but rendering
    // `oklch(undefined)` into the page would break every token at once.
    expect(resolveAccent("CHARTREUSE")).toBe(DEFAULT_ACCENT);
    expect(resolveAccent(null)).toBe(DEFAULT_ACCENT);
    expect(accentStyleSheet("CHARTREUSE")).toBe("");
  });

  it("scopes each theme so exactly one rule can ever match", () => {
    const css = accentStyleSheet("BLUE");

    // Both selectors are (0,2,0), which beats globals.css's `:root` and `.dark`
    // at (0,1,0) regardless of which stylesheet the browser parsed first.
    expect(css).toContain(":root:not(.dark){");
    expect(css).toContain(":root.dark{");
    expect(css.match(/:root/g)).toHaveLength(2);
  });

  it("overrides both the studio and the sidebar tokens in each theme", () => {
    const css = accentStyleSheet("EMERALD");

    for (const token of [
      "--primary",
      "--primary-foreground",
      "--ring",
      "--accent",
      "--accent-foreground",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
      "--sidebar-accent",
      "--sidebar-accent-foreground",
      "--sidebar-ring",
    ]) {
      // Once per theme block.
      expect(css.split(`${token}:`)).toHaveLength(3);
    }
  });

  it("never touches --destructive, whatever the accent", () => {
    // Red means "this deletes something" and has to keep meaning that even for
    // an operator whose accent is itself red.
    for (const name of ACCENT_ORDER) {
      expect(accentStyleSheet(name)).not.toContain("--destructive");
    }
  });

  it("emits the dark sidebar's foreground as near-black, not near-white", () => {
    // globals.css pairs `--sidebar-primary-foreground: oklch(0.985 0 0)` with a
    // near-white `--sidebar-primary` in dark. An accent makes that fill a mid
    // colour, so leaving the foreground alone would be white on lime.
    const css = accentStyleSheet("LIME");
    const dark = css.slice(css.indexOf(":root.dark{"));

    expect(dark).toContain("--sidebar-primary-foreground:oklch(0.205 0 0)");
  });

  it("produces CSS with no interpolated text beyond the frozen palette", () => {
    // The accent reaches this function from a database column and is rendered
    // into a <style> tag verbatim, so it must be impossible for anything other
    // than the numbers in this module to end up there.
    expect(accentStyleSheet("<script>alert(1)</script>")).toBe("");
    expect(accentStyleSheet("TEAL")).toMatch(/^[a-z0-9:().,{}\-;# ]+$/);
  });
});
