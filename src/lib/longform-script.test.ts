import { describe, expect, it } from "vitest";

import { BANNED_PHRASES } from "@/lib/insight-script";
import {
  checkLongformScript,
  longformCues,
  MAX_MOTION_SHARE,
  MAX_SECTIONS,
  MAX_WORDS_PER_SECTION,
  MIN_SECTIONS,
  MIN_WORDS_PER_SECTION,
  readShotTag,
  type LongformSection,
} from "@/lib/longform-script";

/**
 * Thirty words, which is the middle of the band and what eight minutes over
 * forty sections actually works out to. `seed` only varies the opening so
 * every section anchors to a different phrase, exactly as a real script does.
 */
function narration(seed: number): string {
  return (
    `Section ${seed} opens on something specific ` +
    "and then says the one fact that earns its place before moving on to " +
    "the detail nobody watching would have expected to hear at all."
  );
}

function sections(
  count: number,
  motionAt: readonly number[] = [],
): LongformSection[] {
  return Array.from({ length: count }, (_, index) => ({
    text: narration(index),
    cue: `subject number ${index} [${motionAt.includes(index) ? "motion" : "still"}]`,
  }));
}

describe("readShotTag", () => {
  it("takes the tag off the end and hands back the query alone", () => {
    // The end is where the prompt asks for it, so this is the shape every
    // well-behaved answer takes.
    expect(readShotTag("crowd crossing a street [motion]")).toEqual({
      cue: "crowd crossing a street",
      shot: "motion",
    });
  });

  it("accepts the tag on the front, and in round brackets", () => {
    // Not tidiness. The tag is a convention stated in a prompt rather than a
    // field a schema enforces, and a model that leads with (motion) has done
    // what it was asked. Losing the video fourteen slots over a punctuation
    // choice would be this module's own bug, not the writer's.
    expect(readShotTag("(motion) traffic at dusk")).toEqual({
      cue: "traffic at dusk",
      shot: "motion",
    });
    expect(readShotTag("[Still] antique map on a desk")).toEqual({
      cue: "antique map on a desk",
      shot: "still",
    });
  });

  it("leaves an untagged cue alone rather than guessing at one", () => {
    expect(readShotTag("antique map on a desk")).toEqual({
      cue: "antique map on a desk",
    });
    // A word that is not one of the two is not a tag. Guessing here would
    // hide the missing tag from checkLongformScript, which is the one thing
    // that can report it.
    expect(readShotTag("printing press [wide]")).toEqual({
      cue: "printing press [wide]",
    });
  });

  it("returns an empty query for a cue that was only a tag", () => {
    // Which is a section with no picture, and the check below refuses it.
    expect(readShotTag("[still]")).toEqual({ cue: "", shot: "still" });
  });
});

