import type { AnchoredCue } from "@/lib/script-cues";

/**
 * How a script's sections are grouped into the pictures an illustrated video
 * actually shows.
 *
 * A generated script is cut into sections of 20-25 words, which is right for
 * stock footage — a clip is cheap, and cutting the picture on the sentence is
 * what keeps it matched to the words. It is wrong for illustrations. One image
 * per section is 27 images for a four-minute video, at real money each, and
 * more importantly it is not what this genre does.
 *
 * Two independent lines converge on 10-16 pictures for a four-minute story:
 *
 *   - Publishing convention. A standard 32-page picture book yields 12-14 story
 *     spreads, and a picture book read aloud runs 3-6 minutes. The children's
 *     publishing industry has had a century to converge on that number.
 *   - Measurement. Scene detection over high-performing videos in this exact
 *     genre — Koala Moon (4.19M views), Sleeptime Music & Stories (3.16M),
 *     Twinkle Tales Time (1.41M) — puts them at one visual every 13-70 seconds,
 *     at a frame-to-frame distance floor five times lower than the genuinely
 *     animated channels. They are still illustrations with slow camera motion.
 *
 * Note that the two bands are the same statement. Ten to sixteen pictures
 * across 240 seconds IS 15 to 24 seconds each, so this module only implements
 * one of them — the seconds — and the count falls out. That also makes it
 * behave sensibly for lengths nobody quoted a picture count for: a 64-second
 * video gets three beats, a nine-minute one gets twenty-seven, and both hold
 * each picture for about the same time.
 *
 * Pure arithmetic on character offsets, deliberately. `footage.service.ts`
 * decides which pictures to generate and `render.service.ts` decides how long
 * each one holds the screen, and the two must agree exactly or a video's
 * pictures play against the wrong words — so the grouping has to be derivable
 * from data both of them already have, without a stored plan that could drift
 * from the script. Both have the anchored cues and the narration's length;
 * neither needs the alignment JSON to compute the grouping, only to time it.
 */

/**
 * The middle of the measured 15-25s band, and the number that decides how many
 * pictures a video gets. 240s / 20s = 12 beats, which sits in the middle of the
 * 10-16 the research converged on.
 */
export const BEAT_TARGET_SECONDS = 20;

/**
 * The one hard end of the band, and it is the bottom one.
 *
 * A picture cut faster than this stops being "a still illustration with slow
 * camera motion" and becomes a slideshow, which is the thing YouTube's kids
 * quality principles name by its own word ("Image slideshows … with minimal or
 * no narrative"). The ceiling is deliberately soft by comparison: the measured
 * channels run 13-25s (Twinkle Tales Time, Sleeptime Music & Stories) and
 * 45-70s (Koala Moon, 4.19M views), so a beat that comes out at 27 seconds is
 * squarely inside what works and is not worth splitting a sentence over.
 *
 * That asymmetry is load-bearing rather than a preference. Sections are 20-25
 * words, so at four minutes each is about nine seconds, and a beat can only be
 * a whole number of them — 15-25s is 1.7 to 2.8 sections, and the only integer
 * in that range is 2. The band cannot always be met exactly. Enforcing the
 * floor and letting the ceiling float is what "as close to 20s as the sentences
 * allow, and never faster" means in arithmetic.
 */
export const BEAT_MIN_SECONDS = 15;

/**
 * A ceiling on pictures per video, in money rather than in seconds.
 *
 * The seconds rule above is the real design; this only stops a pathological
 * input turning into a pathological invoice. At roughly $0.05 an illustration a
 * four-hour sleep compilation would otherwise ask for 720 generations. Forty is
 * about $2 and is already past anything this genre does — beyond it each
 * picture simply holds the screen longer, which is what Koala Moon does at
 * 45-70 seconds a visual anyway.
 */
export const MAX_BEATS = 40;

export interface StoryBeat {
  /** Indices into the anchored cues this beat covers. Contiguous and
   *  ascending, and every beat has at least one. */
  sectionIndices: number[];
  /** Those sections' cues, in the order they are spoken. What the illustration
   *  prompt describes. */
  cues: string[];
}

/**
 * How many pictures a narration of this length should get.
 *
 * Never more than there are sections — a beat with no section in it would be a
 * picture with no words under it — and never more than `MAX_BEATS`. Always at
 * least one as long as there is a section to put in it, because a video with
 * cues and no pictures is not a cheaper video, it is a broken one.
 */
