/**
 * A stable colour per channel, so a branch is identifiable at a glance.
 *
 * ## Why a hash rather than a stored column
 *
 * The alternative is letting the operator pick, which means a colour column, a
 * picker, a migration and a default — for a value whose entire job is "these
 * two branches are different". A hash gives that for nothing, and gives it
 * *stably*: the same channel is the same colour on every device, in every
 * session, without anything being written down. If somebody later wants to
 * choose, this becomes the fallback rather than being thrown away.
 *
 * ## Why hues, not palette entries
 *
 * A fixed palette of six runs out at the seventh channel and starts repeating
 * in a way that looks like a bug. Rotating the hue by the golden angle spreads
 * any number of channels as far apart as they can go — the same trick used for
 * generating distinguishable series colours — and lightness and chroma stay
 * fixed so every branch has the same visual weight. No channel gets to look
 * more important than another because of its id.
 *
 * Lightness is given twice, for light and dark themes, because one value cannot
 * sit legibly on both. Chroma is deliberately low: these tint a border and an
 * icon chip beside real content, and a saturated ring around every card turns
 * the canvas into a toy.
 */

/**
 * ~137.5°, the golden angle. Successive multiples never fall close together,
 * so channels one and two are as far apart as channels eight and nine.
 */
const GOLDEN_ANGLE = 137.508;

/** Fixed so no branch outshouts another. */
const CHROMA = 0.11;
const LIGHTNESS_LIGHT = 0.55;
const LIGHTNESS_DARK = 0.72;

/**
 * FNV-1a. Chosen over `String.prototype.split().reduce()` arithmetic because it
 * avalanches properly: two uuids differing in one character land far apart,
 * where a naive sum of char codes would put them side by side.
 */
function hash(value: string): number {
  let result = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    // The FNV prime, as shifts, because a plain `* 16777619` overflows into
    // float territory and loses the low bits that carry the entropy.
    result +=
      (result << 1) + (result << 4) + (result << 7) + (result << 8) + (result << 24);
  }

  return result >>> 0;
}

export interface BranchColour {
  /** For a border or a ring in the light theme. */
  light: string;
  /** The same hue, lifted so it reads on a dark background. */
  dark: string;
  /** The raw hue, for a caller that wants to build its own colour from it. */
  hue: number;
}

export function branchColour(channelId: string | null): BranchColour {
  // The unrooted branch is not a channel and must not look like one. Zero
  // chroma is grey at any hue, which is exactly the "this belongs to nothing"
  // it needs — the node's own destructive border carries the warning.
  if (channelId === null) {
    return {
      light: `oklch(${LIGHTNESS_LIGHT} 0 0)`,
      dark: `oklch(${LIGHTNESS_DARK} 0 0)`,
      hue: 0,
    };
  }

  const hue = (hash(channelId) * GOLDEN_ANGLE) % 360;

  return {
    light: `oklch(${LIGHTNESS_LIGHT} ${CHROMA} ${hue.toFixed(2)})`,
    dark: `oklch(${LIGHTNESS_DARK} ${CHROMA} ${hue.toFixed(2)})`,
    hue,
  };
}
