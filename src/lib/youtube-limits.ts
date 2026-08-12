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

  const result = lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut;
  // Trim trailing spaces (e.g., when two spaces meet at the cut boundary)
  // so output reads as intentionally short, not trailing off.
  return result.trimEnd();
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
 *
 * Measures in comma-separated form as YouTube does: `tag1,tag2,tag3`. Tags
 * containing commas or spaces are quoted, adding 2 characters. The naive sum
 * of bare tag lengths is the obvious wrong answer but measurably false: 125
 * four-char tags sum to 500 bare but 624 when joined, which YouTube rejects.
 */
export function clampTags(tags: string[]): string[] {
  const kept: string[] = [];
  let joined = "";

  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) {
      continue;
    }

    // Quote tags containing commas or spaces; these characters require escaping
    // in comma-separated form and add 2 characters (the quotes themselves).
    const needsQuotes = tag.includes(",") || tag.includes(" ");
    const quoted = needsQuotes ? `"${tag}"` : tag;

    // Simulate the joined form: prepend a comma if we already have tags
    const addition = kept.length > 0 ? `,${quoted}` : quoted;

    if ((joined + addition).length > TAGS_MAX) {
      break;
    }

    kept.push(tag);
    joined += addition;
  }

  return kept;
}

export function withinLimits(input: {
  title: string;
  description: string;
  tags: string[];
}): boolean {
  // Measure tags in comma-separated form, accounting for quoting.
  const joined = input.tags
    .map(tag => {
      const trimmed = tag.trim();
      if (!trimmed) {
        return "";
      }
      const needsQuotes = trimmed.includes(",") || trimmed.includes(" ");
      return needsQuotes ? `"${trimmed}"` : trimmed;
    })
    .filter(Boolean)
    .join(",");

  return (
    input.title.length <= TITLE_MAX &&
    input.description.length <= DESCRIPTION_MAX &&
    joined.length <= TAGS_MAX
  );
}