export function beatCountFor(durationSeconds: number, sectionCount: number): number {
  if (sectionCount <= 0) {
    return 0;
  }

  const target = Math.round(Math.max(0, durationSeconds) / BEAT_TARGET_SECONDS);

  return Math.max(1, Math.min(target, sectionCount, MAX_BEATS));
}

/**
 * Groups consecutive sections into `count` runs of roughly equal spoken length.
 *
 * Weighted by characters rather than seconds, and that is what lets
 * `footage.service.ts` and `render.service.ts` reach the same grouping without
 * either of them loading the alignment: narration is read at a near-constant
 * rate, so a section's character span is an excellent proxy for how long it is
 * spoken, and both services already have the anchored offsets. The *timing* is
 * still exact — the renderer sums each beat's real section durations off the
 * alignment (see `beatSeconds`). Only the grouping is approximate, and a beat
 * boundary landing one sentence either side of ideal is invisible.
 *
 * Greedy with a reservation: each beat takes sections while doing so moves its
 * total closer to what an even split would give it, but never takes so many
 * that a later beat would be left with none. Deterministic, so re-running
 * collection on the same script produces the same beats and the idempotency
 * check in `collectIllustrated` means something.
 */
function groupByWeight(weights: number[], count: number): number[][] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const beats: number[][] = [];

  let next = 0;
  let consumed = 0;

  for (let beat = 0; beat < count; beat++) {
    const beatsLeft = count - beat;
    // What an even split of what is left would give this beat. Recomputed each
    // time rather than fixed at total/count, so a beat that overshot is paid
    // for by the beats after it instead of by the last one alone.
    const ideal = (total - consumed) / beatsLeft;
    // Leave one section for every beat still to come.
    const maxTake = weights.length - next - (beatsLeft - 1);

    let take = 1;
    let accumulated = weights[next];

    while (take < maxTake) {
      const withNext = accumulated + weights[next + take];
      // Stop at the point adding another section stops helping. `>=` rather
      // than `>` so a tie takes the smaller beat, which keeps the run short and
      // leaves more for the beats after it.
      if (Math.abs(withNext - ideal) >= Math.abs(accumulated - ideal)) {
        break;
      }
      accumulated = withNext;
      take += 1;
    }

    beats.push(Array.from({ length: take }, (_, offset) => next + offset));
    next += take;
    consumed += accumulated;
  }

  return beats;
}

/**
 * The pictures this script gets, and which sections each one covers.
 *
 * Empty for a script with no cues — there is nothing to group, and the caller
 * treats that exactly as it treats a video with no cues at all.
 */
/**
 * True when this script was written to a beat structure rather than as prose.
 *
 * Every cue carrying a `beat` — HOOK, TENSION, MECHANISM and the rest — means
 * the script came from the single-insight format, where the author decided
 * where every shot changes and the whole genre depends on that happening every
 * three to five seconds.
 *
 * This is the signal that lets `footage.service.ts` and `render.service.ts`
 * reach the same picture count without either of them knowing the channel's
 * `footageStyle`, which was the reason this could not simply be configured:
 * the renderer deliberately reads what collection *produced* rather than what
 * the channel is set to today, so a setting it cannot see is no use to it. The
 * cues, both services already have.
 *
 * `every`, not `some`: a script where only half the cues carry a beat is a
 * parse that went wrong, and grouping half of it one way and half the other
 * would produce a video whose cutting rhythm changes halfway through for no
 * reason a viewer could name.
 */
function isBeatScripted(anchored: readonly AnchoredCue[]): boolean {
  return anchored.length > 0 && anchored.every((cue) => Boolean(cue.beat));
}

/**
 * True when this script's writer chose where every shot changes.
 *
 * The same signal `isBeatScripted` reads, one format later and for the same
 * reason: `footage.service.ts` and `render.service.ts` must reach an identical
 * grouping without either of them being able to see the channel's
 * `footageStyle`, and the cues are the only thing both of them have.
 *
 * `every`, not `some`. A script where half the cues carry a shot tag is a parse
 * that went wrong, and grouping half of it one way and half the other produces
 * a video whose cutting rhythm changes in the middle for no reason a viewer
 * could name.
 */
function isShotScripted(anchored: readonly AnchoredCue[]): boolean {
  return anchored.length > 0 && anchored.every((cue) => Boolean(cue.shot));
}

