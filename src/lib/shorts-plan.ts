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
 * Which section's footage fills the screen, and for how long, inside a short.
 *
 * `sectionIndex` indexes the same `windows` array `planShortWindow` was given,
 * which is index-aligned with the anchored cues — and therefore with the clip
 * `FootageService` stored for that section. `seconds` is that clip's slot in
 * the short, not in the parent video.
 */
export interface ShortSlot {
  sectionIndex: number;
  seconds: number;
}

/**
 * The picture plan for a short: which section clips play, in order, and for
 * how long each.
 *
 * This is what lets a short be COMPOSED rather than cropped. A short used to
 * be cut out of the finished landscape render, which meant it inherited the
 * landscape captions burned into those pixels and then had its own vertical
 * ones drawn on top — two sets of subtitles, the first of them unremovable
 * because it was the image. Going back to the section clips is the only fix
 * that does not involve keeping a second, caption-free copy of every render on
 * a disk that is already watched.
 *
 * Slots are measured between section START boundaries, clipped to the window,
 * exactly as `sectionDurations` measures them for a whole video and for the
 * same reason: a window's `endSeconds` is the end of its last spoken character,
 * so measuring `end - start` per section leaves slivers uncovered and every
 * later section plays that much early. Boundaries tile; lengths do not. The
 * slots therefore sum to exactly `window.endSeconds - window.startSeconds`.
 *
 * `minSeconds` is the floor a slot has to clear, and a slot below it is merged
 * into its NEIGHBOUR rather than being padded: padding would push everything
 * after it late, and the sum is the one thing that has to stay exact. The
 * merged slot keeps the earlier section's clip, which is the one already on
 * screen when the too-short section arrives. The floor exists because
 * `planRender` refuses a slot shorter than the crossfade it has to donate to —
 * correctly, but a window that clips a section 0.2s after it starts is a
 * routine consequence of `MAX_SHORT_SECONDS`, not a fault worth failing on.
 */
