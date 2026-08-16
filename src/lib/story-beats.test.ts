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
