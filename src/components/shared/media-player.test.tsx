import { describe, expect, it } from "vitest";

import { bufferedAheadOf, spokenDuration } from "@/components/shared/media-player";

/**
 * Covers the two pure functions behind `MediaPlayer` rather than the rendered
 * player: the repo's Vitest environment is `node`, so there is no DOM to render
 * into or `HTMLMediaElement` to drive. Both of these are decisions rather than
 * plumbing — what a screen reader is told the time is, and which of several
 * buffered ranges is the one worth drawing.
 */

function ranges(pairs: [number, number][]) {
  return {
    length: pairs.length,
    start: (index: number) => pairs[index][0],
    end: (index: number) => pairs[index][1],
  };
}

describe("spokenDuration", () => {
  it("says seconds on their own below a minute", () => {
    expect(spokenDuration(0)).toBe("0 seconds");
    expect(spokenDuration(1)).toBe("1 second");
    expect(spokenDuration(42)).toBe("42 seconds");
  });

  it("drops the components that are zero", () => {
    // "2 minutes 0 seconds" is noise a listener has to sit through on every
    // announcement of an exactly-round time.
    expect(spokenDuration(120)).toBe("2 minutes");
    expect(spokenDuration(3600)).toBe("1 hour");
    expect(spokenDuration(3660)).toBe("1 hour 1 minute");
  });

  it("spells out a full hours-minutes-seconds time", () => {
    expect(spokenDuration(3725)).toBe("1 hour 2 minutes 5 seconds");
  });

  it("rounds rather than truncating, so it never lags the visible clock", () => {
    expect(spokenDuration(59.6)).toBe("1 minute");
    expect(spokenDuration(0.4)).toBe("0 seconds");
  });

  it("treats a negative time as the start", () => {
    expect(spokenDuration(-5)).toBe("0 seconds");
  });
});

describe("bufferedAheadOf", () => {
  it("returns the end of the range the playhead is inside", () => {
    expect(bufferedAheadOf(ranges([[0, 30]]), 12)).toBe(30);
  });

  it("ignores ranges that do not contain the playhead", () => {
    // The seek-backwards case: the largest buffered range is behind the
    // playhead, and painting a buffered bar from it would promise footage the
    // player has not fetched.
    expect(bufferedAheadOf(ranges([[0, 100], [180, 190]]), 185)).toBe(190);
    expect(bufferedAheadOf(ranges([[0, 100], [180, 190]]), 150)).toBe(150);
  });

  it("returns the playhead when nothing is buffered, so no bar is drawn", () => {
    expect(bufferedAheadOf(ranges([]), 7)).toBe(7);
    expect(bufferedAheadOf(null, 7)).toBe(7);
    expect(bufferedAheadOf(undefined, 0)).toBe(0);
  });

  it("counts a playhead sitting exactly on a boundary as inside", () => {
    expect(bufferedAheadOf(ranges([[10, 40]]), 10)).toBe(40);
    expect(bufferedAheadOf(ranges([[10, 40]]), 40)).toBe(40);
  });
});
