/**
 * YouTube's own field limits, enforced before the upload rather than
 * discovered during it.
 *
 * A rejection arrives as a 400 after the video bytes have already been sent —
 * the most expensive possible moment to learn the title was too long, since
 * the upload is the single most quota-costly call this app makes (1,600 units
 * against a daily allowance).
 */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
/** Combined length of every tag, not the count. */
export const TAGS_MAX = 500;

/** Cuts at the last space inside the limit, so a clipped title reads as short
 *  rather than as broken. Falls back to a hard cut when the text has no space
 *  to cut at — a single 200-character word is not a case worth preserving. */
function truncateOnWord(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  const hardCut = value.slice(0, max);
  const lastSpace = hardCut.lastIndexOf(" ");

  return lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut;
}

export function clampTitle(value: string): string {
  return truncateOnWord(value.trim(), TITLE_MAX);
}

export function clampDescription(value: string): string {
  return truncateOnWord(value.trim(), DESCRIPTION_MAX);
}

/**
 * Drops whole tags from the end until the combined length fits.
 *
 * Never truncates a tag: half of "cryptocurrency" is a different word that
 * nobody searches for, so a shortened tag is worse than an absent one.
 */
export function clampTags(tags: string[]): string[] {
  const kept: string[] = [];
  let combined = 0;

  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) {
      continue;
    }
    if (combined + tag.length > TAGS_MAX) {
      break;
    }
    kept.push(tag);
    combined += tag.length;
  }

  return kept;
}

export function withinLimits(input: {
  title: string;
  description: string;
  tags: string[];
}): boolean {
  return (
    input.title.length <= TITLE_MAX &&
    input.description.length <= DESCRIPTION_MAX &&
    input.tags.join("").length <= TAGS_MAX
  );
}
