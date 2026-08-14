import type { VideoStatus } from "@/generated/prisma/enums";

/**
 * The shared shape of a search, and the two numbers both ends have to agree
 * on.
 *
 * Split out of `search.service.ts` because that file is `server-only` — one
 * import of it from the command palette (a client component) fails the build
 * outright. The palette needs `MIN_QUERY_LENGTH` as a *value*, not just a
 * type: it enforces the same floor client-side so a one-character query costs
 * no round trip at all, and it explains the floor to the operator in words
 * ("searches start at N characters"). Duplicating the number instead would be
 * how the two ends silently drift apart.
 */

/**
 * Below this, don't touch the database at all.
 *
 * A single character matches a substantial fraction of every row in five
 * tables, so the query is at its most expensive exactly when its results are
 * at their least useful — and the palette would fire it on the way to every
 * real search, since you cannot type "inflation" without first typing "i".
 * Two characters is the shortest prefix that meaningfully narrows anything.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * Per-group ceiling. The palette is a keyboard surface with a ~288px list; a
 * group that returned forty videos would bury the navigation commands under a
 * scroll nobody asked for. `truncated` on each group is what keeps this
 * honest — the UI says "first 5 matches" rather than silently pretending five
 * is all there was.
 */
export const RESULTS_PER_GROUP = 5;

export type SearchResultType =
  | "video"
  | "script"
  | "project"
  | "channel"
  | "prompt";

export interface SearchResult {
  type: SearchResultType;
  /** Stable identity for the palette's list — unique within a response. */
  id: string;
  /** Where selecting this result navigates. */
  href: string;
  title: string;
  /** Secondary line: the topic, the handle, the matched snippet. */
  subtitle: string | null;
  /** Videos only — the palette renders it as the status badge. */
  status: VideoStatus | null;
}

export interface SearchGroup {
  type: SearchResultType;
  label: string;
  results: SearchResult[];
  /** True when the operator has more matches than `RESULTS_PER_GROUP`. */
  truncated: boolean;
}

export interface SearchResponse {
  /** Echoed back so a client can discard a response its input has outrun. */
  query: string;
  /** Groups with no matches are dropped; an empty array means "nothing found". */
  groups: SearchGroup[];
  /** True when the query was too short to run — the UI prompts rather than saying "no results". */
  tooShort: boolean;
}
