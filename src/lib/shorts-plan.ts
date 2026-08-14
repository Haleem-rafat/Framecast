import type { Alignment } from "@/lib/captions";
import type { CaptionStyle } from "@/lib/video-style";
import type { AnchoredCue, CueWindow } from "@/lib/script-cues";

/**
 * Turning "the AI liked this bit of the script" into "cut the video here".
 *
 * Everything in this file exists to answer one question honestly: given a span
 * of NARRATION TEXT, what TIME RANGE of the rendered video is it? The rest of
 * the shorts feature is ordinary plumbing; this is the part that, if it is
 * wrong, produces a finished clip that starts mid-word and nobody notices until
 * it is on YouTube.
 *
 * The answer rests on one fact that the render pipeline already depends on, so
 * it is not a new assumption this feature introduces:
 *
 *   The narration alignment's timeline IS the finished video's timeline.
 *
 * `voiceover.service.ts` sends `content.trim()` to ElevenLabs verbatim and
 * stores the per-character alignment it returns. `render.service.ts` then feeds
 * that same narration in as input 1 of the assemble pass, starting at t=0, and
 * burns captions built from that same alignment by `buildSrt`. If alignment
 * time and video time disagreed by so much as a second, every caption in every
 * video this codebase has ever produced would be visibly out of sync. They are
 * not, which is the empirical proof — and it is why this module maps text to
 * time through the alignment rather than by inventing a second timing model.
 *
 * The second half of the answer is *where* a cut is allowed to fall.
 * `anchorCues` + `cueWindows` (script-cues.ts) already resolve each script
 * section to a character range and then to a time window; `planShortWindow`
 * does nothing more than take a contiguous RUN of those windows. That is a
 * deliberate restriction rather than a limitation worked around: section
 * boundaries are sentence boundaries — the model that wrote the script chose
 * them — so a window built this way can only ever start where a sentence starts
 * and end where one ends. Letting a model nominate arbitrary quoted text and
 * string-matching it back into `content` would buy finer granularity and pay
 * for it with the exact failure this restriction makes impossible: an
 * approximate match landing a cut mid-clause.
 */

/**
 * The two frame heights, and the only reason this file knows either: what
 * `verticalCaptionStyle` needs is the RATIO between them. The pixel dimensions
 * FFmpeg is actually asked to produce are decided in ffmpeg-command.ts, which
 * is the file that owns that decision — these are deliberately not exported, so
 * there is no second place a caller could read "how big is a short" from.
 */
const SOURCE_HEIGHT = 1080;
const SHORT_HEIGHT = 1920;

/**
 * A short shorter than this is not a moment, it is a fragment: one sentence
 * with no setup and no payoff. Also the floor that keeps a degenerate section
 * run (two cues anchoring to the same character, which `cueWindows` floors at
 * zero length rather than inverting) from reaching FFmpeg as `-t 0`.
 */
export const MIN_SHORT_SECONDS = 12;

/**
 * YouTube accepts up to three minutes as a Short now, but a clip cut out of a
 * long-form narration has no second act — past about a minute it is just the
 * middle of a video with the ends missing. Capped here rather than at the
 * platform limit for that reason, not a technical one.
 */
export const MAX_SHORT_SECONDS = 60;

export interface ShortWindow {
  startSeconds: number;
  endSeconds: number;
}

/**
 * The time range covered by script sections `startSection..endSection`
 * (inclusive, 0-based) — or null if that run cannot make a usable short.
 *
 * `windows` must be `cueWindows(anchored, alignment)` for the *same* alignment
 * the video was rendered against. Passing windows derived from a re-anchored,
 * re-timed script would produce a window that is internally consistent and
 * points at the wrong seconds of the actual MP4.
 *
 * The end is extended to `MIN_SHORT_SECONDS` when the chosen run is too short,
 * and truncated to `MAX_SHORT_SECONDS` when it is too long, rather than the run
 * being rejected outright — a model that picks a two-sentence moment has still
 * identified *where* the interesting part is, which is the judgement being asked
 * of it, and the length is arithmetic this side can do. Both repairs move the
 * END only: moving the start would slide the clip off the sentence the model
 * actually chose, which is the one thing worth preserving.
 *
 * `narrationSeconds` is then a hard ceiling on that end, and it is routinely
 * binding rather than a rare guard. `VoiceOver.durationSeconds` is an integer
 * and the assemble pass cuts the render at exactly that many seconds, while the
 * alignment's last characters are timed in fractions past it — so the final
 * section's window genuinely ends after the file does. Clipping there costs at
 * most that fraction of a second; not clipping would ask FFmpeg for footage
 * that does not exist, and it would answer with a clip shorter than the window
 * this function recorded, which is the mismatch the panel would then display.
 *
 * Only after every clamp is the length re-checked. A run that survives the
 * ceiling with less than `MIN_SHORT_SECONDS` left — the last section of a
 * script, most often — is refused, because there is nowhere left to take the
 * missing seconds from without moving the start.
 */
