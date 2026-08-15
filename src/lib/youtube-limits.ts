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

/** What separates the summary from the credits below it. Counted against the
 *  cap rather than assumed free — two characters is the difference between a
 *  description that fits and a 400 after the bytes are already sent. */
const DESCRIPTION_SEPARATOR = "\n\n";

/**
 * Builds the description YouTube receives: the summary first, the credits
 * after it, and the credits never cut.
 *
 * The order is what a viewer reads, and it is not a cosmetic choice. YouTube
 * shows roughly the first 150 characters above the fold and in search results,
 * so whatever leads the description is the whole of what most people ever see
 * of it. This used to be the credits — the Pixabay line, the music line and
 * the SOURCES list — which meant every video opened on an attribution block
 * and the summary the model wrote for exactly that slot was pushed out of
 * view.
 *
 * The obvious way to put the summary first would be to concatenate and let
 * `clampDescription` cut the tail, and that is precisely what must not happen:
 * the tail is now the attribution, and losing it breaks a licence term rather
 * than a sentence. So the credits are measured *first* and their exact length
 * (plus the separator) is reserved out of `DESCRIPTION_MAX`; the summary is
 * clamped to whatever is left, on a word boundary. The credits are then intact
 * by construction — a stronger guarantee than the old credits-first ordering,
 * which only made them *likely* to survive and would still have truncated them
 * for a long enough SOURCES list.
 *
 * Attribution wins outright in the one case where nothing else can fit: if the
 * credits alone are at or over the cap there is no room for a summary, and the
 * credits are returned on their own rather than sacrificing a licence line to
 * make space for prose.
 *
 * `clampDescription` still runs over the assembled result. It cannot fire —
 * the arithmetic above already guarantees the fit — and that is the point of
 * keeping it: it is the backstop that holds if this function's reservation is
 * ever wrong, at the one call site that knows what is about to be sent.
 */
export function composeDescription(
  /** The model's own summary of the video (`Video.generatedDescription`, or a
   *  short's own). Absent for anything whose metadata stage never ran. */
  summary: string | null | undefined,
  /** The Pixabay credit, the music credit and the script's SOURCES list, as
   *  `buildDescription` assembles them. Owed in full, every time. */
  credits: string,
): string {
  const trimmedSummary = summary?.trim() ?? "";
  const trimmedCredits = credits.trim();

  if (!trimmedCredits) {
    return clampDescription(trimmedSummary);
  }

  if (!trimmedSummary) {
    return clampDescription(trimmedCredits);
  }

  const available =
    DESCRIPTION_MAX - trimmedCredits.length - DESCRIPTION_SEPARATOR.length;

  // No room for a single character of summary alongside the credits, so the
  // credits stand alone. Still clamped, because `credits.length` can itself be
  // over the cap — in which case a truncated attribution is all there is, and
  // it is still better than dropping the block entirely.
  if (available <= 0) {
    return clampDescription(trimmedCredits);
  }

  const clampedSummary = truncateOnWord(trimmedSummary, available);

  return clampDescription(
    `${clampedSummary}${DESCRIPTION_SEPARATOR}${trimmedCredits}`,
  );
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
