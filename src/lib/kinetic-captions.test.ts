import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { buildAss, type KineticCaptionStyle } from "@/lib/kinetic-captions";

/**
 * Word-by-word captions.
 *
 * The things asserted here are the ones that are invisible until a video is
 * rendered and then obviously wrong: a colour written the wrong way round, a
 * margin scaled by a missing PlayRes, a caption that flickers off between
 * words, a brace in the narration eating the rest of the line.
 */

const STYLE: KineticCaptionStyle = {
  fontName: "Anton",
  fontSize: 96,
  primaryColour: "&H00FFFFFF",
  outlineColour: "&H00000000",
  outline: 4,
  shadow: 0,
  marginV: 240,
  marginL: 120,
  marginR: 120,
};

/** Builds an alignment from words and their timings, the way ElevenLabs
 *  returns one — per character, with whitespace between words. */
function align(words: [string, number, number][]): Alignment {
  const characters: string[] = [];
  const characterStartTimesSeconds: number[] = [];
  const characterEndTimesSeconds: number[] = [];

  words.forEach(([text, start, end], index) => {
    if (index > 0) {
      characters.push(" ");
      characterStartTimesSeconds.push(start);
      characterEndTimesSeconds.push(start);
    }

    const step = (end - start) / text.length;

    [...text].forEach((char, position) => {
      characters.push(char);
      characterStartTimesSeconds.push(start + step * position);
      characterEndTimesSeconds.push(start + step * (position + 1));
    });
  });

  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

function build(
  words: [string, number, number][],
  emphasis?: string[],
  maxWordsPerLine = 3,
) {
  return buildAss({
    alignment: align(words),
    style: STYLE,
    width: 1080,
    height: 1920,
    maxWordsPerLine,
    maxCharsPerLine: 18,
    emphasis,
  });
}

describe("buildAss", () => {
  it("returns nothing for an alignment with no words", () => {
    // A narration that failed to align should render without captions rather
    // than fail — the picture and the audio are both still correct.
    expect(
      buildAss({
        alignment: { characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] },
        style: STYLE,
        width: 1080,
        height: 1920,
        maxWordsPerLine: 3,
        maxCharsPerLine: 18,
      }),
    ).toBe("");
  });

  it("declares the frame it was laid out against", () => {
    // Without PlayResX/Y libass lays out against 384x288 and every size and
    // margin comes out scaled by the difference.
    const ass = build([["one", 0, 1]]);

    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("carries the style through to the Style line", () => {
    const ass = build([["one", 0, 1]]);

    expect(ass).toMatch(/^Style: Kinetic,Anton,96,/m);
    expect(ass).toContain(",120,120,240,1");
  });

  it("reveals a cue one word at a time, cumulatively", () => {
    const ass = build([
      ["THE", 0, 0.4],
      ["OPEN", 0.5, 0.9],
      ["FILE", 1.0, 1.5],
    ]);
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    expect(events).toHaveLength(3);
    expect(events[0]).toMatch(/THE$/);
    expect(events[1]).toMatch(/THE OPEN$/);
    expect(events[2]).toMatch(/THE OPEN FILE$/);
  });

  it("holds each state until the next word starts, not until the word ends", () => {
    // The gap between words is silence. Ending a state at the word's own end
    // makes the caption flicker off and back on between every word.
    const ass = build([
      ["THE", 0, 0.4],
      ["OPEN", 0.9, 1.4],
    ]);
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    // First state ends at 0.9 — the second word's start — not at 0.4.
    expect(events[0]).toContain("0:00:00.90");
  });

  it("colours a stressed word and closes the override after it", () => {
    const ass = build(
      [
        ["CALL", 0, 0.4],
        ["IT", 0.5, 0.7],
        ["ZEIGARNIK", 0.8, 1.6],
      ],
      ["Zeigarnik"],
    );

    // Amber as ASS stores it — byte-reversed from #FFA500. The wrong order is
    // a vivid blue that nothing else in the pipeline would flag.
    expect(ass).toContain("{\\c&H00A5FF&}ZEIGARNIK{\\c}");
  });

  it("matches a stressed word through punctuation and case", () => {
    // The script says "Zeigarnik" and the narration renders "Zeigarnik." An
    // exact match silently colours nothing, which looks like the feature is off.
    const ass = build([["Zeigarnik.", 0, 1]], ["zeigarnik"]);

    expect(ass).toContain("{\\c&H00A5FF&}Zeigarnik.{\\c}");
  });

  it("leaves unstressed words alone", () => {
    const ass = build([["ordinary", 0, 1]], ["something-else"]);

    expect(ass).not.toContain("&H00A5FF&");
  });

  it("escapes braces so narration cannot open an override block", () => {
    // An unescaped { swallows the rest of the line as ASS markup.
    const ass = build([["{oops}", 0, 1]]);

    expect(ass).toContain("\\{oops\\}");
  });

  it("fades each state in and never out", () => {
    // The state is replaced by the next one rather than removed, so a fade out
    // would show a gap between words.
    const ass = build([["one", 0, 1]]);

    expect(ass).toContain("{\\fad(80,0)}");
  });

  it("writes ASS timestamps, not SRT ones", () => {
    const ass = build([["one", 0, 1.5]]);

    // H:MM:SS.cc with centiseconds, not HH:MM:SS,mmm.
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:01\.50,/);
    expect(ass).not.toContain(",000 -->");
  });

  it("breaks cues at the configured word count", () => {
    const ass = build(
      [
        ["one", 0, 0.3],
        ["two", 0.4, 0.7],
        ["three", 0.8, 1.1],
        ["four", 1.2, 1.5],
      ],
      undefined,
      2,
    );
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    // Two cues of two words: four states, and the third starts a fresh line
    // rather than continuing the first.
    expect(events).toHaveLength(4);
    expect(events[2]).toMatch(/three$/);
  });

  it("never emits a negative timestamp", () => {
    // libass reads a negative start as garbage and drops the event, so a
    // narration whose alignment begins fractionally before zero would lose its
    // first caption. Checked on the Dialogue lines only — the Style line
    // legitimately carries -1, which is how ASS spells "bold on".
    const ass = build([["one", -0.5, 1]]);
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

    expect(events).toHaveLength(1);
    expect(events[0]).toContain("0:00:00.00");
    for (const event of events) {
      expect(event).not.toMatch(/,-/);
    }
  });
});
