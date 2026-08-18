import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import type { ScriptCue } from "@/lib/script-cues";
import {
  anchorCues,
  cueWindows,
  extractAnchor,
  sectionDurations,
} from "@/lib/script-cues";

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

describe("sectionDurations", () => {
  /** What the slots must always add up to: the assemble pass cuts the output
   *  at the narration's length regardless, so a total that came out long is
   *  not a longer video, it is sections playing late against their own words. */
  function total(slots: number[]): number {
    return slots.reduce((sum, seconds) => sum + seconds, 0);
  }

  it("gives each section the time its own words take when nothing is short", () => {
    expect(sectionDurations([0, 10, 20], 30, 1)).toEqual([10, 10, 10]);
  });

  it("pays for one short section out of the section after it", () => {
    // The middle section is spoken in 0.2s. Widening it to the floor takes
    // that time from its neighbour, never from the timeline.
    const slots = sectionDurations([0, 10, 10.2], 30, 1);

    expect(slots[0]).toBeCloseTo(10, 10);
    expect(slots[1]).toBeCloseTo(1, 10);
    expect(slots[2]).toBeCloseTo(19, 10);
    expect(total(slots)).toBeCloseTo(30, 10);
  });

  it("cascades a run of short sections and then stops", () => {
    // Three near-empty sections back to back — each push feeds the next, and
    // the section after the run absorbs the whole accumulated error. The
    // property that matters is that it terminates there: the fifth section is
    // the last one displaced, and a sixth would start on its own words again.
    const slots = sectionDurations([0, 5, 5.1, 5.2, 5.3], 30, 1);

    expect(slots.map((seconds) => Number(seconds.toFixed(6)))).toEqual([
      5, 1, 1, 1, 22,
    ]);
    expect(total(slots)).toBeCloseTo(30, 10);
  });

  it("keeps the last section from being squeezed to nothing by the cascade", () => {
    // The pushing alone would leave the final boundary past the narration's
    // end and the last slot negative; the backwards pass pulls the boundaries
    // in so every slot still clears the floor.
    const slots = sectionDurations([0, 9.7, 9.8, 9.9], 10, 1);

    for (const seconds of slots) {
      expect(seconds).toBeGreaterThanOrEqual(1);
    }
    expect(total(slots)).toBeCloseTo(10, 10);
  });

  it("handles an alignment whose last section starts past the stored duration", () => {
    // VoiceOver.durationSeconds is an integer column, so the alignment can
    // legitimately run a fraction of a second past the number the render
    // treats as the end.
    const slots = sectionDurations([0, 5, 10.4], 10, 1);

    expect(total(slots)).toBeCloseTo(10, 10);
    for (const seconds of slots) {
      expect(seconds).toBeGreaterThan(0);
    }
  });

  it("falls back to equal shares when no arrangement can give every section the floor", () => {
    // Twelve sections over ten seconds: the floor is unsatisfiable, so the
    // boundary repairs are abandoned for an even carve-up. It still sums to
    // the narration exactly — RenderService is what refuses a share too short
    // to carry a transition, and it says so in terms of the script.
    const slots = sectionDurations([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9.5, 9.7], 10, 1);

    expect(slots).toHaveLength(12);
    expect(new Set(slots).size).toBe(1);
    expect(total(slots)).toBeCloseTo(10, 10);
  });

  it("still covers the narration exactly in the degenerate branch, whatever the starts were", () => {
    // Deliberately pathological input: every section anchored to the same
    // character. The equal-shares branch ignores the starts entirely, which
    // is the only reason this produces anything usable at all.
    const slots = sectionDurations([4, 4, 4, 4], 6, 2);

    expect(slots).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(total(slots)).toBeCloseTo(6, 10);
  });

  it("gives a single section the whole narration", () => {
    expect(sectionDurations([0], 30, 1)).toEqual([30]);
    // Even one section can land in the degenerate branch, on a narration
    // shorter than the floor.
    expect(sectionDurations([0], 0.5, 1)).toEqual([0.5]);
  });
});

describe("cue metadata", () => {
  const content = "One two three four five. Six seven eight nine ten.";

  /** An alignment where every character is one tenth of a second, so a window's
   *  times are just its character offsets over ten. */
  function evenAlignment(text: string) {
    return {
      characters: [...text],
      characterStartTimesSeconds: [...text].map((_, index) => index / 10),
      characterEndTimesSeconds: [...text].map((_, index) => (index + 1) / 10),
    };
  }

  it("carries a beat and its emphasis from cue to window", () => {
    // The renderer needs both after the anchor is gone: the beat decides which
    // join dips through black, the emphasis colours the caption. Re-deriving
    // them later would be the orphaning problem all over again.
    const cues = [
      { anchor: "One two three four five.", cue: "a doorway", beat: "HOOK", emphasis: ["two"] },
      { anchor: "Six seven eight nine ten.", cue: "a staircase", beat: "NAME_IT", emphasis: [] },
    ];

    const { anchored } = anchorCues(cues, content);
    const windows = cueWindows(anchored, evenAlignment(content));

    expect(anchored.map((entry) => entry.beat)).toEqual(["HOOK", "NAME_IT"]);
    expect(windows.map((entry) => entry.beat)).toEqual(["HOOK", "NAME_IT"]);
    expect(windows[0].emphasis).toEqual(["two"]);
    expect(windows[1].emphasis).toEqual([]);
  });

  it("carries a shot tag from cue to window", () => {
    // The long-form plan is computed twice — once by footage.service.ts when it
    // collects, once by render.service.ts when it composes — and neither can
    // see the channel's footageStyle. The tag on the cue is the only thing both
    // of them hold, so it has to survive both hops or the two halves disagree
    // about how many pictures the video has.
    const cues: ScriptCue[] = [
      { anchor: "One two three four five.", cue: "a doorway", shot: "motion" },
      { anchor: "Six seven eight nine ten.", cue: "a staircase", shot: "still" },
    ];

    const { anchored } = anchorCues(cues, content);
    const windows = cueWindows(anchored, evenAlignment(content));

    expect(anchored.map((entry) => entry.shot)).toEqual(["motion", "still"]);
    expect(windows.map((entry) => entry.shot)).toEqual(["motion", "still"]);
  });

  it("leaves a cue without metadata exactly as it was", () => {
    // Every cue written before these formats existed has none of the fields,
    // and its anchored form must not grow an undefined key — the objects are
    // persisted as JSON and a new null in them is a diff in every stored
    // script. Asserted on the key list rather than with toBeUndefined(), which
    // passes just as happily for a key that is present and set to undefined —
    // and it is the presence, not the value, that writes the diff.
    const { anchored } = anchorCues(
      [{ anchor: "One two three four five.", cue: "a doorway" }],
      content,
    );

    expect(Object.keys(anchored[0]).sort()).toEqual([
      "cue",
      "endChar",
      "startChar",
    ]);

    const windows = cueWindows(anchored, evenAlignment(content));

    expect(Object.keys(windows[0]).sort()).toEqual([
      "cue",
      "endSeconds",
      "startSeconds",
    ]);
  });
});
