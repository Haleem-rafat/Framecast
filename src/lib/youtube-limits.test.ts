import { describe, expect, it } from "vitest";

import {
  clampDescription,
  clampTags,
  clampTitle,
  composeDescription,
  DESCRIPTION_MAX,
  TAGS_MAX,
  TITLE_MAX,
  withinLimits,
} from "@/lib/youtube-limits";

describe("clampTitle", () => {
  it("leaves a title that already fits", () => {
    expect(clampTitle("How inflation actually works")).toBe(
      "How inflation actually works",
    );
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const title = clampTitle(`${"word ".repeat(40)}end`);

    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    // Cutting mid-word reads as a bug to a viewer; cutting at a space reads as
    // a short title.
    expect(title.endsWith(" ")).toBe(false);
    expect(title).not.toMatch(/wor$/);
  });

  it("falls back to a hard cut when there is no space to cut at", () => {
    const title = clampTitle("x".repeat(200));
    expect(title).toHaveLength(TITLE_MAX);
  });

  it("removes trailing spaces when cutting at word boundary", () => {
    // When multiple spaces land at the cut boundary, truncateOnWord leaves a
    // trailing space if not trimmed: "word " + spaces + cut point. This would read
    // as trailing off, not intentionally short. Test forces truncation at TITLE_MAX
    // with double space positioned to leave trailing space without trimEnd().
    const title = clampTitle("word ".repeat(19) + "     " + "x".repeat(50));
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    // Result must not end with space, even though the raw truncation would.
    expect(title.endsWith(" ")).toBe(false);
  });
});

describe("clampDescription", () => {
  it("leaves a description that already fits", () => {
    expect(clampDescription("This is a short description")).toBe(
      "This is a short description",
    );
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const description = clampDescription(`${"word ".repeat(1000)}end`);

    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(description.endsWith(" ")).toBe(false);
  });

  it("falls back to a hard cut when there is no space to cut at", () => {
    const description = clampDescription("x".repeat(6000));
    expect(description).toHaveLength(DESCRIPTION_MAX);
  });
});

describe("clampTags", () => {
  it("keeps tags whose combined length fits", () => {
    expect(clampTags(["money", "inflation", "economics"])).toEqual([
      "money",
      "inflation",
      "economics",
    ]);
  });

  it("drops whole tags from the end rather than truncating one", () => {
    // A truncated tag is a different, meaningless tag. Dropping is the only
    // lossless option. Measure the joined form as YouTube does, not bare sum.
    const tags = clampTags(Array.from({ length: 60 }, (_tag, i) => `tag-number-${i}`));

    const joined = tags.join(",");
    expect(joined.length).toBeLessThanOrEqual(TAGS_MAX);
    for (const tag of tags) {
      expect(tag).toMatch(/^tag-number-\d+$/);
    }
  });

  it("drops empty and whitespace-only tags", () => {
    expect(clampTags(["money", "", "   ", "debt"])).toEqual(["money", "debt"]);
  });

  it("measures tags in comma-separated form, not bare sum", () => {
    // This test demonstrates the critical bug: naive bare-sum measurement fails.
    // YouTube counts tags as a comma-separated string: "tag0,tag1,tag2,...".
    // With 126 three-character tags:
    // - Bare sum: 126 * 3 = 378 chars (passes the naive TAGS_MAX check)
    // - Comma-joined: 378 + 125 commas = 503 chars (exceeds TAGS_MAX of 500)
    // The old code would keep all 126; the corrected code should keep exactly 125.
    const tags = Array.from({ length: 126 }, (_, i) => {
      const n = i.toString().padStart(2, "0");
      return `t${n}`;
    });

    const result = clampTags(tags);
    const joined = result.join(",");

    // The joined form must fit within the limit.
    expect(joined.length).toBeLessThanOrEqual(TAGS_MAX);
    // Confirm we had to drop at least one tag to meet the joined-form limit.
    expect(result.length).toBeLessThan(126);
  });
});

