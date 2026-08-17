import { describe, expect, it } from "vitest";

import {
  BANNED_PHRASES,
  MAX_WORDS_PER_SCENE,
  validateInsightScript,
  type InsightScene,
  type InsightScript,
} from "@/lib/insight-script";

/**
 * The gate that runs before anything is billed.
 *
 * Every assertion here is a real failure this format has: a sentence that grew
 * a second clause, a beat out of order, a stressed word that is not in the
 * line. The point of each is that it fails *cheaply*, with a sentence the model
 * can act on, rather than surfacing as a video that reads wrong.
 */

function scene(overrides: Partial<InsightScene> & { id: number }): InsightScene {
  return {
    beat: "MECHANISM",
    duration: 4,
    narration: "Your brain keeps an open file for anything unfinished.",
    caption: "AN OPEN FILE",
    visualBrief: "A woman stops halfway up a staircase, looking back down.",
    emphasis: [],
    ...overrides,
  };
}

/** A script that passes everything, as the baseline each test breaks one rule
 *  of. Six beats, in order, and a word count that matches its durations. */
function validScript(): InsightScript {
  // 106 words across twelve scenes. At 2.6 words a second that is 40.8s, which
  // is exactly 12 × 3.4 — so the baseline has no timing drift and every test
  // below is failing the one rule it means to.
  const lines: [string, string][] = [
    ["HOOK", "You forgot the task you finished this morning."],
    ["HOOK", "You still remember the one you did not."],
    ["TENSION", "It is two in the morning and you are awake."],
    ["TENSION", "The email you never sent is still in the room."],
    ["MECHANISM", "Your brain keeps an open file for anything unfinished."],
    ["MECHANISM", "An open file stays loud until something closes it."],
    ["MECHANISM", "That kept your ancestors returning to the work that mattered."],
    ["NAME_IT", "Psychologists call this the Zeigarnik effect."],
    ["TURN", "Write down the next single step before you sleep."],
    ["TURN", "The file closes and the room finally goes quiet."],
    ["LOOP", "Your memory is not broken at all."],
    ["LOOP", "It is waiting to be told that you are done."],
  ];

  return {
    conceptName: "Zeigarnik effect",
    scenes: lines.map(([beat, narration], index) =>
      scene({ id: index + 1, beat, narration, duration: 3.4 }),
    ),
  };
}

describe("validateInsightScript", () => {
  it("passes a script that follows the format", () => {
    const result = validateInsightScript(validScript());

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses narration outside the word budget", () => {
    const short = validScript();
    short.scenes = short.scenes.slice(0, 3);

    const result = validateInsightScript(short);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/words/i);
  });

  it("catches every banned phrase, from the exported list", () => {
    // Reads BANNED_PHRASES rather than restating it, so a phrase added to the
    // module is covered here without anybody remembering to add it twice.
    for (const phrase of BANNED_PHRASES) {
      const script = validScript();
      script.scenes[4].narration = `Well ${phrase} it stays open.`;

      const result = validateInsightScript(script);

      expect(result.ok, `"${phrase}" was not caught`).toBe(false);
      expect(result.errors.some((error) => error.includes(phrase))).toBe(true);
    }
  });

  it("refuses a sentence that has grown a second clause", () => {
    const script = validScript();
    script.scenes[4].narration = Array.from(
      { length: MAX_WORDS_PER_SCENE + 1 },
      () => "word",
    ).join(" ");

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Scene 5 is 17 words/);
  });

  it("refuses a scene that is too short or too long to cut on", () => {
    const brief = validScript();
    brief.scenes[2].duration = 1.2;

    expect(validateInsightScript(brief).ok).toBe(false);

    const long = validScript();
    long.scenes[2].duration = 9;

    expect(validateInsightScript(long).ok).toBe(false);
  });

  it("refuses a dash, which is a second clause wearing punctuation", () => {
    const script = validScript();
    script.scenes[4].narration = "Your brain keeps a file — and it stays open.";

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/dash/i);
  });

  it("refuses an emoji", () => {
    const script = validScript();
    script.scenes[4].narration = "Your brain keeps an open file 🧠";

    expect(validateInsightScript(script).ok).toBe(false);
  });

  it("refuses a scene with nothing to burn on screen", () => {
    const script = validScript();
    script.scenes[4].caption = "   ";

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/no caption/i);
  });

  it("refuses a stressed word that is not in the line", () => {
    // Silently dropping it would make the voice setting look applied when it
    // was not — the failure mode is a video that sounds flat for no visible
    // reason.
    const script = validScript();
    script.scenes[4].emphasis = ["dopamine"];

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/dopamine/);
  });

  it("accepts a stressed word regardless of case", () => {
    const script = validScript();
    script.scenes[7].emphasis = ["ZEIGARNIK"];

    expect(validateInsightScript(script).ok).toBe(true);
  });

  it("refuses a script missing one of the six beats", () => {
    const script = validScript();
    script.scenes = script.scenes.filter((entry) => entry.beat !== "NAME_IT");

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/NAME_IT/);
  });

  it("refuses beats that run out of order", () => {
    // A MECHANISM after the payoff is a script that has lost its own shape.
    const script = validScript();
    script.scenes[9].beat = "MECHANISM";

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/in order/i);
  });

  it("allows one beat to span several scenes", () => {
    // The baseline already does this — two HOOK scenes, three MECHANISM. The
    // rule is about interleaving, not about one scene per beat.
    expect(validateInsightScript(validScript()).ok).toBe(true);
  });

  it("catches a script whose timings do not match its words", () => {
    const script = validScript();
    for (const entry of script.scenes) entry.duration = 4.9;

    const result = validateInsightScript(script);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/takes about/);
  });

  it("writes errors a model can act on", () => {
    const script = validScript();
    script.scenes[4].narration = "Studies show your brain keeps an open file.";

    const result = validateInsightScript(script);

    for (const error of result.errors) {
      // Appended verbatim to a retry prompt, so each has to be a whole
      // instruction rather than a code.
      expect(error.trim()).toMatch(/\.$/);
      expect(error.length).toBeGreaterThan(20);
    }
  });
});
