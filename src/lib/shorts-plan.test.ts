import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { anchorCues, cueWindows, type ScriptCue } from "@/lib/script-cues";
import {
  describeSections,
  MAX_SHORT_SECONDS,
  MIN_SHORT_SECONDS,
  planShortBeatSlots,
  planShortSlots,
  planShortWindow,
  SHORT_MAX_CHARS_PER_LINE,
  SHORT_MAX_WORDS_PER_LINE,
  sliceAlignment,
  kineticCaptionStyle,
  verticalCaptionStyle,
  windowsOverlap,
} from "@/lib/shorts-plan";
import { KINETIC_CAPTION_FONT } from "@/lib/brand-fonts";
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

describe("planShortSlots", () => {
  /** Four sections, each five seconds long, starting at 0, 5, 10 and 15. */
  const windows = [0, 5, 10, 15].map((startSeconds) => ({
    cue: `cue ${startSeconds}`,
    startSeconds,
    endSeconds: startSeconds + 4.9,
  }));

  it("plays every section the window covers, in order", () => {
    const slots = planShortSlots(windows, { startSeconds: 0, endSeconds: 20 }, 1);

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([0, 1, 2, 3]);
  });

  it("sums to exactly the window, so the picture cannot drift off the words", () => {
    // The property the whole thing rests on. Measured between section STARTS
    // rather than as each section's own spoken length, because a window's end
    // is the end of its last character and those leave slivers uncovered —
    // slivers that make every later clip play early.
    const window = { startSeconds: 7, endSeconds: 19.5 };
    const slots = planShortSlots(windows, window, 1);
    const total = slots.reduce((sum, slot) => sum + slot.seconds, 0);

    expect(total).toBeCloseTo(window.endSeconds - window.startSeconds, 6);
  });

  it("ignores sections outside the window entirely", () => {
    const slots = planShortSlots(windows, { startSeconds: 10, endSeconds: 20 }, 1);

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([2, 3]);
    expect(slots.map((slot) => slot.seconds)).toEqual([5, 5]);
  });

  it("clips the first and last sections to the window's own edges", () => {
    const slots = planShortSlots(windows, { startSeconds: 2, endSeconds: 12 }, 1);

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([0, 1, 2]);
    // Three seconds of section 0 left, all five of section 1, two of section 2.
    expect(slots.map((slot) => slot.seconds)).toEqual([3, 5, 2]);
  });

  it("merges a sliver of a section into the clip already on screen", () => {
    // A window truncated by MAX_SHORT_SECONDS routinely lands a fraction of a
    // second into a section. A 0.2s slot is a visible flicker, and `planRender`
    // refuses one shorter than the crossfade it has to donate to — so it is
    // absorbed rather than played.
    const slots = planShortSlots(windows, { startSeconds: 0, endSeconds: 10.2 }, 1);

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([0, 1]);
    expect(slots[0].seconds).toBeCloseTo(5, 6);
    expect(slots[1].seconds).toBeCloseTo(5.2, 6);
  });

  it("absorbs a short opening section forwards, not backwards", () => {
    // There is nothing before the first slot to give it to, so it takes from
    // what follows — and the clip on screen for the merged slot is the one the
    // window actually starts on.
    const slots = planShortSlots(windows, { startSeconds: 4.6, endSeconds: 15 }, 1);

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([0, 2]);
    expect(slots.map((slot) => slot.seconds)).toEqual([5.4, 5]);
  });

  it("never drops the only slot it has, however the floor is set", () => {
    // A single slot covers the whole short, which is at least
    // MIN_SHORT_SECONDS — there is no reading under which it is too short, and
    // returning nothing would leave the composer with an empty concat list.
    const slots = planShortSlots(windows, { startSeconds: 0, endSeconds: 4 }, 30);

    expect(slots).toEqual([{ sectionIndex: 0, seconds: 4 }]);
  });

  it("returns nothing for a window no section reaches", () => {
    expect(planShortSlots([], { startSeconds: 0, endSeconds: 20 }, 1)).toEqual([]);
  });
});