describe("checkLongformScript", () => {
  it("passes a forty-section script with eight motion tags", () => {
    const result = checkLongformScript(sections(40, [2, 7, 12, 17, 22, 27, 32, 37]));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes at both ends of the section band", () => {
    expect(checkLongformScript(sections(MIN_SECTIONS)).ok).toBe(true);
    expect(checkLongformScript(sections(MAX_SECTIONS)).ok).toBe(true);
  });

  it("refuses a script that stopped short, and says how many it wrote", () => {
    // Twenty sections over eight minutes is a picture every twenty-four
    // seconds, which is the slideshow this whole format exists to stop.
    const result = checkLongformScript(sections(20));

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("20 sections");
    expect(result.errors[0]).toContain(String(MIN_SECTIONS));
    expect(result.errors[0]).toContain(String(MAX_SECTIONS));
  });

  it("refuses a script with more sections than the band", () => {
    const result = checkLongformScript(sections(MAX_SECTIONS + 1));

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(`${MAX_SECTIONS + 1} sections`);
  });

  it("names every untagged section in one sentence, not one each", () => {
    // The failure this module exists for: isShotScripted is an `every`, so a
    // single untagged cue drops the video from forty slots to twenty-four —
    // it renders, it costs less, and it looks worse, with nothing downstream
    // able to tell it apart from a script that never had shots.
    const script = sections(40);
    script[3].cue = "a crowd at a market";
    script[9].cue = "hands sorting coffee beans";

    const result = checkLongformScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2 section(s) carry no shot tag: 4, 10");
  });

  it("refuses a section that is too short or too long", () => {
    const script = sections(40);
    script[0].text = "Far too short.";
    script[1].text = Array.from(
      { length: MAX_WORDS_PER_SECTION + 5 },
      (_, index) => `word${index}`,
    ).join(" ");

    const result = checkLongformScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      `Section 1 is 3 words. Every section must run between ` +
        `${MIN_WORDS_PER_SECTION} and ${MAX_WORDS_PER_SECTION}.`,
      `Section 2 is ${MAX_WORDS_PER_SECTION + 5} words. Every section must run ` +
        `between ${MIN_WORDS_PER_SECTION} and ${MAX_WORDS_PER_SECTION}.`,
    ]);
  });

  it("refuses a cue that is a tag and nothing else", () => {
    const script = sections(40);
    script[5].cue = "[motion]";

    const result = checkLongformScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Section 6 has no visual cue");
  });

  it("applies the banned phrases the insight format already lists", () => {
    // Imported rather than restated: a copy in the test would keep passing
    // forever after somebody edited only the copy.
    for (const phrase of BANNED_PHRASES) {
      const script = sections(40);
      script[0].text = `${narration(0)} And ${phrase} as well.`;

      const result = checkLongformScript(script);

      expect(result.ok, `"${phrase}" was not caught`).toBe(false);
      expect(result.errors).toContain(
        `Remove the phrase "${phrase}". It is banned in this format.`,
      );
    }
  });

  it("does not refuse a script for tagging too much motion", () => {
    // The cap is enforced by trimming, in longformCues. A rule the code fixes
    // silently must not also spend a second four-cent generation.
    expect(checkLongformScript(sections(40, [...Array(20).keys()])).ok).toBe(true);
  });
});

describe("longformCues", () => {
  it("carries the query and the tag onto one cue per section", () => {
    const cues = longformCues(sections(40, [1]));

    expect(cues).toHaveLength(40);
    expect(cues[1]).toEqual({
      anchor: "Section 1 opens on something specific and then",
      cue: "subject number 1",
      shot: "motion",
    });
    expect(cues[0].shot).toBe("still");
  });

  it("tags every cue, so the whole script stays shot-scripted", () => {
    // planStoryBeats switches on `every(cue => Boolean(cue.shot))`. A cue that
    // fell back to a still has to say "still" out loud rather than say
    // nothing, or the trim below would take the video off the very path it
    // was written for.
    const cues = longformCues(sections(40, [...Array(20).keys()]));

    expect(cues.every((cue) => cue.shot !== undefined)).toBe(true);
  });

  it("trims twenty motion tags out of forty down to fourteen", () => {
    const cues = longformCues(sections(40, [...Array(20).keys()]));
    const motion = cues.filter((cue) => cue.shot === "motion");

    expect(motion).toHaveLength(Math.floor(40 * MAX_MOTION_SHARE));
    expect(motion).toHaveLength(14);
  });

  it("keeps the first tags in cue order rather than choosing between them", () => {
    // Deterministic on purpose: nothing here can rank two cues, and a script
    // generated twice has to produce the same video twice.
    const cues = longformCues(sections(40, [...Array(20).keys()]));

    expect(
      cues.map((cue, index) => (cue.shot === "motion" ? index : null)).filter(
        (index) => index !== null,
      ),
    ).toEqual([...Array(14).keys()]);
  });

  it("leaves a script inside the cap exactly as its writer tagged it", () => {
    const cues = longformCues(sections(40, [2, 7, 12, 17, 22, 27, 32, 37]));

    expect(
      cues.map((cue, index) => (cue.shot === "motion" ? index : null)).filter(
        (index) => index !== null,
      ),
    ).toEqual([2, 7, 12, 17, 22, 27, 32, 37]);
  });

  it("strips the tag off the stored cue, so nothing searches for the word", () => {
    const cues = longformCues(sections(40, [3]));

    for (const cue of cues) {
      expect(cue.cue).not.toContain("[");
      expect(cue.cue).not.toContain("motion");
      expect(cue.cue).not.toContain("still");
    }
  });
});
