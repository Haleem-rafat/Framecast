import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { anchorCues, cueWindows, type ScriptCue } from "@/lib/script-cues";
import {
  describeSections,
  MAX_SHORT_SECONDS,
  MIN_SHORT_SECONDS,
  planShortWindow,
  SHORT_MAX_CHARS_PER_LINE,
  SHORT_MAX_WORDS_PER_LINE,
  sliceAlignment,
  verticalCaptionStyle,
  windowsOverlap,
} from "@/lib/shorts-plan";
import { DEFAULT_STYLE } from "@/lib/video-style";

/**
 * A narration where every character takes exactly `secondsPerChar`, so a
 * character offset and a timestamp are the same number scaled — which makes
 * every expectation below a value you can check by counting characters in the
 * fixture rather than by trusting the code under test.
 */
function evenAlignment(content: string, secondsPerChar = 0.1): Alignment {
  return {
    characters: [...content],
    characterStartTimesSeconds: [...content].map((_, index) =>
      Number((index * secondsPerChar).toFixed(6)),
    ),
    characterEndTimesSeconds: [...content].map((_, index) =>
      Number(((index + 1) * secondsPerChar).toFixed(6)),
    ),
  };
}

// Four sections of exactly 49 characters each — 4.9s apiece at 0.1s/char, and
// 19.9s in total once the three joining spaces are counted.
//
// Written as one flat string because that is what `content` is by the time it
// reaches here: gateway.provider.ts joins the model's sections with a single
// space (see `normalise`), and the alignment indexes that exact string.
const S1 = "Everyone thinks inflation is about prices rising.";
const S2 = "It is really about the supply of money expanding.";
const S3 = "The printing press is the clearest example here..";
const S4 = "Which is why the nineteen twenties matter so much";
const CONTENT = [S1, S2, S3, S4].join(" ");
const NARRATION_SECONDS = CONTENT.length * 0.1;

function fixtureCues(): ScriptCue[] {
  return [S1, S2, S3, S4].map((text, index) => ({
    // The same eight-word anchor `extractAnchor` derives, spelled out rather
    // than computed so a change to ANCHOR_WORDS shows up here as a failure.
    anchor: text.split(" ").slice(0, 8).join(" "),
    cue: `clip ${index + 1}`,
  }));
}

function fixtureWindows() {
  const alignment = evenAlignment(CONTENT);
  const { anchored } = anchorCues(fixtureCues(), CONTENT);
  return { alignment, anchored, windows: cueWindows(anchored, alignment) };
}

describe("the fixture itself", () => {
  it("anchors all four sections onto the narration", () => {
    // Every expectation below rests on this. A fixture whose cues silently
    // orphaned would make the rest of this file test an empty list.
    const { anchored, windows } = fixtureWindows();

    expect(anchored).toHaveLength(4);
    expect(windows[0].startSeconds).toBeCloseTo(0, 5);
    // Section 2 starts at character 50: 49 characters plus the joining space.
    expect(windows[1].startSeconds).toBeCloseTo(5, 5);
    expect(windows[2].startSeconds).toBeCloseTo(10, 5);
    expect(windows[3].startSeconds).toBeCloseTo(15, 5);
  });
});

