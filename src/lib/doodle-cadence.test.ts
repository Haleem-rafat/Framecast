import { describe, expect, it } from "vitest";

import {
  doodleCues,
  DOODLE_BEAT_MAX_SECONDS,
  DOODLE_BEAT_MIN_SECONDS,
  DOODLE_MAX_SECONDS,
  doodleCadenceInstruction,
  doodleSectionCount,
  planDoodleGeneration,
} from "@/lib/doodle-cadence";

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
  it("states the count", () => {
    expect(doodleCadenceInstruction(43)).toContain("43");
  });

  // Asking for tags is what failed in the first real generation, and
  // doodleCues now sets the shot itself. An instruction that still asked
  // would be asking the model for one more thing to get wrong.
  it("does not ask the writer to tag anything", () => {
    expect(doodleCadenceInstruction(43)).not.toContain("[still]");
  });
});

describe("doodleCues", () => {
  const section = (cue: string) => ({ text: "A figure at a desk, late.", cue });

  // The correction a real generation forced: the model returned 43 sections
  // and tagged none of them. planStoryBeats needs EVERY cue to carry a shot,
  // so the shot is set here rather than asked for.
  it("marks every cue a still, whatever the model did or did not say", () => {
    const cues = doodleCues([section("a figure at a desk"), section("a closed laptop")]);

    expect(cues.every((cue) => cue.shot === "still")).toBe(true);
  });

  // Left in the cue, "[still]" reaches the illustration prompt as literal
  // text and gets drawn.
  it("strips a tag the model volunteered rather than drawing it", () => {
    const [cue] = doodleCues([section("a figure at a desk [still]")]);

    expect(cue.cue).toBe("a figure at a desk");
    expect(cue.shot).toBe("still");
  });

  it("never reports motion, even if the model asked for it", () => {
    const [cue] = doodleCues([section("[motion] a train pulling away")]);

    expect(cue.shot).toBe("still");
    expect(cue.cue).toBe("a train pulling away");
  });

  it("anchors each cue to its section's opening words", () => {
    const [cue] = doodleCues([section("a figure at a desk")]);

    expect(cue.anchor).toBe("A figure at a desk, late.");
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

describe("doodleCues — the word the captions colour", () => {
  const section = (text: string) => ({ text, cue: "a figure at a desk" });

  // Kinetic captions colour one word per phrase. Only the insight format's
  // schema carries an emphasis field, so a doodle section's is derived.
  it("picks a content word out of the section", () => {
    const [cue] = doodleCues([section("He forgot the subscription for three years.")]);

    expect(cue.emphasis).toEqual(["subscription"]);
  });

  // Short function words carry no stress and colouring one reads as a bug.
  it("never picks a short or common word", () => {
    const [cue] = doodleCues([section("And then it was over and he was done.")]);

    expect(cue.emphasis).toBeUndefined();
  });

  it("ignores punctuation when choosing and when reporting", () => {
    const [cue] = doodleCues([section("Nobody noticed the overdraft, not once.")]);

    expect(cue.emphasis).toEqual(["overdraft"]);
  });

  // The captions match case-insensitively, so the stored word keeps the
  // section's own casing rather than being upper-cased here.
  it("keeps the word as it was written", () => {
    const [cue] = doodleCues([section("The Chancellor said nothing at all.")]);

    expect(cue.emphasis).toEqual(["Chancellor"]);
  });

  it("says nothing rather than guessing on an empty section", () => {
    const [cue] = doodleCues([section("")]);

    expect(cue.emphasis).toBeUndefined();
  });
});