export function planShortSlots(
  windows: CueWindow[],
  window: ShortWindow,
  minSeconds: number,
): ShortSlot[] {
  const clamp = (value: number) =>
    Math.min(Math.max(value, window.startSeconds), window.endSeconds);

  const raw: ShortSlot[] = [];

  windows.forEach((cueWindow, index) => {
    const start = clamp(cueWindow.startSeconds);
    // The next section's start, not this one's end — see the doc comment. The
    // last section runs to the end of the window.
    const end =
      index + 1 < windows.length ? clamp(windows[index + 1].startSeconds) : window.endSeconds;
    const seconds = end - start;

    if (seconds > 0) {
      raw.push({ sectionIndex: index, seconds });
    }
  });

  if (raw.length === 0) {
    return [];
  }

  // Forward pass: a slot under the floor absorbs the one after it, so the clip
  // already on screen simply holds it longer.
  const merged: ShortSlot[] = [];
  for (const slot of raw) {
    const previous = merged[merged.length - 1];

    if (previous && previous.seconds < minSeconds) {
      previous.seconds += slot.seconds;
      continue;
    }

    merged.push({ ...slot });
  }

  // The forward pass cannot fix a final slot that is still short — there is
  // nothing after it to absorb — so it goes backwards into the one before it.
  // A single slot is left alone: a short is at least MIN_SHORT_SECONDS long,
  // so one slot covering all of it is already well past any sane floor.
  const last = merged[merged.length - 1];
  if (merged.length > 1 && last.seconds < minSeconds) {
    merged[merged.length - 2].seconds += last.seconds;
    merged.pop();
  }

  return merged;
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
 * The other half of that limit, and the half that actually binds.
 *
 * Three words is not a width. "and then it" is 11 characters and "understanding
 * transformation opportunities" is 41, and libass sets both from the same cue —
 * so a word count alone let a cue arrive three times wider than the line box and
 * come back out as a three-row tower stacked up the middle of the frame. This is
 * the same limit expressed in the unit the renderer actually cares about.
 *
 * 18 was measured, not guessed: inside the safe line box this file now asks for
 * (742px, see `SHORT_SIDE_SAFE_FRACTION`), DejaVu Sans at the boosted size runs
 * about 39px per character in sentence case, so 18 characters is ~700px — one
 * row with room to spare. Capitals are wider and a line of them can still wrap,
 * which is correct: a wrapped line is inside the frame, and this limit exists to
 * make wrapping rare rather than to make it impossible.
 *
 * A single word longer than this is left alone. There is nothing to split — see
 * the note on unbreakable tokens in `verticalCaptionStyle`.
 */
export const SHORT_MAX_CHARS_PER_LINE = 18;

/**
 * The ASS canvas FFmpeg invents when it converts an SRT for the `subtitles`
 * filter, and the one thing in this file that is a property of the FFmpeg build
 * rather than arithmetic.
 *
 * `verticalCaptionStyle` goes to some trouble below to express sizes as ratios
 * precisely so this number cancels out. Margins cannot be expressed that way:
 * there is no landscape MarginL to take a ratio against, because nothing in this
 * codebase has ever set one. So these are read off the header directly:
 *
 *     $ ffmpeg -i captions.srt -f ass -
 *     PlayResX: 384
 *     PlayResY: 288
 *
 * verified against the worker image's own FFmpeg (5.1.9, Debian 12), and pinned
 * by `shorts-plan.test.ts` so a change here has to be deliberate. libass scales
 * horizontal margins by `frame_width / PlayResX` and vertical ones by
 * `frame_height / PlayResY`, which for a 1080x1920 short is 2.8125 and 6.6667
 * px per unit — both confirmed by measuring rendered frames.
 */
const PLAY_RES_X = 384;
const PLAY_RES_Y = 288;

/**
 * How much of the frame's WIDTH is given up at each side, and it is sized by
 * YouTube's UI rather than by taste.
 *
 * A Short is not played inside its own frame. YouTube lays its own chrome over
 * it, and the piece that matters here is the action rail down the right-hand
 * side — like, dislike, comment, share, and the spinning sound disc — which
 * published templates put at 120-152px wide on a 1080px frame and which sits at
 * exactly the height captions sit at. A caption behind it is not "slightly off",
 * it is unreadable, and it is burned in.
 *
 * 15.6% is the widest of those figures plus a pad. It is applied to BOTH sides
 * even though the left needs only ~60px: the operator reviews these clips in a
 * plain browser player with no YouTube chrome in it, and captions visibly off
 * centre there read as a bug rather than as a safe area. Symmetry costs about
 * 100px of line width and buys a clip that looks right in both places.
 */
const SHORT_SIDE_SAFE_FRACTION = 0.156;

/**
 * The same, for the bottom: the channel row, the title, the description and the
 * seek bar. Published templates put that band at 320-350px collapsed, and about
 * 450px once a viewer taps the description open.
 *
 * 23.6% of 1920 is 453px, so captions clear it in the expanded state too. This
 * is a FLOOR rather than a replacement — a channel that has set its captions
 * higher still gets what it asked for.
 */
const SHORT_BOTTOM_SAFE_FRACTION = 0.236;

/**
 * How much larger a short's captions are than the same channel's landscape
 * captions, in real pixels. Shorts are watched full-screen on a phone where the
 * captions are most of the point; a landscape video is a third of the screen
 * with the captions incidental.
 *
 * It was 1.25, and 1.25 was chosen when captions had the whole 1080px frame to
 * spread across. They do not any more: the safe area above leaves a 742px line
 * box, so the boost now has to be small enough that a real word still fits one.
 * The longest word that turns up in this codebase's narration is around 17
 * characters ("indistinguishable"), which sets 658px of that box at 1.1x — about
 * 11% of headroom. At 1.25x it set 753px and had none, and a 17-character run of
 * the font's widest glyphs came out 1123px wide and was clipped by the frame.
 *
 * 1.1x still renders a short's captions larger than the same channel's landscape
 * ones, which is the point the boost exists to make.
 */
const SHORT_CAPTION_BOOST = 1.1;

/**
 * A caption style that also pins its own horizontal safe area.
 *
 * Declared here rather than imported from ffmpeg-command.ts, and structural
 * typing is what lets that work: `buildForceStyle` accepts these fields as
 * optional and the landscape render never sets them, so the only style that
 * carries a horizontal margin is the one this file produces.
 */
export interface VerticalCaptionStyle extends CaptionStyle {
  marginL: number;
  marginR: number;
}

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
 * `marginV` is still not rescaled — it is in those same script units, so the
 * same number is the same FRACTION of the frame's height in either format — but
 * it is now raised to a floor. The old comment here claimed the landscape value
 * "happens to clear the YouTube Shorts UI"; measured, it does not. 60 units puts
 * the bottom of a caption 400px up, and YouTube's bottom chrome reaches ~450px
 * once a viewer opens the description. `SHORT_BOTTOM_SAFE_FRACTION` is the floor
 * that fixes it, taken as a `max` so a channel that has already asked for
 * captions higher keeps them there.
 *
 * `marginL`/`marginR` are new, and they are the reason this function exists at
 * all now. Nothing in this codebase had ever set a horizontal margin, so shorts
 * inherited FFmpeg's default of 10 units — 28px on a 1080px frame, a 2.6% inset.
 * That let captions run to within ~90px of the edges, straight underneath
 * YouTube's action rail, and let a long enough word run off the frame outright.
 *
 * What margins cannot fix is an UNBREAKABLE token. libass wraps on spaces and
 * nowhere else, so a single word wider than the line box overflows it rather
 * than being broken, and no margin can catch that — only a smaller glyph can,
 * which is what pulled `SHORT_CAPTION_BOOST` down to 1.1.
 *
 * `fontName` and the colours pass through untouched: the channel's brand does
 * not change because the frame is on its side.
 */
export function verticalCaptionStyle(style: CaptionStyle): VerticalCaptionStyle {
  const factor = (SHORT_CAPTION_BOOST * SOURCE_HEIGHT) / SHORT_HEIGHT;
  // One decimal place. libass parses fractional sizes happily, but a
  // twelve-decimal float in a `force_style` string is noise in every log line
  // and every test assertion that ever quotes it.
  const round = (value: number) => Math.round(value * factor * 10) / 10;

  // A fraction of the frame becomes script units by multiplying by the PlayRes
  // of the axis it lies on — that IS the unit, and it is why the two axes take
  // different numbers for what is nearly the same inset.
  const sideMargin = Math.round(SHORT_SIDE_SAFE_FRACTION * PLAY_RES_X);
  const bottomMargin = Math.round(SHORT_BOTTOM_SAFE_FRACTION * PLAY_RES_Y);

  return {
    ...style,
    fontSize: round(style.fontSize),
    outline: round(style.outline),
    shadow: round(style.shadow),
    marginL: sideMargin,
    marginR: sideMargin,
    marginV: Math.max(style.marginV, bottomMargin),
  };
}
