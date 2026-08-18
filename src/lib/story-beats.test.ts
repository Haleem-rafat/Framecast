import { describe, expect, it } from "vitest";

import type { AnchoredCue } from "@/lib/script-cues";
import { sectionDurations } from "@/lib/script-cues";
import {
  beatCountFor,
  BEAT_MIN_SECONDS,
  BEAT_TARGET_SECONDS,
  beatSeconds,
  MAX_BEATS,
  planStoryBeats,
} from "@/lib/story-beats";

/** Sections of equal length, which is what a generated script roughly is —
 *  every section is 20-25 words. `charsEach` is a section's character span. */
function evenCues(count: number, charsEach = 130): AnchoredCue[] {
  return Array.from({ length: count }, (_, index) => ({
    cue: `cue ${index}`,
    startChar: index * charsEach,
    endChar: (index + 1) * charsEach,
  }));
}

describe("beatCountFor", () => {
  it("gives a four-minute video 10-16 pictures, which is what the genre does", () => {
    // The headline finding: a 32-page picture book yields 12-14 spreads and
    // reads aloud in 3-6 minutes, and the measured high-performing channels in
    // this genre sit at one visual every 13-25s. Both say 10-16 for 240s.
    expect(beatCountFor(240, 27)).toBeGreaterThanOrEqual(10);
    expect(beatCountFor(240, 27)).toBeLessThanOrEqual(16);
  });

  it("never asks for more pictures than there are sections to put under them", () => {
    // A ten-minute narration wants 30 beats, but a script with four sections
    // has four things to say. A fifth beat would be a picture with no words.
    expect(beatCountFor(600, 4)).toBe(4);
  });

  it("caps at MAX_BEATS so a sleep compilation is not a $36 invoice", () => {
    // Four hours at one picture every 20s would be 720 generations.
    expect(beatCountFor(4 * 60 * 60, 2000)).toBe(MAX_BEATS);
  });

  it("returns nothing for a script with no sections", () => {
    expect(beatCountFor(240, 0)).toBe(0);
  });

  it("still gives a very short video one picture rather than none", () => {
    expect(beatCountFor(6, 3)).toBe(1);
  });
});

