export interface Alignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

interface Word {
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
function toWords(alignment: Alignment): Word[] {
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

export function buildSrt(
  alignment: Alignment,
  maxWordsPerLine: number = DEFAULT_MAX_WORDS,
): string {
  const words = toWords(alignment);

  if (words.length === 0) {
    return "";
  }

  const cues: Word[][] = [];
  let line: Word[] = [];

  for (const word of words) {
    line.push(word);

    // Sentence-final punctuation is a better break than a word count: a cue that
    // ends mid-sentence reads worse than a short one.
    const endsSentence = /[.!?]$/.test(word.text);

    if (endsSentence || line.length >= maxWordsPerLine) {
      cues.push(line);
      line = [];
    }
  }

  if (line.length > 0) {
    cues.push(line);
  }

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
