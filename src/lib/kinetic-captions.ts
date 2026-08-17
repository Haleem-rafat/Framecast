import { groupIntoCues, toWords, type Alignment, type Word } from "@/lib/captions";

/**
 * Captions that arrive one word at a time.
 *
 * ## Why a second format and not a flag on the first
 *
 * SRT cannot express this. A `.srt` cue appears whole, disappears whole, and
 * carries no styling of its own — the only thing that can be said about its
 * appearance is said globally, through libass's `force_style`. The look this
 * builds is a cue whose words *land as they are spoken*, with the stressed word
 * in a different colour from the ones beside it. Both of those are per-word
 * facts inside one cue, and SRT has nowhere to put them.
 *
 * ASS does. libass reads it natively, `subtitles=` already accepts it, and the
 * cost of the whole feature is emitting a different file — no filter change, no
 * second pass, no new dependency.
 *
 * `buildSrt` is untouched and is still what every existing render uses. This is
 * chosen per video, not switched on globally.
 *
 * ## Why cumulative reveal rather than one word at a time
 *
 * Showing exactly one word and replacing it every 300ms is legible only if you
 * are already reading it; a viewer who glances away loses the sentence. Holding
 * the words already spoken and adding the next keeps up to three on screen —
 * which is the format's own rule — and means a glance lands on a phrase rather
 * than a fragment.
 *
 * The mechanism is one `Dialogue` event per state: three words produce three
 * overlapping events, each ending where the next begins.
 */

/** Colour ASS uses for "the stressed word", as `&HBBGGRR&`.
 *
 *  ASS stores colour byte-reversed from HTML — this is amber `#FFA500` written
 *  backwards, and getting it the wrong way round yields a vivid blue that
 *  nothing in the pipeline would flag. */
const EMPHASIS_COLOUR = "&H00A5FF&";

export interface KineticCaptionStyle {
  fontName: string;
  fontSize: number;
  /** `&HBBGGRR`, matching the rest of this file and libass. */
  primaryColour: string;
  outlineColour: string;
  outline: number;
  shadow: number;
  marginV: number;
  marginL: number;
  marginR: number;
}

export interface KineticCaptionInput {
  alignment: Alignment;
  style: KineticCaptionStyle;
  /** The frame the subtitles are composed against. ASS positions everything
   *  relative to this, so it has to match what FFmpeg is producing or every
   *  margin is wrong by the ratio between them. */
  width: number;
  height: number;
  maxWordsPerLine: number;
  maxCharsPerLine: number;
  /**
   * Words the narration stresses, from the script.
   *
   * Matched case-insensitively and ignoring punctuation, because the script
   * says `Zeigarnik` and the narration renders `Zeigarnik.` — an exact match
   * would silently colour nothing, which is the failure mode where the feature
   * looks switched off rather than broken.
   */
  emphasis?: readonly string[];
}

/** ASS wants `H:MM:SS.cc` — centiseconds, one digit of hours, no padding on
 *  the hour. Deliberately not the SRT `HH:MM:SS,mmm` beside it. */
function timestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const centis = Math.round(safe * 100);
  const h = Math.floor(centis / 360_000);
  const m = Math.floor((centis % 360_000) / 6_000);
  const s = Math.floor((centis % 6_000) / 100);
  const cs = centis % 100;

  return (
    `${h}:${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`
  );
}

/** Strips punctuation and case so `Zeigarnik.` matches `zeigarnik`. */
function normalise(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * `{` and `}` open and close an override block in ASS, and a literal brace in
 * narration would silently swallow the rest of the line. `\N` is its hard line
 * break, so a stray backslash is just as dangerous.
 */
function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function header(input: KineticCaptionInput): string {
  const { style } = input;

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    // Without these two, libass lays the subtitles out against a default
    // 384x288 and every size and margin comes out scaled by the difference.
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, " +
      "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, " +
      "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, " +
      "MarginL, MarginR, MarginV, Encoding",
    // Alignment 2 is bottom-centre. Bold on: this format's captions are a
    // heavy grotesque and libass will synthesise weight if the face has none.
    `Style: Kinetic,${style.fontName},${style.fontSize},${style.primaryColour},` +
      `${style.primaryColour},${style.outlineColour},&H00000000&,-1,0,0,0,` +
      `100,100,0,0,1,${style.outline},${style.shadow},2,` +
      `${style.marginL},${style.marginR},${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

/**
 * One cue's worth of events: the words revealed one at a time, cumulatively.
 *
 * Each event runs from the moment its last word begins to the moment the next
 * word begins — or, for the final state, to the end of the cue. That is what
 * makes the reveal land on the spoken word rather than near it.
 */
function eventsForCue(
  cue: Word[],
  emphasised: Set<string>,
  cueEnd: number,
): string[] {
  return cue.map((word, index) => {
    const start = word.start;
    // The next word's start, not this word's end: the gap between them is
    // silence, and letting the previous state hold through it stops the caption
    // flickering off between words.
    const end = index + 1 < cue.length ? cue[index + 1].start : cueEnd;

    const text = cue
      .slice(0, index + 1)
      .map((shown) =>
        emphasised.has(normalise(shown.text))
          ? // Reset after the word so the colour does not leak into the rest of
            // the line.
            `{\\c${EMPHASIS_COLOUR}}${escapeText(shown.text)}{\\c}`
          : escapeText(shown.text),
      )
      .join(" ");

    // `\fad(80,0)` is the pop: an 80ms fade in, nothing on the way out,
    // because the state is replaced rather than removed.
    return (
      `Dialogue: 0,${timestamp(start)},${timestamp(end)},Kinetic,,0,0,0,,` +
      `{\\fad(80,0)}${text}`
    );
  });
}

/**
 * The whole subtitle file, ready to hand to `subtitles=`.
 *
 * Returns an empty string for an empty alignment, exactly as `buildSrt` does —
 * a video whose narration failed to align should render without captions
 * rather than fail, since the picture and the audio are both still correct.
 */
export function buildAss(input: KineticCaptionInput): string {
  const words = toWords(input.alignment);

  if (words.length === 0) {
    return "";
  }

  const emphasised = new Set(
    (input.emphasis ?? []).map(normalise).filter((word) => word.length > 0),
  );
  const cues = groupIntoCues(words, input.maxWordsPerLine, input.maxCharsPerLine);

  const events = cues.flatMap((cue) =>
    eventsForCue(cue, emphasised, cue[cue.length - 1].end),
  );

  return `${header(input)}\n${events.join("\n")}\n`;
}