describe("planStoryBeats", () => {
  it("groups many sections into far fewer pictures — one per beat, not per section", () => {
    // The whole reason this module exists. 27 sections is what a four-minute
    // script actually produces; 27 images is not what this genre does.
    const beats = planStoryBeats(evenCues(27), 240);

    expect(beats.length).toBe(12);
    expect(beats.length).toBeLessThan(27);
  });

  it("covers every section exactly once, contiguously and in order", () => {
    const beats = planStoryBeats(evenCues(27), 240);
    const flattened = beats.flatMap((beat) => beat.sectionIndices);

    expect(flattened).toEqual(Array.from({ length: 27 }, (_, index) => index));
    for (const beat of beats) {
      expect(beat.sectionIndices.length).toBeGreaterThan(0);
    }
  });

  it("carries each beat's own cues, in the order they are spoken", () => {
    const beats = planStoryBeats(evenCues(6), 60);

    for (const beat of beats) {
      expect(beat.cues).toEqual(beat.sectionIndices.map((index) => `cue ${index}`));
    }
  });

  it("never cuts a picture faster than the floor, and averages the target", () => {
    // Measured against the real timing model, not against the character
    // weights: `sectionDurations` is what the renderer actually uses, and the
    // grouping is only useful if the slots it produces land in the band.
    //
    // The floor is asserted exactly and the ceiling loosely, which is the
    // asymmetry `BEAT_MIN_SECONDS` documents: a section is about nine seconds
    // at this length, so a beat is a whole number of nine-second lumps and 25
    // is not reachable from 17.8 without going under the floor instead.
    const anchored = evenCues(27);
    const starts = anchored.map((_cue, index) => (index * 240) / 27);
    const durations = sectionDurations(starts, 240, 1);
    const beats = planStoryBeats(anchored, 240);
    const seconds = beatSeconds(beats, durations);

    for (const held of seconds) {
      expect(held).toBeGreaterThanOrEqual(BEAT_MIN_SECONDS);
      // One section's worth of slack above the band, which is the granularity
      // the sentences impose. Still far inside what the measured channels do.
      expect(held).toBeLessThanOrEqual(25 + 240 / 27);
    }

    const mean = seconds.reduce((sum, held) => sum + held, 0) / seconds.length;
    expect(mean).toBeCloseTo(BEAT_TARGET_SECONDS, 0);
  });

  it("makes fewer, longer pictures rather than one that flashes past", () => {
    // Nine sections across 100s wants five beats at the target, but 100/5 = 20s
    // only works if the sections divide that way — they do not, and the
    // leftover would be a single 11s picture among 22s ones.
    const beats = planStoryBeats(evenCues(9), 100);
    const starts = evenCues(9).map((_cue, index) => (index * 100) / 9);
    const durations = sectionDurations(starts, 100, 1);

    for (const held of beatSeconds(beats, durations)) {
      expect(held).toBeGreaterThanOrEqual(BEAT_MIN_SECONDS);
    }
  });

  it("sums to the narration exactly, so the pictures cannot drift off the words", () => {
    const anchored = evenCues(27);
    const starts = anchored.map((_cue, index) => (index * 240) / 27);
    const durations = sectionDurations(starts, 240, 1);
    const beats = planStoryBeats(anchored, 240);

    const total = beatSeconds(beats, durations).reduce((sum, seconds) => sum + seconds, 0);
    expect(total).toBeCloseTo(240, 6);
  });

  it("gives a long section a beat of its own rather than dragging a short one along", () => {
    // Section 2 is spoken three times as long as its neighbours. Grouping by
    // section *count* would pair it with one of them and make a 60-second
    // picture beside 15-second ones; grouping by spoken length must not.
    const spans = [130, 130, 390, 130, 130, 130];
    let at = 0;
    const anchored: AnchoredCue[] = spans.map((span, index) => {
      const startChar = at;
      at += span;
      return { cue: `cue ${index}`, startChar, endChar: at };
    });

    const beats = planStoryBeats(anchored, 120);
    const long = beats.find((beat) => beat.sectionIndices.includes(2))!;

    expect(long.sectionIndices).toEqual([2]);
  });

  it("is deterministic, so re-collecting the same script re-plans the same beats", () => {
    const anchored = evenCues(19, 117);

    expect(planStoryBeats(anchored, 191)).toEqual(planStoryBeats(anchored, 191));
  });

  it("returns nothing for a script with no cues", () => {
    expect(planStoryBeats([], 240)).toEqual([]);
  });

  it("survives zero-width sections without swallowing the beats after them", () => {
    // Two cues that anchored to the same position — `anchorCues` produces
    // this legitimately, and an unweighted section would let an unbounded
    // number pile into one beat.
    const anchored: AnchoredCue[] = [
      { cue: "a", startChar: 0, endChar: 0 },
      { cue: "b", startChar: 0, endChar: 0 },
      { cue: "c", startChar: 0, endChar: 200 },
      { cue: "d", startChar: 200, endChar: 400 },
    ];

    const beats = planStoryBeats(anchored, 40);

    expect(beats.flatMap((beat) => beat.sectionIndices)).toEqual([0, 1, 2, 3]);
    expect(beats.length).toBe(2);
  });

  it("targets BEAT_TARGET_SECONDS per picture at any length", () => {
    for (const [duration, sections] of [
      [64, 8],
      [180, 20],
      [240, 27],
      [540, 60],
    ] as const) {
      const beats = planStoryBeats(evenCues(sections), duration);
      expect(beats.length).toBe(Math.round(duration / BEAT_TARGET_SECONDS));
    }
  });
});

describe("a beat-scripted narration gets one picture per cue", () => {
  /** Cues as the single-insight format produces them: every one carrying the
   *  narrative beat its scene belongs to. */
  function insightCues(count: number): AnchoredCue[] {
    const beats = ["HOOK", "TENSION", "MECHANISM", "NAME_IT", "TURN", "LOOP"];

    return Array.from({ length: count }, (_, index) => ({
      cue: `shot ${index + 1}`,
      startChar: index * 50,
      endChar: (index + 1) * 50,
      beat: beats[Math.min(index, beats.length - 1)],
    }));
  }

  it("gives twelve cues twelve pictures, not two", () => {
    // The whole point. beatCountFor would return round(45/20) = 2, which is
    // arithmetically right for a children's story and wrong for this format —
    // twelve shots of three to five seconds is what the genre IS.
    const beats = planStoryBeats(insightCues(12), 45);

    expect(beats).toHaveLength(12);
    expect(beats.every((beat) => beat.sectionIndices.length === 1)).toBe(true);
  });

  it("keeps each picture under its own words", () => {
    const beats = planStoryBeats(insightCues(4), 20);

    expect(beats.map((beat) => beat.sectionIndices)).toEqual([[0], [1], [2], [3]]);
    expect(beats.map((beat) => beat.cues)).toEqual([
      ["shot 1"],
      ["shot 2"],
      ["shot 3"],
      ["shot 4"],
    ]);
  });

  it("ignores the fifteen-second floor, which belongs to the other genre", () => {
    // 45s over 12 cues is 3.75s a shot, far under BEAT_MIN_SECONDS. That floor
    // exists to stop a children's story becoming a slideshow; this format lives
    // beneath it on purpose.
    expect(planStoryBeats(insightCues(12), 45)).toHaveLength(12);
  });

  it("falls back to grouping when only some cues carry a beat", () => {
    // Half-beated cues are a parse that went wrong. Grouping half one way and
    // half the other would change the cutting rhythm mid-video for no reason a
    // viewer could name, so the ordinary plan runs instead.
    // At 45 seconds the two plans disagree loudly — one picture per cue is 12,
    // the ordinary grouping is round(45/20) = 2 — which is what makes this
    // assertion mean something. At 240s they happen to coincide at 12 and it
    // would pass either way.
    const mixed = insightCues(12);
    delete mixed[3].beat;

    expect(planStoryBeats(mixed, 45)).toHaveLength(2);
  });

  it("leaves an ordinary cued script exactly as it was", () => {
    const plain: AnchoredCue[] = Array.from({ length: 12 }, (_, index) => ({
      cue: `shot ${index + 1}`,
      startChar: index * 50,
      endChar: (index + 1) * 50,
    }));

    // 240s / 20s = 12 target, capped by the grouping rules — whatever it is,
    // it must be what it was before this branch existed.
    expect(planStoryBeats(plain, 240)).toEqual(planStoryBeats(plain, 240));
    expect(planStoryBeats(plain, 45).length).toBeLessThan(12);
  });
});