describe("planShortWindow", () => {
  it("maps a run of sections onto the seconds they are spoken", () => {
    const { windows } = fixtureWindows();

    // Sections 2..4 (0-based 1..3): spoken from 5s to the end of the narration.
    const window = planShortWindow(windows, 1, 3, NARRATION_SECONDS);

    expect(window).not.toBeNull();
    expect(window!.startSeconds).toBeCloseTo(5, 5);
    expect(window!.endSeconds).toBeCloseTo(NARRATION_SECONDS, 5);
  });

  it("extends a run that is too short, moving only its end", () => {
    const { windows } = fixtureWindows();

    // One 5s section, well under the floor.
    const window = planShortWindow(windows, 1, 1, NARRATION_SECONDS);

    // The start stays exactly where the model put it — sliding it would move
    // the clip off the sentence that was actually chosen, which is the one
    // thing the selection is for.
    expect(window!.startSeconds).toBeCloseTo(5, 5);
    expect(window!.endSeconds - window!.startSeconds).toBeCloseTo(MIN_SHORT_SECONDS, 5);
  });

  it("truncates a run that is too long, again moving only its end", () => {
    // A narration long enough that four sections exceed the cap.
    const long = [S1, S2, S3, S4].join(" ");
    const alignment = evenAlignment(long, 0.5);
    const { anchored } = anchorCues(fixtureCues(), long);
    const windows = cueWindows(anchored, alignment);
    const narrationSeconds = long.length * 0.5;

    const window = planShortWindow(windows, 0, 3, narrationSeconds);

    expect(window!.startSeconds).toBeCloseTo(0, 5);
    expect(window!.endSeconds - window!.startSeconds).toBeCloseTo(MAX_SHORT_SECONDS, 5);
  });

  it("refuses a section number that does not exist", () => {
    const { windows } = fixtureWindows();

    // A model hallucinating "section 9" of a four-section script must produce
    // no short at all — never a short of some other, arbitrary moment.
    expect(planShortWindow(windows, 0, 8, NARRATION_SECONDS)).toBeNull();
    expect(planShortWindow(windows, -1, 2, NARRATION_SECONDS)).toBeNull();
    expect(planShortWindow(windows, 1.5, 2, NARRATION_SECONDS)).toBeNull();
  });

  it("refuses an inverted run", () => {
    const { windows } = fixtureWindows();

    expect(planShortWindow(windows, 3, 1, NARRATION_SECONDS)).toBeNull();
  });

  it("clips a window that would run past the end of the render", () => {
    const { windows } = fixtureWindows();

    // Sections 2..4 are spoken from 5s to 19.9s, but VoiceOver.durationSeconds
    // is an integer and the assemble pass cuts the render at exactly that many
    // seconds — so the last fraction of the alignment describes footage the
    // file does not contain.
    const window = planShortWindow(windows, 1, 3, 19);

    expect(window!.endSeconds).toBeCloseTo(19, 5);
  });

  it("refuses when the clip left after that is too short to be a short", () => {
    const { windows } = fixtureWindows();

    // The last section starts at 15s of a 19.9s narration. The floor would push
    // its end to 27s, the narration clips that back to 19.9, and 4.9s is not a
    // short — and there is nowhere to take the rest from without moving the
    // start off the sentence the model chose.
    expect(planShortWindow(windows, 3, 3, NARRATION_SECONDS)).toBeNull();
  });
});

describe("windowsOverlap", () => {
  it("catches any shared second", () => {
    expect(
      windowsOverlap({ startSeconds: 0, endSeconds: 20 }, { startSeconds: 19, endSeconds: 40 }),
    ).toBe(true);
  });

  it("treats touching windows as clear of each other", () => {
    // One ending exactly where the next begins shares no narration, so both
    // are keepable — refusing them would drop a legitimate back-to-back pair.
    expect(
      windowsOverlap({ startSeconds: 0, endSeconds: 20 }, { startSeconds: 20, endSeconds: 40 }),
    ).toBe(false);
  });
});

describe("sliceAlignment", () => {
  it("keeps only what is spoken inside the window and rebases it to zero", () => {
    const alignment = evenAlignment(CONTENT);
    const sliced = sliceAlignment(alignment, { startSeconds: 5, endSeconds: 10 });

    // Characters 50..99 — exactly section 2, which is what "5s to 10s" means
    // in this fixture (49 characters plus the space that joins it to section 1).
    expect(sliced.characters.join("")).toBe(CONTENT.slice(50, 100));
    expect(sliced.characterStartTimesSeconds[0]).toBeCloseTo(0, 5);
  });

  it("never emits a negative timestamp", () => {
    // The floor exists for floating point, not for logic: a character is kept
    // only when its start is at or after the window's, so the subtraction can
    // land at -1e-16 but never at a real negative. It still matters — buildSrt
    // would format that as "00:00:-0,-00", which libass drops, silently losing
    // the short's opening caption rather than failing the encode.
    const alignment = evenAlignment(CONTENT);
    const sliced = sliceAlignment(alignment, { startSeconds: 5, endSeconds: 10 });

    expect(Math.min(...sliced.characterStartTimesSeconds)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...sliced.characterEndTimesSeconds)).toBeGreaterThanOrEqual(0);
  });

  it("produces an SRT whose first cue starts at the top of the clip", () => {
    // The end-to-end property that matters: the short is encoded with `-ss`
    // before `-i`, which resets output timestamps to zero, so its captions
    // must be numbered from zero too.
    const alignment = evenAlignment(CONTENT);
    const srt = buildSrt(sliceAlignment(alignment, { startSeconds: 10, endSeconds: 15 }), 3);

    expect(srt.split("\n")[1]).toMatch(/^00:00:00,000 --> /);
    expect(srt).toContain("The printing");
  });

  it("returns an empty alignment for a window with no narration in it", () => {
    const alignment = evenAlignment(CONTENT);
    const sliced = sliceAlignment(alignment, { startSeconds: 900, endSeconds: 960 });

    // Empty rather than throwing: buildSrt answers an empty alignment with an
    // empty string, and an empty SRT burns no captions instead of failing the
    // encode.
    expect(sliced.characters).toEqual([]);
    expect(buildSrt(sliced)).toBe("");
  });

  it("skips characters the aligner left untimed", () => {
    const alignment = evenAlignment(CONTENT);
    alignment.characterStartTimesSeconds[10] = Number.NaN;

    const sliced = sliceAlignment(alignment, { startSeconds: 0, endSeconds: 5 });

    // A NaN would reach buildSrt's timestamp formatter and come out as
    // "NaN:NaN:NaN", corrupting every cue after it in the file.
    expect(sliced.characterStartTimesSeconds.every(Number.isFinite)).toBe(true);
    expect(sliced.characters).toHaveLength(49);
  });
});

