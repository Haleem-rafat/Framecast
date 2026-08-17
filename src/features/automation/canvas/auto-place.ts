/**
 * Where a node with no saved position goes.
 *
 * This is the whole of the first-load experience, and the whole of "you just
 * made a new series and it appeared somewhere" — so it is a pure function with
 * its own tests rather than something eyeballed once and forgotten. Nothing
 * else in the canvas computes a position; every other node's is the operator's,
 * read back from `CanvasNode`.
 *
 * Deliberately dumb: step straight down from the anchor until a slot is
 * visually free. No packing, no force layout, no collision resolution beyond
 * one axis. Anything cleverer would eventually want to move a node the operator
 * had already placed, and that is the one thing a canvas with saved positions
 * must never do — a layout that "tidies up" is a layout that throws away the
 * arrangement the feature exists to preserve.
 */

/** Vertical gap between stacked nodes. Comfortably more than a node card's
 *  height so two placed by this function never touch. */
const STEP = 120;

/** How close counts as occupied. Two cards eight pixels apart overlap on
 *  screen, so "free" has to mean visually free rather than merely not-equal —
 *  otherwise a node dropped a hair off another's position makes this function
 *  place the next one straight through both. */
const CLEARANCE = 60;

/**
 * How far down this will look before giving up.
 *
 * A canvas cannot plausibly have five hundred unplaced nodes in one column, and
 * an unbounded loop inside a render path is a worse failure than a slight
 * overlap in a case that cannot happen. Returning the anchor on exhaustion puts
 * the node somewhere visible rather than nowhere.
 */
const MAX_STEPS = 500;

export interface Point {
  x: number;
  y: number;
}

export function autoPlace(taken: readonly Point[], anchor: Point): Point {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const candidate = { x: anchor.x, y: anchor.y + step * STEP };

    const clashes = taken.some(
      (point) =>
        Math.abs(point.x - candidate.x) < CLEARANCE &&
        Math.abs(point.y - candidate.y) < CLEARANCE,
    );

    if (!clashes) return candidate;
  }

  return anchor;
}