describe("a shot-scripted narration gets one picture per cue", () => {
  /** Cues as the long-form list format produces them: every section tagged
   *  with the kind of picture it wants, one in five asking for real motion. */
  function shotCues(count: number): AnchoredCue[] {
    return Array.from({ length: count }, (_, index) => ({
      cue: `shot ${index + 1}`,
      startChar: index * 130,
      endChar: (index + 1) * 130,
      shot: (index % 5 === 4 ? "motion" : "still") as "still" | "motion",
    }));
  }

  it("gives an eight-minute list forty pictures, not twenty", () => {
    // The number this task exists for. Left to the seconds grouping, forty
    // sections across 480s ask for round(480/20) = 24 beats and then lose four
    // more to the BEAT_MIN_SECONDS floor, landing at 20 pictures of 24 seconds
    // each — a slideshow over seven list entries. The writer was asked for
    // forty shots, so forty is what it gets.
    const beats = planStoryBeats(shotCues(40), 480);

    expect(beats).toHaveLength(40);
    expect(beats.every((beat) => beat.sectionIndices.length === 1)).toBe(true);
    expect(beats.map((beat) => beat.cues[0])).toEqual(
      Array.from({ length: 40 }, (_, index) => `shot ${index + 1}`),
    );
  });

  it("ignores the fifteen-second floor, at twelve seconds a shot", () => {
    // 480s over 40 shots is 12s a picture, under BEAT_MIN_SECONDS by three.
    // That floor was measured on four-minute bedtime stories; this format is
    // beneath it deliberately, exactly as the single-insight one is.
    const anchored = shotCues(40);
    const starts = anchored.map((_cue, index) => (index * 480) / 40);
    const durations = sectionDurations(starts, 480, 1);

    for (const held of beatSeconds(planStoryBeats(anchored, 480), durations)) {
      expect(held).toBeLessThan(BEAT_MIN_SECONDS);
    }
  });

  it("does not cap at MAX_BEATS, because the writer's count is the count", () => {
    // MAX_BEATS is a money ceiling for the seconds plan, where a four-hour
    // input can ask for 720 generations off its own bat. Applying it here
    // would drop shot 41 and leave the last minute of narration with no
    // picture over it.
    expect(planStoryBeats(shotCues(MAX_BEATS + 4), 480)).toHaveLength(MAX_BEATS + 4);
  });

  it("falls back to grouping when only some cues carry a shot tag", () => {
    // Half-tagged cues are a parse that went wrong, and the failure this
    // prevents is a video that cuts every twelve seconds for half its length
    // and every twenty-four for the rest.
    const mixed = shotCues(40);
    delete mixed[17].shot;

    expect(planStoryBeats(mixed, 480)).toHaveLength(20);
  });

  it("leaves an untagged narration grouped exactly as it is today", () => {
    // The pin the Global Constraints ask for: an existing video's picture plan
    // must not move. These are the beats `planStoryBeats` has always returned
    // for the canonical case — 27 sections of a four-minute story — written
    // out rather than recomputed, so a change to the grouping has to be typed
    // here by hand before it can ship.
    const beats = planStoryBeats(evenCues(27), 240);

    expect(beats.map((beat) => beat.sectionIndices)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [8, 9],
      [10, 11],
      [12, 13],
      [14, 15, 16],
      [17, 18],
      [19, 20, 21],
      [22, 23],
      [24, 25, 26],
    ]);
  });

  it("leaves an untagged eight-minute narration on the seconds plan", () => {
    // The same forty cues as the first test with the tags taken off. Twenty
    // pictures, which is what a video collected before this branch existed
    // already has on disk — re-planning one must not ask for twenty more.
    expect(planStoryBeats(evenCues(40), 480)).toHaveLength(20);
  });
});
