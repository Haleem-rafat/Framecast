import { describe, expect, it } from "vitest";

import {
  countUntaggedCues,
  DOODLE_BEAT_MAX_SECONDS,
  DOODLE_BEAT_MIN_SECONDS,
  DOODLE_MAX_SECONDS,
  doodleCadenceInstruction,
  doodleSectionCount,
  planDoodleGeneration,
} from "@/lib/doodle-cadence";
import type { ScriptCue } from "@/lib/script-cues";

const cue = (shot?: "still" | "motion"): ScriptCue => ({
  anchor: "a b c d e f g h",
  cue: "a stick figure at a desk",
  ...(shot ? { shot } : {}),
});

describe("doodleSectionCount", () => {
  it("is the duration divided by the cadence", () => {
    expect(doodleSectionCount(300, 7)).toBe(43);
    expect(doodleSectionCount(300, 20)).toBe(15);
    expect(doodleSectionCount(300, 5)).toBe(60);
  });

  // The worst case the boundary allows, and the number the spec's cost table
  // is built on: 60 pictures is about $3.00.
  it("never exceeds the count the fastest allowed cadence gives", () => {
    const worst = doodleSectionCount(DOODLE_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS);

    expect(worst).toBe(60);
    expect(doodleSectionCount(DOODLE_MAX_SECONDS, DOODLE_BEAT_MAX_SECONDS)).toBeLessThan(worst);
  });

  // A one-section video is still a video; a zero-section video is a request
  // for a script with nothing in it.
  it("never returns less than one", () => {
    expect(doodleSectionCount(1, 20)).toBe(1);
    expect(doodleSectionCount(0, 20)).toBe(1);
  });
});

describe("doodleCadenceInstruction", () => {
  it("states the count and the tagging rule", () => {
    const instruction = doodleCadenceInstruction(43);

    expect(instruction).toContain("43");
    expect(instruction).toContain("[still]");
  });

  // The failure this whole warning path exists for: one missing tag drops the
  // video from 43 pictures to 15. The model has to be told what it costs.
  it("says what a missing tag costs", () => {
    expect(doodleCadenceInstruction(43)).toMatch(/every section/i);
  });
});

describe("countUntaggedCues", () => {
  it("is zero when every cue carries a tag", () => {
    expect(countUntaggedCues([cue("still"), cue("still")])).toBe(0);
  });

  it("counts the ones that do not", () => {
    expect(countUntaggedCues([cue("still"), cue(), cue("still"), cue()])).toBe(2);
  });

  // An empty script is not a partly tagged one. planStoryBeats' isShotScripted
  // returns false for an empty array too, but for a different reason, and
  // reporting "0 of 0 sections untagged" as a warning would be noise.
  it("is zero for an empty script", () => {
    expect(countUntaggedCues([])).toBe(0);
  });
});

describe("planDoodleGeneration", () => {
  const plan = (over: Partial<Parameters<typeof planDoodleGeneration>[0]> = {}) =>
    planDoodleGeneration({
      footageStyle: "DOODLE",
      beatSeconds: 7,
      declaredMinutes: "5",
      ...over,
    });

  it("says nothing at all about a channel that is not DOODLE", () => {
    expect(plan({ footageStyle: "ILLUSTRATED" })).toBeNull();
    expect(plan({ footageStyle: "LIVE_ACTION", beatSeconds: null })).toBeNull();
  });

  it("asks for the section count the cadence implies", () => {
    const result = plan();

    expect(result).toEqual({ ok: true, instruction: expect.stringContaining("43") });
  });

  // Null is a real state, not a gap to fill with a default: a default would
  // pick a rhythm for a channel that never asked for one.
  it("refuses a doodle channel that has chosen no cadence", () => {
    const result = plan({ beatSeconds: null });

    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.reason).toMatch(/seconds per picture/i);
  });

  // The cap is what bounds the spend, because planStoryBeats deliberately does
  // not apply MAX_BEATS on the tagged path.
  it("refuses a video past the length cap", () => {
    const result = plan({ declaredMinutes: "12" });

    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.reason).toMatch(/5 minutes/);
  });

  it("accepts exactly the cap", () => {
    expect(plan({ declaredMinutes: "5" })?.ok).toBe(true);
  });

  it("refuses a duration that is not a number at all", () => {
    expect(plan({ declaredMinutes: undefined })?.ok).toBe(false);
    expect(plan({ declaredMinutes: "soon" })?.ok).toBe(false);
    expect(plan({ declaredMinutes: "0" })?.ok).toBe(false);
  });
});
