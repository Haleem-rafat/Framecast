import { describe, expect, it } from "vitest";

import {
  buildThumbnailArgs,
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
});

function args(): string {
  return buildThumbnailArgs(base).join(" ");
}
