import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { anchorCues, cueWindows, extractAnchor } from "@/lib/script-cues";

/** Every character takes exactly 0.1s, mirroring captions.test.ts's fixture. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

describe("extractAnchor", () => {
  it("takes the first eight words", () => {
    const anchor = extractAnchor("one two three four five six seven eight nine ten");
    expect(anchor).toBe("one two three four five six seven eight");
  });

  it("takes the whole section when it is shorter than eight words", () => {
    expect(extractAnchor("short section here")).toBe("short section here");
  });

  it("collapses runs of whitespace so a reflowed edit still matches", () => {
    expect(extractAnchor("one   two\nthree")).toBe("one two three");
  });
});

describe("anchorCues", () => {
  const content = "Inflation is not prices going up. It is money losing value over time.";

  it("locates each anchor and runs each section to the next", () => {
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { anchor: "It is money losing value over", cue: "printing press" },
      ],
      content,
    );

    expect(orphaned).toEqual([]);
    expect(anchored[0].cue).toBe("supermarket shelves");
    expect(anchored[0].startChar).toBe(0);
    // The first section ends where the second begins.
    expect(anchored[0].endChar).toBe(anchored[1].startChar);
    // The last section runs to the end of the content.
    expect(anchored[1].endChar).toBe(content.length);
  });

  it("orphans a cue whose opening was rewritten, keeping the others", () => {
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { anchor: "This sentence is not in the content", cue: "printing press" },
      ],
      content,
    );

    expect(anchored.map((a) => a.cue)).toEqual(["supermarket shelves"]);
    expect(orphaned.map((o) => o.cue)).toEqual(["printing press"]);
  });

  it("does not let a repeated phrase capture an earlier cue", () => {
    // "the same words" appears twice; the second cue must match the SECOND
    // occurrence, because its search starts after the first anchor ended.
    const repeated = "the same words appear here and then the same words appear again";
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "the same words", cue: "first" },
        { anchor: "the same words", cue: "second" },
      ],
      repeated,
    );

    expect(orphaned).toEqual([]);
    expect(anchored[0].startChar).toBe(0);
    expect(anchored[1].startChar).toBe(repeated.lastIndexOf("the same words"));
  });

  it("returns nothing to anchor when there are no cues", () => {
    expect(anchorCues([], content)).toEqual({ anchored: [], orphaned: [] });
  });

  it("orphans a cue with an empty anchor instead of matching it in place", () => {
    // extractAnchor on an empty or whitespace-only section returns "".
    // content.indexOf("", searchFrom) matches immediately without consuming
    // anything, so an empty anchor would otherwise land on the same
    // position as the cue after it rather than claiming any text of its own.
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "", cue: "blank" },
        { anchor: "It is money losing value over", cue: "printing press" },
      ],
      content,
    );

    expect(anchored.map((a) => a.cue)).toEqual(["printing press"]);
    expect(orphaned.map((o) => o.cue)).toEqual(["blank"]);
  });
});

describe("cueWindows", () => {
  it("converts character ranges into the times those characters are spoken", () => {
    const content = "abcdefghij";
    const windows = cueWindows(
      [
        { cue: "first", startChar: 0, endChar: 5 },
        { cue: "second", startChar: 5, endChar: 10 },
      ],
      evenAlignment(content),
    );

    // 0.1s per character: chars 0-4 span 0.0s to 0.5s.
    expect(windows[0]).toEqual({ cue: "first", startSeconds: 0, endSeconds: 0.5 });
    expect(windows[1]).toEqual({ cue: "second", startSeconds: 0.5, endSeconds: 1 });
  });

  it("clamps a range that runs past the alignment rather than returning NaN", () => {
    // A shorter alignment than the content can happen if narration was
    // regenerated from an edited script; a clip of NaN length would kill FFmpeg.
    const windows = cueWindows(
      [{ cue: "only", startChar: 0, endChar: 100 }],
      evenAlignment("abcde"),
    );

    expect(windows[0].endSeconds).toBe(0.5);
    expect(Number.isFinite(windows[0].startSeconds)).toBe(true);
  });

  it("does not invert the window for a zero-width character range", () => {
    // A pause between characters 4 and 5: char 4 ends at 0.4s but char 5
    // doesn't start until 0.9s. A zero-width range sitting at that boundary
    // (startChar === endChar === 5, which anchorCues can produce for an
    // empty anchor) must not read back through the pause to char 4's end
    // time and report a window that ends before it starts.
    const alignment: Alignment = {
      characters: [..."abcdefghij"],
      characterStartTimesSeconds: [0, 0.1, 0.2, 0.3, 0.4, 0.9, 1.0, 1.1, 1.2, 1.3],
      characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5, 1.0, 1.1, 1.2, 1.3, 1.4],
    };
    const windows = cueWindows([{ cue: "empty", startChar: 5, endChar: 5 }], alignment);

    expect(windows[0].endSeconds).toBeGreaterThanOrEqual(windows[0].startSeconds);
  });
});
