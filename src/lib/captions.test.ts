import { describe, expect, it } from "vitest";

import { buildSrt, type Alignment } from "@/lib/captions";

/** Builds an alignment where every character takes exactly 0.1s. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

describe("buildSrt", () => {
  it("emits numbered cues with SRT timestamps", () => {
    const srt = buildSrt(evenAlignment("hello world"), 2);

    expect(srt).toContain("1\n");
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
    expect(srt).toContain("hello world");
  });

  it("breaks into multiple cues past the word limit", () => {
    const srt = buildSrt(evenAlignment("one two three four"), 2);

    expect(srt).toContain("1\n");
    expect(srt).toContain("2\n");
  });

  it("starts the first cue at the first character's time", () => {
    expect(buildSrt(evenAlignment("hi"), 5)).toContain("00:00:00,000 -->");
  });

  it("breaks at sentence end even below the word limit", () => {
    const srt = buildSrt(evenAlignment("Stop. Go on now"), 10);

    // "Stop." should close its own cue rather than running into "Go".
    expect(srt.split("\n\n").filter(Boolean).length).toBeGreaterThan(1);
  });

  it("returns an empty string for an empty alignment", () => {
    expect(
      buildSrt({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] }),
    ).toBe("");
  });

  it("formats hours, minutes and milliseconds correctly", () => {
    const characters = ["a", "b"];
    const srt = buildSrt({
      characters,
      characterStartTimesSeconds: [3661.5, 3661.6],
      characterEndTimesSeconds: [3661.6, 3661.75],
    });

    expect(srt).toContain("01:01:01,500 --> 01:01:01,750");
  });

  it("collapses consecutive whitespace instead of emitting empty words", () => {
    // Multiple spaces/newlines between words must not produce zero-length
    // "words" that would otherwise show up as stray blank tokens in a cue.
    const srt = buildSrt(evenAlignment("hello   \n\t  world"), 5);

    expect(srt).toContain("hello world");
    expect(srt).not.toMatch(/hello  +world/);
  });

  it("returns an empty string for a string that is entirely whitespace", () => {
    // No non-whitespace character ever opens a `current` word, so this must
    // behave the same as a genuinely empty alignment rather than throwing.
    expect(buildSrt(evenAlignment("   \n\t  "))).toBe("");
  });

  it("handles alignment arrays shorter than the characters array", () => {
    // A malformed/truncated alignment (start/end arrays not matching
    // characters.length) must not throw; missing times fall back rather than
    // reading `undefined` into the timestamp formatter.
    const alignment: Alignment = {
      characters: ["h", "i"],
      characterStartTimesSeconds: [0],
      characterEndTimesSeconds: [0.1],
    };

    expect(() => buildSrt(alignment)).not.toThrow();
    expect(buildSrt(alignment)).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
  });

  it("builds a single-character word with no whitespace at all", () => {
    // Smallest possible non-empty input: one character, never terminated by
    // whitespace, must still close out as a word when characters run out.
    const srt = buildSrt(evenAlignment("a"));

    expect(srt).toContain("a");
    expect(srt).toContain("00:00:00,000 --> 00:00:00,100");
  });

  it("passes through characters meaningful inside an SRT file verbatim", () => {
    // Cue text is not escaped: arrows, digits-only lines, and blank-line
    // sequences in the *source* text could in principle be confused with SRT
    // structure. buildSrt does not attempt to sanitize this — it just must
    // not crash or corrupt the surrounding cue numbering/timestamps.
    const text = "-->\n1\n\nreal talk";
    const srt = buildSrt(evenAlignment(text), 10);

    expect(srt).toContain("-->");
    expect(srt).toContain("real talk");
    // The literal cue index for the first (and only, given no whitespace-run
    // splitting affects word count here) cue must still be "1" at line start.
    expect(srt.startsWith("1\n")).toBe(true);
  });
});
