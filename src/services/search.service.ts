import "server-only";

import { PromptCategory } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import {
  MIN_QUERY_LENGTH,
  RESULTS_PER_GROUP,
  type SearchGroup,
  type SearchResponse,
} from "@/lib/search";

// Re-exported so server callers have one import site for the whole feature,
// while the palette — a client component that must never pull in a
// `server-only` module — imports the same contract straight from `@/lib/search`.
export {
  MIN_QUERY_LENGTH,
  RESULTS_PER_GROUP,
  type SearchGroup,
  type SearchResponse,
  type SearchResult,
  type SearchResultType,
} from "@/lib/search";

/**
 * Cross-content search for the command palette.
 *
 * Every query in this file is scoped to one operator. Three of the five models
 * searched (`Video`, `Project`, `Channel`, `PromptTemplate`) carry a `userId`
 * column and are filtered on it directly; `ScriptVersion` carries none at all
 * and is reached through `script.video.userId`, the same walk-back
 * `studio.service.ts` documents. There is no unscoped `findMany` here on
 * purpose: this service answers a string typed into a box, so a missing
 * `userId` would not fail loudly — it would quietly hand one operator another
 * operator's video titles, and the result would look exactly like a working
 * search. Anyone adding a model here must add its scoping and its
 * cross-user test in the same commit.
 *
 * The matching itself is Postgres `ILIKE '%term%'` (Prisma's `contains` +
 * `mode: "insensitive"`). That is a sequential scan per table, which is the
 * honest thing to run at this volume: the rows are already narrowed to one
 * operator's content — hundreds of videos, not millions — and a substring
 * match is what an operator typing half a title actually expects. It is
 * deliberately not full-text search: `to_tsquery` stems and tokenises, so
 * "antikyth" would stop matching "antikythera", and a search box that fails on
 * a partial word is worse than a slow one. If one operator's library ever
 * grows to where these scans are felt, the cheap next step is a `pg_trgm` GIN
 * index — which accelerates this exact `ILIKE` without changing a line of the
 * matching semantics below — not a rewrite onto tsvector or a search service.
 */

/** Characters either side of a script match to keep in the snippet. */
const SNIPPET_PADDING = 60;

/**
 * Neutralises the LIKE wildcards inside the operator's own text.
 *
 * Prisma's `contains` wraps the value in `%…%` but passes the rest through
 * verbatim, so a literal `%` typed into the box becomes a wildcard and matches
 * every row — an empty-looking query returning the entire library. `_` has the
 * same problem one character at a time. Postgres' default LIKE escape
 * character is a backslash, so escaping the backslash first and then the two
 * wildcards makes each of them match itself, with no `ESCAPE` clause needed
 * (which Prisma's query API could not express anyway).
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Splits a `take: n + 1` fetch into the page shown and whether more exist.
 *
 * Asking for one extra row is how every group learns it was truncated without
 * a second `count` query per model — five extra round trips per keystroke to
 * populate one "and more" label would cost more than the search itself.
 */
function paginate<T>(rows: T[]): { page: T[]; truncated: boolean } {
  return {
    page: rows.slice(0, RESULTS_PER_GROUP),
    truncated: rows.length > RESULTS_PER_GROUP,
  };
}

/**
 * The categories whose *name* the operator appears to be typing.
 *
 * `PromptCategory` is a Postgres enum, so `contains` cannot be applied to it —
 * Prisma only offers equality and `in`. Resolving the term to concrete enum
 * members here keeps "thumb" finding the THUMBNAIL templates without the query
 * having to cast the column to text and defeat its index.
 */
function matchingCategories(term: string): PromptCategory[] {
  const needle = term.toLowerCase();
  return Object.values(PromptCategory).filter((category) =>
    category.toLowerCase().includes(needle),
  );
}

/**
 * A window of script text around the first match, so the palette shows the
 * sentence the operator was looking for rather than the first line of a
 * two-thousand-word narration that happens to mention it in the middle.
 *
 * Case-insensitive to match the ILIKE that selected this row; if the term
 * somehow isn't found (it always is, barring a collation edge case) the head
 * of the script is a truthful fallback rather than an error.
 */
