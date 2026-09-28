import { describe, expect, it } from "vitest";

import {
  checkEnding,
  checkShortLength,
  checkHookCard,
  checkShortScript,
  isShortTarget,
  nextEndingKind,
  shortInstruction,
} from "@/lib/short-script";

describe("isShortTarget", () => {
  it("gates the insight format, 45 seconds and a one-minute duration", () => {
    expect(isShortTarget({ format: "insight" })).toBe(true);
    expect(isShortTarget({ seconds: "45" })).toBe(true);
    expect(isShortTarget({ duration: "1" })).toBe(true);
  });

  it("never gates long-form, five minutes, or a script with no length", () => {
    expect(isShortTarget({ format: "longform", seconds: "45" })).toBe(false);
    expect(isShortTarget({ duration: "5" })).toBe(false);
    expect(isShortTarget({ seconds: "300" })).toBe(false);
    expect(isShortTarget({})).toBe(false);
  });

  it("does not gate a length it cannot read", () => {
    expect(isShortTarget({ duration: "about five" })).toBe(false);
  });
});

describe("nextEndingKind", () => {
  it("starts on LOOP and alternates", () => {
    expect(nextEndingKind(null)).toBe("LOOP");
    expect(nextEndingKind("LOOP")).toBe("DEBATE");
    expect(nextEndingKind("DEBATE")).toBe("LOOP");
  });
});

describe("shortInstruction", () => {
  it("lists the channel's recent openings and the chosen ending", () => {
    const text = shortInstruction(["Did you know Rome fell? It did."], "DEBATE");

    expect(text).toContain("- Did you know Rome fell?");
    expect(text).toContain("ENDING: debate");
    expect(text).toContain("hook_card");
  });

  it("omits the recent block for a channel's first short", () => {
    expect(shortInstruction([], "LOOP")).not.toContain("Recent videos");
  });
});

describe("checkHookCard", () => {
  const narration = "Marcus Aurelius handed Rome to a lunatic. More follows.";

  it("requires a card", () => {
    expect(checkHookCard(undefined, narration)).toHaveLength(1);
    expect(checkHookCard("  ", narration)).toHaveLength(1);
  });

  it("refuses one word, seven words and emoji", () => {
    expect(checkHookCard("ROME", narration)).toHaveLength(1);
    expect(checkHookCard("one two three four five six seven", narration)).toHaveLength(1);
    expect(checkHookCard("ROME FELL 💀", narration)).toHaveLength(1);
  });

  it("refuses a card that repeats the first sentence", () => {
    expect(checkHookCard("Marcus Aurelius handed Rome to a lunatic.", narration)).toContain(
      "The hook_card repeats the first sentence. Say the hook a different way.",
    );
  });

  it("refuses a formula opener", () => {
    expect(checkHookCard("Did you know this", narration)).toHaveLength(1);
  });

  it("accepts a short standalone card", () => {
    expect(checkHookCard("THE WISE MAN'S WORST CHOICE", narration)).toEqual([]);
  });
});

describe("checkEnding", () => {
  it("refuses a question and a call to action", () => {
    expect(checkEnding("Rome fell. Was he wrong?")).toHaveLength(1);
    expect(checkEnding("Rome fell. Comment what you think.")).toHaveLength(1);
    expect(checkEnding("Rome fell. Follow for part two.")).toHaveLength(1);
  });

  it("accepts a flat verdict", () => {
    expect(checkEnding("Rome fell. He knew better and did it anyway.")).toEqual([]);
  });

  it("does not mistake a word that merely contains an ask", () => {
    expect(checkEnding("The emperors that followed were worse.")).toEqual([]);
  });
});

describe("checkShortScript", () => {
  it("collects hook, freshness, card and ending problems together", () => {
    const result = checkShortScript({
      narration: "Did you know Rome fell? Subscribe for more.",
      hookCard: undefined,
      recentOpenings: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("passes a script that follows every rule", () => {
    expect(
      checkShortScript({
        narration: "Marcus Aurelius handed Rome to a lunatic. He knew better and did it anyway.",
        hookCard: "THE WISE MAN'S WORST CHOICE",
        recentOpenings: ["China burned the largest fleet on earth."],
      }),
    ).toEqual({ ok: true, errors: [] });
  });
});

describe("checkShortLength", () => {
  const short = "Marcus Aurelius handed Rome to a lunatic. He knew better.";
  const long = Array.from({ length: 160 }, () => "word").join(" ");

  it("refuses a narration under sixty seconds when that length was asked for", () => {
    expect(checkShortLength(short, 75)).toHaveLength(1);
    expect(checkShortLength(short, 75)[0]).toContain("no retention");
  });

  it("accepts one that clears the floor", () => {
    expect(checkShortLength(long, 75)).toEqual([]);
  });

  it("leaves a deliberately shorter target alone", () => {
    expect(checkShortLength(short, 30)).toEqual([]);
    expect(checkShortLength(short, undefined)).toEqual([]);
  });
});