describe("describeSections", () => {
  it("numbers sections from one and states how long each is spoken", () => {
    const { anchored, windows } = fixtureWindows();
    const lines = describeSections(anchored, windows, CONTENT).split("\n");

    expect(lines).toHaveLength(4);
    // 1-based, because this string is what a language model reads.
    expect(lines[0]).toMatch(/^1\. \[5\.0s\] Everyone thinks inflation/);
    expect(lines[3]).toMatch(/^4\. \[/);
  });
});

describe("verticalCaptionStyle", () => {
  it("scales the font by the frame-height ratio times the boost", () => {
    const vertical = verticalCaptionStyle(DEFAULT_STYLE.captions);

    // 22 * 1.1 * (1080/1920) = 13.61 -> 13.6. The point of the ratio is that
    // libass's PlayResY cancels out of it, so this number holds whatever
    // header FFmpeg happens to synthesise for an SRT.
    expect(vertical.fontSize).toBeCloseTo(13.6, 5);
  });

  it("scales outline and shadow with the glyphs", () => {
    const vertical = verticalCaptionStyle(DEFAULT_STYLE.captions);

    // Left alone, these would scale by the frame-height ratio (1.78x) while
    // the text scaled by only 1.1x, and the captions would come out muddy.
    expect(vertical.outline).toBeCloseTo(1.2, 5);
    expect(vertical.shadow).toBeCloseTo(0.6, 5);
  });

  it("keeps the channel's font and colours", () => {
    const branded = {
      ...DEFAULT_STYLE.captions,
      fontName: "Anton",
      primaryColour: "&H0000FFFF",
    };
    const vertical = verticalCaptionStyle(branded);

    expect(vertical.fontName).toBe("Anton");
    expect(vertical.primaryColour).toBe("&H0000FFFF");
  });
});

/**
 * The caption safe area, pinned in PIXELS.
 *
 * Every number here was measured, not derived: rendered through the worker
 * image's own FFmpeg and libass onto a flat 1080x1920 frame, and read back as
 * the bounding box of the ink. The conversion below is the only assumption, and
 * it is the one thing about `verticalCaptionStyle` that depends on the FFmpeg
 * build — so it is asserted here rather than left implicit.
 *
 * libass scales horizontal margins by `frame_width / PlayResX` and vertical
 * ones by `frame_height / PlayResY`. FFmpeg synthesises `PlayResX: 384,
 * PlayResY: 288` when it converts an SRT — confirm with
 * `ffmpeg -i captions.srt -f ass -` — so one script unit is 2.8125px across a
 * short and 6.667px up it. If a future FFmpeg changes that header, these
 * assertions still pass while the real geometry moves, which is why the numbers
 * they encode are also written down in `verticalCaptionStyle`'s comment.
 */
describe("verticalCaptionStyle safe area", () => {
  const PX_PER_UNIT_X = 1080 / 384;
  const PX_PER_UNIT_Y = 1920 / 288;
  const vertical = verticalCaptionStyle(DEFAULT_STYLE.captions);

  it("insets the line box far enough to clear the Shorts action rail", () => {
    expect(vertical.marginR).toBe(vertical.marginL);
    expect(vertical.marginL * PX_PER_UNIT_X).toBeCloseTo(168.75, 2);

    // The rail — like, dislike, comment, share, sound disc — is published at
    // 120-152px wide on a 1080px frame, and it sits at exactly the height
    // captions sit at. The line box has to end before the widest of those.
    const rightEdge = 1080 - vertical.marginR * PX_PER_UNIT_X;
    expect(rightEdge).toBeLessThan(1080 - 152);
  });

  it("leaves a line box wide enough for the longest word real narration has", () => {
    const box = 1080 - (vertical.marginL + vertical.marginR) * PX_PER_UNIT_X;
    expect(box).toBeCloseTo(742.5, 1);

    // Measured in the worker image at this exact FontSize: "indistinguishable"
    // sets 658px and its all-capitals form 788px. The first is what the boost
    // is sized against, with ~11% of the box left over. At the old 1.25x boost
    // those were 753px and 899px, in a box of 1024px that no margin narrowed.
    expect(box).toBeGreaterThan(658);
  });

  it("lifts captions above the Shorts title, description and seek bar", () => {
    // 320-350px collapsed, ~450px once a viewer opens the description. The old
    // value of 60 units put the bottom of a caption 400px up — inside it.
    expect(vertical.marginV * PX_PER_UNIT_Y).toBeCloseTo(453.3, 1);
    expect(vertical.marginV * PX_PER_UNIT_Y).toBeGreaterThan(450);
  });

  it("treats the channel's own vertical margin as a floor, not a replacement", () => {
    const raised = { ...DEFAULT_STYLE.captions, marginV: 200 };
    expect(verticalCaptionStyle(raised).marginV).toBe(200);

    const lowered = { ...DEFAULT_STYLE.captions, marginV: 5 };
    expect(verticalCaptionStyle(lowered).marginV).toBe(vertical.marginV);
  });
});

describe("SHORT_MAX_CHARS_PER_LINE", () => {
  it("fits the safe line box at the boosted font size", () => {
    // DejaVu Sans at FontSize 13.6 runs ~40px per character in sentence case,
    // measured, so the budget times that has to land inside the 742px box.
    expect(SHORT_MAX_CHARS_PER_LINE * 40).toBeLessThan(742);
  });

  it("is the limit that actually binds, not the word count", () => {
    // Three words is not a width. The pair only means something if a cue of
    // three ordinary words can still be cut short by the character budget.
    expect("understanding transformation".length).toBeGreaterThan(SHORT_MAX_CHARS_PER_LINE);
    expect("and then it".length).toBeLessThan(SHORT_MAX_CHARS_PER_LINE);
  });

  /** The text of every cue, in order — the lines libass is actually handed. */
  function cueTextOf(srt: string): string[] {
    return srt
      .trim()
      .split("\n\n")
      .map((block) => block.split("\n").slice(2).join(" "));
  }

  it("breaks a cue of long words that a three-word limit would let through", () => {
    const alignment = evenAlignment("understanding transformation opportunities");
    const budgeted = cueTextOf(
      buildSrt(alignment, SHORT_MAX_WORDS_PER_LINE, SHORT_MAX_CHARS_PER_LINE),
    );

    // 41 characters in one cue is what libass turned into a three-row tower up
    // the middle of the frame; each of these is one row.
    expect(cueTextOf(buildSrt(alignment, SHORT_MAX_WORDS_PER_LINE))).toEqual([
      "understanding transformation opportunities",
    ]);
    expect(budgeted).toEqual(["understanding", "transformation", "opportunities"]);
  });

  it("leaves a word longer than the budget alone rather than emitting a blank cue", () => {
    // There is nothing to split it against, and a zero-word cue would render as
    // an empty subtitle and put the word on its own line anyway.
    const srt = buildSrt(
      evenAlignment("an indistinguishable result"),
      SHORT_MAX_WORDS_PER_LINE,
      SHORT_MAX_CHARS_PER_LINE,
    );

    expect(cueTextOf(srt)).toEqual(["an", "indistinguishable", "result"]);
    expect(srt).not.toMatch(/\n\n\n/);
  });

  it("changes nothing for a caller that does not ask for a budget", () => {
    // The landscape render calls buildSrt with one argument. Its output has to
    // be byte-for-byte what it was.
    const alignment = evenAlignment("understanding transformation opportunities today");

    expect(buildSrt(alignment)).toBe(buildSrt(alignment, 6, Number.POSITIVE_INFINITY));
  });
});