export function planShortWindow(
  windows: CueWindow[],
  startSection: number,
  endSection: number,
  narrationSeconds: number,
): ShortWindow | null {
  if (
    windows.length === 0 ||
    !Number.isInteger(startSection) ||
    !Number.isInteger(endSection) ||
    startSection < 0 ||
    startSection >= windows.length ||
    endSection < startSection ||
    endSection >= windows.length
  ) {
    return null;
  }

  const startSeconds = windows[startSection].startSeconds;
  let endSeconds = windows[endSection].endSeconds;

  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return null;
  }

  if (endSeconds > startSeconds + MAX_SHORT_SECONDS) {
    endSeconds = startSeconds + MAX_SHORT_SECONDS;
  }

  if (endSeconds < startSeconds + MIN_SHORT_SECONDS) {
    endSeconds = startSeconds + MIN_SHORT_SECONDS;
  }

  // The render does not exist past `narrationSeconds` — see the doc comment
  // for why this clamp fires on the last section of very nearly every script.
  if (endSeconds > narrationSeconds) {
    endSeconds = narrationSeconds;
  }

  // Re-checked only now, against everything the clamps actually left. A run
  // that ends up under the floor has nowhere left to take the missing seconds
  // from without moving its start, which is the one repair this function will
  // not make.
  if (endSeconds - startSeconds < MIN_SHORT_SECONDS) {
    return null;
  }

  return { startSeconds, endSeconds };
}

/**
 * True when two windows overlap at all.
 *
 * Three shorts that share ten seconds of narration are three near-identical
 * uploads, which is worse than two good ones — so the selector drops a moment
 * that collides with one it already accepted rather than trying to nudge it
 * clear. Nudging would move the cut off the sentence the model chose, which is
 * the whole thing `planShortWindow` above refuses to do.
 */
export function windowsOverlap(a: ShortWindow, b: ShortWindow): boolean {
  return a.startSeconds < b.endSeconds && b.startSeconds < a.endSeconds;
}

/**
 * The section list a model is shown, one line per section, 1-based.
 *
 * 1-based because the model is a language model reading a numbered list and
 * "section 1" is the first one; the callers convert back to the 0-based indices
 * everything else in this codebase uses. The spoken length is included because
 * the model is being asked for a run that adds up to a target duration, and it
 * cannot count seconds it has not been told.
 */
export function describeSections(
  anchored: AnchoredCue[],
  windows: CueWindow[],
  content: string,
): string {
  return anchored
    .map((cue, index) => {
      const window = windows[index];
      const seconds = Math.max(0, window.endSeconds - window.startSeconds);
      const text = content.slice(cue.startChar, cue.endChar).trim();

      return `${index + 1}. [${seconds.toFixed(1)}s] ${text}`;
    })
    .join("\n");
}

/**
 * The part of `alignment` spoken inside `window`, rebased so the first
 * character starts at 0.
 *
 * This is what makes the short's burned-in captions line up. `buildSrt`
 * (captions.ts) turns an alignment straight into SRT timestamps, and the short
 * is encoded with `-ss` before `-i`, which resets output timestamps to zero —
 * so the SRT handed to the `subtitles` filter has to be rebased by exactly the
 * same amount. Doing that by slicing the alignment, rather than by
 * post-processing SRT timestamps with a regex, means the word grouping and the
 * sentence-boundary line breaks are computed by the one function that already
 * knows how to do it.
 *
 * Selection is by TIME, not by character offset, and that is deliberate. The
 * caller holds a window in seconds, taken from a render that already exists;
 * character offsets into `ScriptVersion.content` describe a script that can be
 * edited afterwards. Going through characters would reintroduce exactly the
 * drift the Short model refuses to store offsets to avoid.
 *
 * A character is kept when its start time falls inside the window. Using the
 * start rather than the end means the character straddling the closing boundary
 * is included whole — the alternative drops a letter off the final word, which
 * libass renders faithfully as a typo.
 */
