import { describe, expect, it } from "vitest";

import {
  buildThumbnailArgs,
  fitHeadline,
  HEADLINE_MIN_FONT_SIZE,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
} from "@/lib/thumbnail-command";

const brand = { primaryColour: "#FFCC00", headlineFont: "DejaVu Sans" };
const base = {
  imagePath: "/tmp/image.png",
  outputPath: "/tmp/thumb.jpg",
  headline: "Money is weirder than you think",
  brand,
};

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildThumbnailArgs", () => {
  it("outputs at YouTube's thumbnail size", () => {
    const filter = args();
    expect(filter).toContain(`scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`);
    expect(filter).toContain(`crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`);
  });

  it("draws the headline rather than asking the model to render it", () => {
    // Image models misspell, invent glyphs and break kerning. Every AI
    // thumbnail that looks professional has its text composited.
    expect(args()).toContain("drawtext=");
    expect(args()).toContain("Money is weirder");
  });

  it("escapes a headline containing filter-graph syntax", () => {
    const built = buildThumbnailArgs({
      ...base,
      headline: "Inflation: what it costs, really",
    });

    // A bare colon ends the drawtext option and a bare apostrophe ends the
    // quoted value — either turns a headline into a broken FFmpeg command.
    const graph = valueOf(built, "-vf") ?? "";
    expect(graph).toContain("\\:");
  });

  it("overlays the logo only when there is one", () => {
    expect(buildThumbnailArgs({ ...base, logoPath: "/tmp/logo.png" }).join(" ")).toContain(
      "overlay",
    );
    expect(buildThumbnailArgs(base).join(" ")).not.toContain("overlay");
  });

  it("writes a JPEG at a quality that stays under YouTube's 2MB cap", () => {
    const built = buildThumbnailArgs(base);
    expect(valueOf(built, "-q:v")).toBeDefined();
    expect(built.at(-1)).toBe("/tmp/thumb.jpg");
  });

  it("disables drawtext's expansion parser so a literal percent survives", () => {
    // With the default expansion=normal, a bare `%` (and even the
    // documented `%%` escape for one) makes real ffmpeg log "Stray %" and
    // silently drop the whole headline -- verified against both 5.1.10 and
    // 8.0.1. expansion=none is what stops that, not any escaping of `%`.
    const graph = valueOf(buildThumbnailArgs({ ...base, headline: "Down 40% today" }), "-vf") ?? "";
    expect(graph).toContain("expansion=none");
  });

  it("escapes several filter-graph characters together with the two-pass rule", () => {
    const built = buildThumbnailArgs({
      ...base,
      headline: "Tesla's Inflation: down big, up [2026] really",
    });
    const graph = valueOf(built, "-vf") ?? "";

    // Two-pass escaping needs a different backslash count per character:
    // the option-value pass (colon, quote) is re-escaped by the outer
    // filter-description pass (which owns comma/brackets too), so a colon
    // survives as two backslashes and a quote as three, while a character
    // that is only special to the outer pass -- comma, bracket -- gets one.
    // Reverting to a single combined pass (one backslash for every special
    // character, escaped once) produces a different string and fails this.
    const backslash = "\\";
    const expectedApostrophe = `${backslash.repeat(3)}'`;
    const expectedColon = `${backslash.repeat(2)}:`;
    const expectedComma = `${backslash},`;
    const expectedOpenBracket = `${backslash}[`;
    const expectedCloseBracket = `${backslash}]`;

    const expectedText =
      `Tesla${expectedApostrophe}s Inflation${expectedColon}` +
      ` down big${expectedComma} up ${expectedOpenBracket}` +
      `2026${expectedCloseBracket} really`;

    expect(graph).toContain(`text=${expectedText}:`);
  });

  it("falls back to a safe colour when primaryColour is not a plain hex value", () => {
    // ResolvedBrand.primaryColour is an unvalidated `String?` column. A
    // stored value like "white:x=0" would otherwise reach fontcolor= as
    // valid FFmpeg syntax that also happens to inject new drawtext options.
    const built = buildThumbnailArgs({
      ...base,
      brand: { ...brand, primaryColour: "white:x=0" },
    });
    const graph = valueOf(built, "-vf") ?? "";

    expect(graph).not.toContain("white:x=0");
    expect(graph).toContain("fontcolor=#FFFFFF");
  });
});

describe("fitHeadline", () => {
  // Independent of whatever ratio or padding budget the implementation
  // uses internally: DejaVu Sans upper-case glyphs measured empirically at
  // roughly 0.62 x fontsize wide against real ffmpeg, and drawtext's
  // box=1 draws 24px of padding on every side of the text on top of that
  // (see boxborderw at the buildThumbnailArgs call site). If a fitted
  // headline's box would exceed THUMBNAIL_WIDTH under those numbers, it
  // silently runs off the frame in the real render -- ffmpeg does not
  // error on an off-frame drawtext box, it just clips it.
  const WORST_CASE_CHAR_WIDTH_RATIO = 0.62;
  const BOX_PADDING_PER_SIDE = 24;

  const headlines = [
    "Short",
    "Money is weirder than you think",
    "BREAKING: INFLATION DESTROYS AMERICAN RETIREMENT",
    "Everything Changed When Washington Announced",
    "WHY NOBODY WANTS TO WORK ANYMORE",
    "A".repeat(300),
  ];

  it.each(headlines)("keeps the headline's box inside the frame: %s", (headline) => {
    const { text, fontSize } = fitHeadline(headline);
    const boxWidth =
      fontSize * text.length * WORST_CASE_CHAR_WIDTH_RATIO + BOX_PADDING_PER_SIDE * 2;

    expect(boxWidth).toBeLessThanOrEqual(THUMBNAIL_WIDTH);
  });

  it("does not clamp an undersized fit back up past the point it still fits", () => {
    // The previous version used Math.max(HEADLINE_MIN_FONT_SIZE, fitted),
    // which forces a too-small fontSize back up to the minimum and
    // overflows the frame by construction for any headline long enough to
    // need it. A long headline must come back at exactly the minimum, not
    // above it.
    const { fontSize } = fitHeadline("A".repeat(300));
    expect(fontSize).toBe(HEADLINE_MIN_FONT_SIZE);
  });

  it("truncates rather than overflowing when even the minimum size won't hold the string", () => {
    const { text } = fitHeadline("A".repeat(300));
    expect(text.length).toBeLessThan(300);
    expect(text.endsWith("…")).toBe(true);
  });

  it("leaves a short headline untouched at the maximum size", () => {
    const { text, fontSize } = fitHeadline("Short");
    expect(text).toBe("Short");
    expect(fontSize).toBeGreaterThan(HEADLINE_MIN_FONT_SIZE);
  });
});

function args(): string {
  return buildThumbnailArgs(base).join(" ");
}