describe("planShortBeatSlots", () => {
  /** The same four five-second sections the section tests above use, so the
   *  two can be compared number for number. */
  const windows = [0, 5, 10, 15].map((startSeconds) => ({
    cue: `cue ${startSeconds}`,
    startSeconds,
    endSeconds: startSeconds + 4.9,
  }));

  /** Two pictures over four sections — the illustrated shape, where a beat
   *  covers more than the sentence it opens on. */
  const paired = [{ sectionIndices: [0, 1], cues: [] }, { sectionIndices: [2, 3], cues: [] }];

  it("plays one picture per beat, not one per section", () => {
    const slots = planShortBeatSlots(windows, paired, { startSeconds: 0, endSeconds: 20 }, 1);

    // Two slots of ten seconds, where the section planner gives four of five.
    // Anything else means a beat's still would be fetched by a section index
    // and every picture after the first would be the wrong one.
    expect(slots).toEqual([
      { sectionIndex: 0, seconds: 10 },
      { sectionIndex: 1, seconds: 10 },
    ]);
  });

  it("composes a window inside one beat as a single slot", () => {
    // The case the whole path exists for: a twelve-second short over a
    // four-minute story whose pictures are twenty seconds each never leaves the
    // beat it started in, and one still holds the entire clip.
    const slots = planShortBeatSlots(windows, paired, { startSeconds: 1, endSeconds: 9 }, 1);

    expect(slots).toEqual([{ sectionIndex: 0, seconds: 8 }]);
  });

  it("sums to exactly the window, exactly as the section planner does", () => {
    const window = { startSeconds: 7, endSeconds: 19.5 };
    const slots = planShortBeatSlots(windows, paired, window, 1);
    const total = slots.reduce((sum, slot) => sum + slot.seconds, 0);

    expect(total).toBeCloseTo(window.endSeconds - window.startSeconds, 6);
  });

  it("is the identity for a shot-scripted video, where a beat is a section", () => {
    // `planStoryBeats` gives one beat per cue when the writer tagged every
    // shot, so the long-form list video's slots must come out byte-identical
    // to what the section planner produces — otherwise this path would quietly
    // re-time the format it was mostly written for.
    const perSection = windows.map((_window, index) => ({
      sectionIndices: [index],
      cues: [],
    }));
    const window = { startSeconds: 2, endSeconds: 12 };

    expect(planShortBeatSlots(windows, perSection, window, 1)).toEqual(
      planShortSlots(windows, window, 1),
    );
  });

  it("merges a sliver of a beat into the picture already on screen", () => {
    // Same floor, same absorption — the merge logic is reused untouched, and
    // this is the assertion that says so at the beat scale.
    const slots = planShortBeatSlots(
      windows,
      paired,
      { startSeconds: 0, endSeconds: 10.2 },
      1,
    );

    expect(slots.map((slot) => slot.sectionIndex)).toEqual([0]);
    expect(slots[0].seconds).toBeCloseTo(10.2, 6);
  });

  it("returns nothing for a video with no beats at all", () => {
    expect(planShortBeatSlots(windows, [], { startSeconds: 0, endSeconds: 20 }, 1)).toEqual(
      [],
    );
  });
});

describe("kineticCaptionStyle", () => {
  // The frame `buildAss` writes into its own header, and therefore the canvas
  // one style unit is measured against — unlike the SRT path, where FFmpeg's
  // synthesised 384x288 is the canvas.
  const WIDTH = 1080;
  const HEIGHT = 1920;

  it("sets the font in real pixels, not in force_style units", () => {
    const kinetic = kineticCaptionStyle(DEFAULT_STYLE.captions, WIDTH, HEIGHT);

    // 22 units at PlayResY 288 over a 1080-high reference frame is 82.5px,
    // and the boost makes it 90.75. Getting this wrong in the other direction
    // — reusing verticalCaptionStyle's 13.6 — would render 13.6px captions on
    // a 1920px-tall frame, which is legible in no sense.
    expect(kinetic.fontSize).toBeCloseTo(90.8, 1);
    expect(kinetic.fontSize).toBeGreaterThan(
      verticalCaptionStyle(DEFAULT_STYLE.captions).fontSize * 5,
    );
  });

  it("scales outline and shadow onto the same canvas as the glyphs", () => {
    const kinetic = kineticCaptionStyle(DEFAULT_STYLE.captions, WIDTH, HEIGHT);

    expect(kinetic.outline).toBeCloseTo(8.3, 1);
    expect(kinetic.shadow).toBeCloseTo(4.1, 1);
  });

  it("clears YouTube's action rail and its bottom chrome, in pixels", () => {
    const kinetic = kineticCaptionStyle(DEFAULT_STYLE.captions, WIDTH, HEIGHT);

    // 15.6% of 1080 either side, 23.6% of 1920 at the bottom — the same safe
    // area the SRT path asks for, expressed in the units this file uses.
    expect(kinetic.marginL).toBe(168);
    expect(kinetic.marginR).toBe(168);
    expect(kinetic.marginV).toBe(453);
  });

  it("keeps a channel that asked for higher captions above the floor", () => {
    const raised = { ...DEFAULT_STYLE.captions, marginV: 200 };
    const kinetic = kineticCaptionStyle(raised, WIDTH, HEIGHT);

    // 200 units is 750px, well above the 453px chrome floor.
    expect(kinetic.marginV).toBe(750);
  });

  it("uses the caption face rather than the channel's headline one", () => {
    const branded = { ...DEFAULT_STYLE.captions, fontName: "DejaVu Serif" };

    // libass falls back silently on a face it cannot resolve, so this is the
    // one field that is not the channel's to choose: a word-by-word caption in
    // a serif is not the format, and DejaVu has no weight above Bold.
    expect(kineticCaptionStyle(branded, WIDTH, HEIGHT).fontName).toBe(
      KINETIC_CAPTION_FONT,
    );
  });

  it("leaves the SRT geometry exactly as it was", () => {
    // The regression that matters: kinetic captions are a second function, and
    // an existing vertical render must still get the numbers it always did.
    const vertical = verticalCaptionStyle(DEFAULT_STYLE.captions);

    expect(vertical.fontSize).toBeCloseTo(13.6, 5);
    expect(vertical.marginL).toBe(60);
    expect(vertical.marginV).toBe(68);
  });
});