function snippet(content: string, term: string): string {
  const index = content.toLowerCase().indexOf(term.toLowerCase());
  const start = index < 0 ? 0 : Math.max(0, index - SNIPPET_PADDING);
  const end = Math.min(
    content.length,
    (index < 0 ? 0 : index + term.length) + SNIPPET_PADDING,
  );

  // Newlines inside a narration would break the single-line result row, and
  // the operator is reading this as a fragment, not as formatted prose.
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();

  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

export class SearchService {
  /**
   * @param userId The signed-in operator. Every query below filters on it.
   * @param rawQuery Whatever is in the palette's input, untrimmed.
   */
  async search(userId: string, rawQuery: string): Promise<SearchResponse> {
    const query = rawQuery.trim();

    if (query.length < MIN_QUERY_LENGTH) {
      return { query, groups: [], tooShort: true };
    }

    const term = escapeLike(query);
    const contains = { contains: term, mode: "insensitive" as const };

    // One round trip's worth of latency for five tables rather than five.
    // They share nothing and none of them can invalidate another, so there is
    // no ordering to preserve — and the palette is waiting on the slowest of
    // them either way.
    const [videos, scripts, projects, channels, prompts] = await Promise.all([
      prisma.video.findMany({
        where: {
          userId,
          deletedAt: null,
          OR: [{ title: contains }, { topic: contains }],
        },
        orderBy: { updatedAt: "desc" },
        take: RESULTS_PER_GROUP + 1,
        select: { id: true, title: true, topic: true, status: true },
      }),

      // Searched through `script.activeVersion` rather than across every
      // `ScriptVersion` row. A video that has been regenerated four times has
      // four versions of nearly the same narration, and matching all of them
      // would return the same video four times over for text three of those
      // rows no longer represent. The active version is the one the operator
      // can actually open and read.
      //
      // Scoped through the relation because `Script` and `ScriptVersion` carry
      // no `userId` of their own — `{ video: { userId, deletedAt: null } }` is
      // the only correct filter here, exactly as in `studio.service.ts`.
      prisma.script.findMany({
        where: {
          video: { userId, deletedAt: null },
          activeVersion: { content: contains },
        },
        orderBy: { updatedAt: "desc" },
        take: RESULTS_PER_GROUP + 1,
        select: {
          video: { select: { id: true, title: true } },
          activeVersion: { select: { id: true, content: true } },
        },
      }),

      prisma.project.findMany({
        where: { userId, deletedAt: null, name: contains },
        orderBy: { updatedAt: "desc" },
        take: RESULTS_PER_GROUP + 1,
        select: { id: true, name: true, description: true },
      }),

      prisma.channel.findMany({
        where: {
          userId,
          deletedAt: null,
          OR: [{ title: contains }, { handle: contains }],
        },
        orderBy: { connectedAt: "desc" },
        take: RESULTS_PER_GROUP + 1,
        select: { id: true, title: true, handle: true },
      }),

      prisma.promptTemplate.findMany({
        where: {
          userId,
          deletedAt: null,
          OR: [
            { name: contains },
            { description: contains },
            // Empty `in` is a valid, always-false filter, so a term matching no
            // category simply contributes nothing to the OR.
            { category: { in: matchingCategories(query) } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: RESULTS_PER_GROUP + 1,
        select: { id: true, name: true, description: true, category: true },
      }),
    ]);

    const groups: SearchGroup[] = [];

    const videoPage = paginate(videos);
    if (videoPage.page.length > 0) {
      groups.push({
        type: "video",
        label: "Videos",
        truncated: videoPage.truncated,
        results: videoPage.page.map((video) => ({
          type: "video" as const,
          id: video.id,
          href: `/videos/${video.id}`,
          title: video.title,
          subtitle: video.topic,
          status: video.status,
        })),
      });
    }

    // A video whose title *and* script both match appears in both groups. That
    // is deliberate: the two rows say different things ("this video is called
    // X" versus "X is said inside this script"), and de-duplicating would mean
    // resolving the video group before the script query could run, turning the
    // parallel fan-out above into two serial waves for a cosmetic gain.
    const scriptPage = paginate(scripts);
    if (scriptPage.page.length > 0) {
      groups.push({
        type: "script",
        label: "Script text",
        truncated: scriptPage.truncated,
        results: scriptPage.page.flatMap((script) =>
          // `activeVersion` is non-null by construction — the `where` above
          // filters on its content — but Prisma types the relation as
          // optional, and flatMap narrows it without an assertion.
          script.activeVersion
            ? [
                {
                  type: "script" as const,
                  id: script.activeVersion.id,
                  href: `/videos/${script.video.id}`,
                  title: script.video.title,
                  subtitle: snippet(script.activeVersion.content, query),
                  status: null,
                },
              ]
            : [],
        ),
      });
    }

    const projectPage = paginate(projects);
    if (projectPage.page.length > 0) {
      groups.push({
        type: "project",
        label: "Projects",
        truncated: projectPage.truncated,
        results: projectPage.page.map((project) => ({
          type: "project" as const,
          id: project.id,
          // No per-project route exists, so this lands on the list that holds
          // it rather than advertising a 404.
          href: "/projects",
          title: project.name,
          subtitle: project.description,
          status: null,
        })),
      });
    }

    const channelPage = paginate(channels);
    if (channelPage.page.length > 0) {
      groups.push({
        type: "channel",
        label: "Channels",
        truncated: channelPage.truncated,
        results: channelPage.page.map((channel) => ({
          type: "channel" as const,
          id: channel.id,
          href: "/channels",
          title: channel.title,
          subtitle: channel.handle,
          status: null,
        })),
      });
    }

    const promptPage = paginate(prompts);
    if (promptPage.page.length > 0) {
      groups.push({
        type: "prompt",
        label: "Prompt templates",
        truncated: promptPage.truncated,
        results: promptPage.page.map((prompt) => ({
          type: "prompt" as const,
          id: prompt.id,
          href: "/prompts",
          title: prompt.name,
          subtitle: prompt.description ?? prompt.category,
          status: null,
        })),
      });
    }

    return { query, groups, tooShort: false };
  }
}

export const searchService = new SearchService();
