export interface Alignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

const DEFAULT_MAX_WORDS = 6;

/** SRT wants `HH:MM:SS,mmm` — comma, not the period WebVTT uses. */
function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;

  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`
  );
}

/**
 * ElevenLabs aligns per character, but captions read as words. Whitespace closes
 * the current word and is not itself timed.
 */
export function toWords(alignment: Alignment): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;

  alignment.characters.forEach((char, index) => {
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = null;
      }
      return;
    }

    if (!current) {
      current = {
        text: char,
        start: alignment.characterStartTimesSeconds[index] ?? 0,
        end: alignment.characterEndTimesSeconds[index] ?? 0,
      };
      return;
    }

    current.text += char;
    current.end = alignment.characterEndTimesSeconds[index] ?? current.end;
  });

  if (current) {
    words.push(current);
  }

  return words;
}

/**
 * Groups timed words into the cues that appear on screen together.
 *
 * Exported, and shared with the kinetic (ASS) captions in
 * `kinetic-captions.ts`, because the *grouping* is the same question for both
 * formats — how many words belong on screen at once, and where a cue may
 * break. Only the rendering of a cue differs. A second copy of this loop would
 * be two answers to one question, free to disagree about where a sentence ends.
 */
export function groupIntoCues(
  words: Word[],
  maxWordsPerLine: number,
  maxCharsPerLine: number,
): Word[][] {
  const cues: Word[][] = [];
  let line: Word[] = [];
  let lineChars = 0;

  for (const word of words) {
    // Closed BEFORE the word is added, so the word that would have overflowed
    // starts the next cue instead of ending this one. Guarded on a non-empty
    // line because a single word longer than the budget has nothing to be split
    // against — flushing an empty cue would emit a blank subtitle and then put
    // the word on its own line anyway.
    const wouldBe = lineChars === 0 ? word.text.length : lineChars + 1 + word.text.length;

    if (line.length > 0 && wouldBe > maxCharsPerLine) {
      cues.push(line);
      line = [];
      lineChars = 0;
    }

    line.push(word);
    lineChars = lineChars === 0 ? word.text.length : lineChars + 1 + word.text.length;

    // Sentence-final punctuation is a better break than a word count: a cue that
    // ends mid-sentence reads worse than a short one.
    const endsSentence = /[.!?]$/.test(word.text);

    if (endsSentence || line.length >= maxWordsPerLine) {
      cues.push(line);
      line = [];
      lineChars = 0;
    }
  }

  if (line.length > 0) {
    cues.push(line);
  }

  return cues;
}

/**
 * `maxCharsPerLine` is off by default, and the default is what the landscape
 * render uses — it calls this with one argument, so nothing about a 16:9 video's
 * captions changes. The vertical shorts path is the only caller that sets it,
 * because it is the only one whose frame is narrow enough for a cue's width in
 * CHARACTERS, rather than in words, to be what decides whether libass wraps it.
 * See `SHORT_MAX_CHARS_PER_LINE` in shorts-plan.ts.
 */
export function buildSrt(
  alignment: Alignment,
  maxWordsPerLine: number = DEFAULT_MAX_WORDS,
  maxCharsPerLine: number = Number.POSITIVE_INFINITY,
): string {
  const words = toWords(alignment);

  if (words.length === 0) {
    return "";
  }

  const cues = groupIntoCues(words, maxWordsPerLine, maxCharsPerLine);

  return (
    cues
      .map((cue, index) => {
        const text = cue.map((word) => word.text).join(" ");
        const start = timestamp(cue[0].start);
        const end = timestamp(cue[cue.length - 1].end);

        return `${index + 1}\n${start} --> ${end}\n${text}\n`;
      })
      .join("\n") + "\n"
  );
}