export function sliceAlignment(alignment: Alignment, window: ShortWindow): Alignment {
  const characters: string[] = [];
  const characterStartTimesSeconds: number[] = [];
  const characterEndTimesSeconds: number[] = [];

  alignment.characters.forEach((character, index) => {
    const start = alignment.characterStartTimesSeconds[index];
    const end = alignment.characterEndTimesSeconds[index];

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    if (start < window.startSeconds || start >= window.endSeconds) {
      return;
    }

    characters.push(character);
    // Floored at 0 rather than allowed negative: only the first kept character
    // can round below zero, and a negative SRT timestamp is not merely ugly —
    // `buildSrt`'s formatter would emit "00:00:-0,-33" and libass would drop
    // the cue, silently losing the short's opening caption.
    characterStartTimesSeconds.push(Math.max(0, start - window.startSeconds));
    characterEndTimesSeconds.push(Math.max(0, end - window.startSeconds));
  });

  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
}

/**
 * How many words a caption line may hold in a vertical frame. Half the
 * landscape default (6, see captions.ts) because the frame is 1080px wide
 * rather than 1920 — the same line that fits comfortably across a 16:9 frame
 * wraps to three ragged rows in a 9:16 one.
 */
export const SHORT_MAX_WORDS_PER_LINE = 3;

/**
 * How much larger a short's captions are than the same channel's landscape
 * captions, in real pixels. Shorts are watched full-screen on a phone where the
 * captions are most of the point; a landscape video is a third of the screen
 * with the captions incidental.
 */
const SHORT_CAPTION_BOOST = 1.25;

/**
 * The channel's caption style, adapted to a 1080x1920 frame.
 *
 * The arithmetic here looks like a guess and is not, so it is worth stating
 * exactly why it is safe. libass renders an ASS script at a nominal resolution
 * (`PlayResY`) and scales everything by `frame_height / PlayResY`. FFmpeg
 * synthesises that header itself when converting SRT, and its value is a
 * detail of the FFmpeg build in the worker image — not something this codebase
 * sets or can rely on. So a font size is NOT chosen here in absolute pixels.
 *
 * Instead every size is expressed as a RATIO against the landscape style that
 * already renders correctly in production, and `PlayResY` cancels out of that
 * ratio entirely:
 *
 *   landscape_px = FontSize_land * SOURCE_HEIGHT / PlayResY
 *   vertical_px  = FontSize_vert * SHORT_HEIGHT  / PlayResY
 *
 * Setting `vertical_px = boost * landscape_px` gives
 * `FontSize_vert = FontSize_land * boost * SOURCE_HEIGHT / SHORT_HEIGHT`, with
 * no `PlayResY` term left in it. Whatever that value turns out to be, a short's
 * captions come out `SHORT_CAPTION_BOOST` times the pixel height of the ones
 * the operator already approves of.
 *
 * `outline` and `shadow` take the same factor: they are in the same script
 * units, so leaving them alone would scale them by the frame-height ratio
 * (1.78x) while the glyphs scaled by only 1.25x, and the text would come out
 * looking bolder and muddier the taller the frame got.
 *
 * `marginV` is deliberately NOT rescaled. It is in those same script units, so
 * the same number is the same FRACTION of the frame's height in either format —
 * 60 sits the captions the same distance up from the bottom edge of a 1920px
 * frame as it does a 1080px one. That fraction (about a fifth of the way up)
 * also happens to clear the YouTube Shorts UI, which occupies the bottom band
 * of the screen; rescaling it would push the captions down underneath it.
 *
 * `fontName` and the colours pass through untouched: the channel's brand does
 * not change because the frame is on its side.
 */
export function verticalCaptionStyle(style: CaptionStyle): CaptionStyle {
  const factor = (SHORT_CAPTION_BOOST * SOURCE_HEIGHT) / SHORT_HEIGHT;
  // One decimal place. libass parses fractional sizes happily, but a
  // twelve-decimal float in a `force_style` string is noise in every log line
  // and every test assertion that ever quotes it.
  const round = (value: number) => Math.round(value * factor * 10) / 10;

  return {
    ...style,
    fontSize: round(style.fontSize),
    outline: round(style.outline),
    shadow: round(style.shadow),
  };
}
