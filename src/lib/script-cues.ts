import type { Alignment } from "@/lib/captions";

/** How many words of a section's opening identify it. Long enough to be
 *  unique in a script, short enough that editing inside a section keeps its
 *  cue — only rewriting the opening orphans it. */
const ANCHOR_WORDS = 8;

export interface ScriptCue {
  /** The first `ANCHOR_WORDS` words of this cue's section, verbatim. */
  anchor: string;
  /** What to show: a stock-footage search query. */
  cue: string;
}

export interface AnchoredCue {
  cue: string;
  /** Index into the narration content where this section starts. */
  startChar: number;
  /** Exclusive end — the next section's start, or the content's length. */
  endChar: number;
}

export interface CueWindow {
  cue: string;
  startSeconds: number;
  endSeconds: number;
}

/** Whitespace is collapsed so that a reflowed paragraph still matches: an
 *  editor that rewraps lines changes the bytes without changing the words.
 *
 *  Exported so `gateway.provider.ts` can apply the exact same collapsing when
 *  it assembles `content` from `sections[].text`. `extractAnchor` below runs
 *  a section's raw text through this before taking its first eight words —
 *  if `content` were built from the *un*-normalised text instead, a model
 *  that emits irregular internal whitespace (a double space, a stray tab)
 *  inside a section's opening would produce an anchor that never literally
 *  occurs in `content`, and `anchorCues`'s `indexOf` would orphan that cue on
 *  the very first edit even though nothing the operator did touched it. */
export function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function extractAnchor(sectionText: string): string {
  return normalise(sectionText).split(" ").slice(0, ANCHOR_WORDS).join(" ");
}

/**
 * Locates each cue's section in the narration.
 *
 * The search is ordered — each one begins where the previous anchor ended —
 * so a phrase that recurs later in the script cannot capture an earlier cue.
 * A cue whose anchor is not found from that point on is orphaned rather than
 * matched loosely: a cue pointing at the wrong sentence is worse than one
 * that falls back to a topic-level clip.
 */
export function anchorCues(
  cues: ScriptCue[],
  content: string,
): { anchored: AnchoredCue[]; orphaned: ScriptCue[] } {
  const anchored: AnchoredCue[] = [];
  const orphaned: ScriptCue[] = [];
  let searchFrom = 0;

  for (const cue of cues) {
    // An empty anchor comes from extractAnchor on an empty or whitespace-only
    // section. content.indexOf("", searchFrom) matches immediately without
    // consuming anything, so it would sit on top of whichever cue comes next
    // instead of claiming any text of its own. Orphan it rather than let it
    // match nowhere in particular — the same "orphan over a loose match"
    // stance the module already takes for anchors that aren't found at all.
    if (cue.anchor === "") {
      orphaned.push(cue);
      continue;
    }

    const at = content.indexOf(cue.anchor, searchFrom);

    if (at === -1) {
      orphaned.push(cue);
      continue;
    }

    anchored.push({ cue: cue.cue, startChar: at, endChar: content.length });
    searchFrom = at + cue.anchor.length;
  }

  // Each section runs to the start of the next. Done in a second pass because
  // a section's end is only known once its successor has been located.
  for (let i = 0; i < anchored.length - 1; i++) {
    anchored[i].endChar = anchored[i + 1].startChar;
  }

  return { anchored, orphaned };
}

/**
 * Turns character ranges into the times those characters are spoken.
 *
 * This works because `voiceover.service.ts` sends `content.trim()` to
 * ElevenLabs verbatim, so alignment indices and content indices are the same
 * indices. Ranges are clamped to the alignment's length: a range past the end
 * would otherwise produce `undefined` and then a NaN clip duration, which
 * FFmpeg treats as an error rather than a no-op.
 */
