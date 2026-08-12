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
    // lossless option.
    const tags = clampTags(Array.from({ length: 60 }, (_tag, i) => `tag-number-${i}`));

    const combined = tags.join("").length;
    expect(combined).toBeLessThanOrEqual(TAGS_MAX);
    for (const tag of tags) {
      expect(tag).toMatch(/^tag-number-\d+$/);
    }
  });

  it("drops empty and whitespace-only tags", () => {
    expect(clampTags(["money", "", "   ", "debt"])).toEqual(["money", "debt"]);
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
