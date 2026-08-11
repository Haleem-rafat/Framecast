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
 *  editor that rewraps lines changes the bytes without changing the words. */
function normalise(text: string): string {
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
    const end = Math.min(Math.max(0, endChar - 1), lastIndex);

    return {
      cue,
      startSeconds: alignment.characterStartTimesSeconds[start],
      endSeconds: alignment.characterEndTimesSeconds[end],
    };
  });
}