export function cueWindows(
  anchored: AnchoredCue[],
  alignment: Alignment,
): CueWindow[] {
  const lastIndex = alignment.characters.length - 1;

  return anchored.map(({ cue, startChar, endChar }) => {
    const start = Math.min(Math.max(0, startChar), lastIndex);
    // endChar is exclusive, so the last spoken character is endChar - 1 —
    // except when the range is zero-width (endChar === startChar, which
    // anchorCues can produce for two cues that resolve to the same
    // position). Without the floor at `start`, that reads back one
    // character before the range begins, and if the alignment has a pause
    // there, characterEndTimesSeconds at that earlier index can be less
    // than characterStartTimesSeconds at `start` — a negative-duration
    // window that Task 5 would hand straight to FFmpeg. Flooring at `start`
    // guarantees end >= start, so the window is at worst zero-length.
    const end = Math.max(start, Math.min(Math.max(0, endChar - 1), lastIndex));

    return {
      cue,
      startSeconds: alignment.characterStartTimesSeconds[start],
      endSeconds: alignment.characterEndTimesSeconds[end],
    };
  });
}

/**
 * Turns each section's spoken range into the length of its slot.
 *
 * Not simply `endSeconds - startSeconds` per window, and the difference
 * matters. A window's end is the end time of the last character *before* the
 * next section starts, so consecutive windows can leave a sliver of narration
 * uncovered — and the first section may not begin at zero at all if the script
 * opens with text no cue anchored to. Slots are therefore measured from one
 * section's start to the *next* section's start, with the first stretched back
 * to 0 and the last carried out to the narration's end. The result covers
 * [0, durationSeconds] with no gaps, which is the only arrangement where the
 * picture and the words stay together for the whole video.
 *
 * Slots are derived as the differences between those boundaries, and every
 * repair below moves a boundary rather than a length. That is what makes the
 * sum exactly `durationSeconds` no matter what the alignment hands over: the
 * two ends are pinned, and moving anything between them takes from one slot
 * exactly what it gives to another.
 *
 * The repairs enforce `minClipSeconds` (see `MIN_CLIP_SECONDS` in
 * render.service.ts for why a slot cannot be arbitrarily short). Forwards,
 * each boundary is pushed late enough to give the section before it room,
 * which takes that time from the section after.
 *
 * A single short section therefore costs only its immediate neighbour. A *run*
 * of them cascades — each push feeds the next — and the run's total error is
 * what the section after the run pays: starts of [0, 5, 5.1, 5.2, 5.3] across
 * a 30s narration give slots of [5, 1, 1, 1, 22], so the fifth section begins
 * at 8.0 rather than 5.3. The precise guarantee is that the displacement is
 * bounded by (k x minClipSeconds) minus however long the run of k short
 * sections is actually spoken, and that it *terminates*: the first section
 * long enough to satisfy the floor on its own absorbs the whole cascade, and
 * every section after it is back on the second its own words start. Error
 * concentrates around a run of near-empty sections instead of accumulating
 * down the video, which is the property that matters — nothing a viewer sees
 * in the second half depends on a degenerate cue in the first.
 *
 * Backwards then pulls boundaries in from the end, which is what stops the
 * final section being squeezed to nothing by the pushing, and also handles an
 * alignment whose last characters are timed past the narration's stored
 * (integer) length.
 *
 * Lives here rather than in render.service.ts because it is pure arithmetic
 * on the same timing model `cueWindows` produces — and because the two
 * arrangements above (the cascade, and the degenerate branch below) are worth
 * testing without a database, a storage bucket or a fake FFmpeg in the way.
 */
export function sectionDurations(
  startTimes: number[],
  durationSeconds: number,
  minClipSeconds: number,
): number[] {
  const count = startTimes.length;

  // More sections than there is narration to divide between them: no
  // arrangement gives all of them the floor, so give them equal shares
  // instead. Still sums to the narration exactly; a script this shape (a
  // section per second) is a bug upstream, and RenderService refuses outright
  // if the shares come out too short to carry a transition — with an error
  // about the script, which is the actual cause.
  if (count * minClipSeconds > durationSeconds) {
    return Array.from({ length: count }, () => durationSeconds / count);
  }

  // Section starts, with the two fixed ends: the video begins at 0 whatever
  // the first cue anchored to, and ends where the narration does.
  const boundaries = [0, ...startTimes.slice(1), durationSeconds];

  for (let i = 1; i < count; i++) {
    boundaries[i] = Math.max(boundaries[i], boundaries[i - 1] + minClipSeconds);
  }
  for (let i = count - 1; i >= 1; i--) {
    boundaries[i] = Math.min(boundaries[i], boundaries[i + 1] - minClipSeconds);
  }

  return boundaries.slice(1).map((end, index) => end - boundaries[index]);
}