export function planStoryBeats(
  anchored: readonly AnchoredCue[],
  durationSeconds: number,
): StoryBeat[] {
  // One picture per cue, and none of the grouping below.
  //
  // The rest of this function exists to make a four-minute children's story
  // into ten to sixteen pictures held for fifteen to twenty-five seconds each,
  // because a picture cut faster than that becomes the slideshow YouTube's kids
  // principles name by its own word. The single-insight format is the exact
  // opposite instrument: forty-five seconds, twelve shots, three to five
  // seconds apiece, and the cutting *is* the form. Running it through
  // `beatCountFor` gives two pictures of twenty-two seconds — arithmetically
  // correct, and a slideshow of the other kind.
  //
  // So this is not a tuned constant but a different plan. `BEAT_MIN_SECONDS`
  // does not apply and must not: it is a floor written for the genre above, and
  // the format below deliberately lives beneath it.
  //
  // The long-form list format arrives at the same place from the other end. It
  // is eight minutes rather than forty-five seconds, but its writer is asked
  // for about forty sections rather than the fifty-odd an ordinary explainer
  // produces, and it tags each one `still` or `motion` — so the shot count IS
  // the section count, and grouping it again by seconds would undo the
  // decision the writer was asked to make. Left to the arithmetic below, forty
  // tagged cues across 480 seconds come out as twenty pictures of twenty-four
  // seconds; the format wants forty of twelve, which is again beneath
  // `BEAT_MIN_SECONDS` and again on purpose.
  //
  // `MAX_BEATS` is deliberately not applied on this path. It is a money
  // ceiling for the plan below, where the count is derived from a duration and
  // a four-hour input can ask for 720 generations off its own bat. Here the
  // writer's count is the count, it arrived with the script, and capping it
  // would drop shot forty-one silently — leaving the last minute of narration
  // with no picture over it to save five cents.
  if (isBeatScripted(anchored) || isShotScripted(anchored)) {
    return anchored.map((cue, index) => ({
      sectionIndices: [index],
      cues: [cue.cue],
    }));
  }

  let count = beatCountFor(durationSeconds, anchored.length);

  if (count === 0) {
    return [];
  }

  // Floored at 1 so a zero-width section — two cues that anchored to the same
  // position, which `anchorCues` can legitimately produce — still counts as
  // something rather than being free to pile up without moving a boundary.
  const weights = anchored.map((cue) => Math.max(1, cue.endChar - cue.startChar));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  // Seconds implied by a run of sections, from the character weights rather
  // than the real alignment. Deliberately: `footage.service.ts` has no
  // alignment to read and must reach the same grouping the renderer does, so
  // the *decision* is made on data both of them have. The renderer still times
  // the result off the real alignment (see `beatSeconds`), so this
  // approximation moves a beat boundary by at most a sentence and never puts a
  // picture under the wrong words.
  const impliedSeconds = (group: number[]) =>
    (group.reduce((sum, index) => sum + weights[index], 0) / totalWeight) * durationSeconds;

  let grouped = groupByWeight(weights, count);

  // Fewer, longer pictures until none is cut faster than the floor. Reducing
  // the count rather than merging one pair keeps every beat comparable — a
  // single merged beat among unmerged ones is the visible seam. Terminates:
  // `count` strictly decreases and one beat holding the whole narration cannot
  // be under the floor unless the whole narration is, which nothing can fix.
  while (count > 1 && grouped.some((group) => impliedSeconds(group) < BEAT_MIN_SECONDS)) {
    count -= 1;
    grouped = groupByWeight(weights, count);
  }

  return grouped.map((sectionIndices) => ({
    sectionIndices,
    cues: sectionIndices.map((index) => anchored[index].cue),
  }));
}

/**
 * How long each beat holds the screen, from the per-section durations the
 * renderer already computes.
 *
 * A plain sum, and that is the point: `sectionDurations` guarantees its output
 * covers [0, durationSeconds] with no gaps, so summing contiguous runs of it
 * gives beats that also cover the narration exactly. Nothing here can introduce
 * drift, because nothing here invents a number.
 */
export function beatSeconds(
  beats: readonly StoryBeat[],
  sectionSeconds: readonly number[],
): number[] {
  return beats.map((beat) =>
    beat.sectionIndices.reduce((sum, index) => sum + (sectionSeconds[index] ?? 0), 0),
  );
}
