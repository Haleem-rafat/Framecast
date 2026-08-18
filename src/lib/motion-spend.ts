import {
  billedSeconds,
  DEFAULT_REJECT_RATE,
  MAX_CLIP_SECONDS,
  MAX_CLIPS,
  type Manifest,
} from "@/lib/render-manifest";

/**
 * The ceiling on what one video may spend generating video, and the estimate
 * shown beside it.
 *
 * ## Why the ceiling is in seconds and not in dollars
 *
 * Because dollars are not discoverable. fal.ai publishes no billing endpoint —
 * `rest.alpha.fal.ai/billing/*` is a 404 — so at the moment this app has to
 * decide whether a video is affordable, the only quantity it can actually
 * measure is how many seconds of video it is about to ask for. A ceiling
 * denominated in dollars would be a ceiling denominated in a constant somebody
 * typed, enforced against a number nobody can check, and it would go quietly
 * wrong the first time a price changed. Seconds cannot go wrong: the request
 * says how long the clip is, and the provider bills by that.
 *
 * `estimateUsd` exists anyway, because "96 seconds" is not a quantity an
 * operator can feel. It is a *display* number and it is labelled as one
 * everywhere it appears. It is never the thing that refuses a video.
 *
 * ## Why it refuses rather than warns
 *
 * This is the first stage in Framecast that can spend tens of dollars on one
 * video without anyone watching. Every other provider here costs cents and
 * fails fast; a video model costs dollars and takes minutes, so by the time a
 * warning has been read the money is gone. A warning is advice about a decision
 * already taken.
 */

/**
 * The most billed seconds one video may buy.
 *
 * Not a round number and not a judgement — it is the largest manifest
 * `checkManifest` will accept, priced by `billedSeconds`:
 * `MAX_CLIPS × ceil(MAX_CLIP_SECONDS) × DEFAULT_REJECT_RATE` = 12 × 5 × 1.6 = 96.
 *
 * That derivation is the whole argument for the number. A ceiling *below* it
 * would refuse manifests the format's own validator accepts, which is two gates
 * disagreeing about the same manifest and an operator with no way to tell which
 * one to satisfy. A ceiling *above* it could never bind, because no legal
 * manifest reaches it. Ninety-six is the only value that is exactly "this
 * format's maximum, and not one second more".
 *
 * What it buys, at the rates the spec recorded: about $4 at $0.043/s, about $10
 * at $0.10/s, about $24 at $0.25/s. And — the number that matters more, from a
 * measured 217 seconds of wall time for one 5-second clip — roughly **an hour
 * and a quarter** of generation before a video is finished. This tier is not
 * merely expensive, it is slow, and the ceiling is what stops one mistake from
 * being both for a whole afternoon.
 */
export const MAX_BILLED_SECONDS_PER_VIDEO =
  MAX_CLIPS * Math.ceil(MAX_CLIP_SECONDS) * DEFAULT_REJECT_RATE;

/**
 * Dollars per billed second, for display only.
 *
 * **Operator-maintained and unverified.** No API returns this. It cannot be
 * fetched, it cannot be reconciled against an invoice from inside this app, and
 * it is certainly wrong for at least one of the models this adapter can reach —
 * the spec's own survey put text-to-video anywhere between $0.03 and $0.25 a
 * second, a factor of eight. This constant sits at the cheap end of that band
 * because the model the adapter defaults to is a cheap one, and an estimate
 * that reads low is the more dangerous mistake, which is why it is not the
 * guard.
 *
 * The guard is `MAX_BILLED_SECONDS_PER_VIDEO`. If this number is stale, an
 * operator sees a wrong dollar estimate; the seconds ceiling still refuses the
 * same manifests it always did. Change it when a real invoice says to.
 */
export const DISPLAY_USD_PER_BILLED_SECOND = 0.05;

/** The estimate, rounded to cents. See `DISPLAY_USD_PER_BILLED_SECOND` — this
 *  is a number to show an operator, never one to compare against a limit. */
export function estimateUsd(seconds: number): number {
  return Math.round(seconds * DISPLAY_USD_PER_BILLED_SECOND * 100) / 100;
}

export interface MotionSpendPlan {
  /** What the provider will bill, `checkManifest`'s reject multiplier included. */
  billedSeconds: number;
  /** What was compared against. Echoed so a refusal sentence can quote both
   *  numbers without the caller having to know which ceiling was in force. */
  ceilingSeconds: number;
  /** Display only. See `DISPLAY_USD_PER_BILLED_SECOND`. */
  estimatedUsd: number;
  withinCeiling: boolean;
  /**
   * The sentence to show an operator, whether or not it is affordable — the
   * approval screen and the refusal want the same numbers said the same way,
   * and computing them in two places is how the two come to disagree.
   */
  summary: string;
}

/**
 * Prices a manifest before anything is submitted.
 *
 * Pure, and that is what lets it be called twice: once to *show* an operator
 * what they are about to authorise, and again at enqueue to enforce it. The
 * second call is the one that matters — a spend the operator saw and a spend
 * the worker performs are only the same spend if the same function measured
 * both.
 */
export function planMotionSpend(
  manifest: Manifest,
  ceilingSeconds: number = MAX_BILLED_SECONDS_PER_VIDEO,
): MotionSpendPlan {
  const seconds = billedSeconds(manifest);
  const estimatedUsd = estimateUsd(seconds);

  return {
    billedSeconds: seconds,
    ceilingSeconds,
    estimatedUsd,
    withinCeiling: seconds <= ceilingSeconds,
    summary:
      `${manifest.clips.length} clips, ${seconds} billed seconds against a ` +
      `ceiling of ${ceilingSeconds} (about $${estimatedUsd.toFixed(2)} at an ` +
      `unverified $${DISPLAY_USD_PER_BILLED_SECOND.toFixed(2)}/s — the seconds ` +
      `are the guard, not the dollars)`,
  };
}