describe("withinLimits", () => {
  it("accepts a compliant set", () => {
    expect(
      withinLimits({ title: "Short", description: "Body", tags: ["a", "b"] }),
    ).toBe(true);
  });

  it("rejects an over-long description", () => {
    expect(
      withinLimits({
        title: "Short",
        description: "x".repeat(DESCRIPTION_MAX + 1),
        tags: [],
      }),
    ).toBe(false);
  });
});

/**
 * The credits block, in the shape `buildDescription` in publish.service.ts
 * actually produces one: a SOURCES list, the Pixabay line, then the music
 * line. Written out in full rather than stubbed with "credits", because the
 * property under test is that these exact lines survive intact.
 */
const CREDITS = [
  "SOURCES",
  "- https://example.com/federal-reserve-report",
  "- https://example.com/inflation-study",
  "",
  "Video clips courtesy of Pixabay (https://pixabay.com).",
  "",
  'Music: "Test Track" by Artist (https://creativecommons.org/licenses/by/3.0/)',
].join("\n");

describe("composeDescription", () => {
  it("puts the summary first and the credits after it", () => {
    const result = composeDescription("Inflation is money losing value.", CREDITS);

    // The whole point of the reorder: YouTube shows roughly the first 150
    // characters in search results and above the fold, and what sat there was
    // a Pixabay credit list rather than a word about the video.
    expect(result.indexOf("Inflation is money losing value.")).toBe(0);
    expect(result.indexOf("SOURCES")).toBeGreaterThan(
      result.indexOf("Inflation is money losing value."),
    );
    expect(result).toBe(`Inflation is money losing value.\n\n${CREDITS}`);
  });

  it("cuts the summary, never the credits, when the two together exceed the cap", () => {
    // Comfortably over on its own, so the clamp genuinely has to fire.
    const summary = "word ".repeat(1200);

    const result = composeDescription(summary, CREDITS);

    expect(result.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    // Every credit line, character for character — not just "contains
    // Pixabay", which a half-truncated attribution block would also satisfy.
    expect(result.endsWith(CREDITS)).toBe(true);
    for (const line of CREDITS.split("\n").filter(Boolean)) {
      expect(result).toContain(line);
    }
    // And the summary is the part that gave way.
    expect(result.startsWith("word word")).toBe(true);
    expect(result.length).toBeLessThan(summary.length + CREDITS.length);
  });

  it("cuts the summary on a word boundary, not mid-word", () => {
    const summary = "supercalifragilistic ".repeat(400);

    const result = composeDescription(summary, CREDITS);
    const summaryPart = result.slice(0, result.length - CREDITS.length - 2);

    expect(summaryPart.endsWith("supercalifragilistic")).toBe(true);
  });

  it("returns the credits alone when there is no generated summary", () => {
    expect(composeDescription(null, CREDITS)).toBe(CREDITS);
    expect(composeDescription(undefined, CREDITS)).toBe(CREDITS);
    expect(composeDescription("   ", CREDITS)).toBe(CREDITS);
  });

  it("returns the credits alone when they leave no room for a summary", () => {
    // Attribution wins outright: there is no arrangement here that fits both,
    // and dropping a licence line to make space for prose is not one of the
    // options.
    const hugeCredits = `${"SOURCES\n"}${"- https://example.com/a\n".repeat(300)}`;
    expect(hugeCredits.length).toBeGreaterThan(DESCRIPTION_MAX);

    const result = composeDescription("A summary nobody will see.", hugeCredits);

    expect(result).not.toContain("A summary nobody will see.");
    expect(result.startsWith("SOURCES")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it("returns the summary alone when there are no credits to owe", () => {
    expect(composeDescription("Just the summary.", "")).toBe("Just the summary.");
  });

  it("never exceeds the cap, whichever side is oversized", () => {
    const cases: Array<[string, string]> = [
      ["x".repeat(DESCRIPTION_MAX * 2), CREDITS],
      ["Short summary.", "y".repeat(DESCRIPTION_MAX * 2)],
      ["x".repeat(DESCRIPTION_MAX), "y".repeat(DESCRIPTION_MAX)],
    ];

    for (const [summary, credits] of cases) {
      expect(composeDescription(summary, credits).length).toBeLessThanOrEqual(
        DESCRIPTION_MAX,
      );
    }
  });
});
