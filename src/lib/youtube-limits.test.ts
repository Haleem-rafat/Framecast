import { describe, expect, it } from "vitest";

import {
  clampDescription,
  clampTags,
  clampTitle,
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
