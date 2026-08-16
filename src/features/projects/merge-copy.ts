/**
 * The sentences the merge confirmation puts in front of an operator, as
 * functions of `projectService.mergeImpact`.
 *
 * Pure and separate from the dialog for the same reason `deletion-copy.ts` is:
 * this repo's Vitest environment is `node`, so there is no DOM to render a
 * dialog into, and these strings are a promise about something that cannot be
 * undone — how many videos change which channel they would upload to, and how
 * many projects stop existing. A dropped clause here is a defect, not a typo.
 */

export interface MergeImpactCopy {
  target: { name: string; channelTitle: string | null };
  sources: {
    name: string;
    channelId: string | null;
    channelTitle: string | null;
    videoCount: number;
  }[];
  videoCount: number;
  scheduleCount: number;
  seriesCount: number;
  blockers: string[];
}

function count(n: number, singular: string, plural = `${singular}s`) {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/** "a", "a and b", "a, b and c" — an Oxford-comma-free list. */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What the merge moves, and what stops existing.
 *
 * Schedules and series are named separately from videos rather than summed
 * into "items". They are the part an operator has no reason to expect: "merge
 * two projects" reads as tidying a folder, and it also moves the thing that
 * fires every Tuesday morning. The alternative — moving them silently — is how
 * a schedule ends up pointing at a project nobody can see.
 */
export function describeMerge(impact: MergeImpactCopy): string {
  const names = joinNames(impact.sources.map((source) => `"${source.name}"`));
  const it = impact.sources.length === 1 ? "it" : "them";

  const total = impact.videoCount + impact.scheduleCount + impact.seriesCount;
  const moved = [
    impact.videoCount > 0 ? count(impact.videoCount, "video") : null,
    impact.scheduleCount > 0 ? count(impact.scheduleCount, "schedule") : null,
    // "series" is its own plural, so it needs no branch.
    impact.seriesCount > 0 ? `${impact.seriesCount} series` : null,
  ].filter((part): part is string => part !== null);

  // An empty project is worth merging too — it is one fewer row in a list of
  // 39 — and saying "0 videos move" would be a strange way to put that.
  if (moved.length === 0) {
    return (
      `${names} ${impact.sources.length === 1 ? "is" : "are"} deleted. Nothing is ` +
      `filed under ${it}, so nothing moves into "${impact.target.name}".`
    );
  }

  return (
    `${names} ${impact.sources.length === 1 ? "is" : "are"} deleted, and the ` +
    `${joinNames(moved)} filed under ${it} ${total === 1 ? "moves" : "move"} into ` +
    `"${impact.target.name}". Nothing is unpublished and nothing is removed from ` +
    "YouTube."
  );
}

/**
 * The one consequence a legal merge still has: videos that could not publish
 * anywhere gain a channel they can.
 *
 * `null` when no source is in that state. This is not a refusal — it is a
 * genuine improvement, since those videos had no publishing target at all —
 * but it is still a change to where something uploads, and the whole design
 * rule here is that those are never made quietly.
 */
export function describeChannelGain(impact: MergeImpactCopy): string | null {
  if (impact.target.channelTitle === null) return null;

  const gaining = impact.sources.filter(
    (source) => source.channelId === null && source.videoCount > 0,
  );

  if (gaining.length === 0) return null;

  const videos = gaining.reduce((total, source) => total + source.videoCount, 0);

  return (
    `${count(videos, "video")} in ${joinNames(gaining.map((source) => `"${source.name}"`))} ` +
    `currently ${videos === 1 ? "has" : "have"} no channel and cannot be published at ` +
    `all. After this ${videos === 1 ? "it publishes" : "they publish"} to ` +
    `${impact.target.channelTitle}.`
  );
}

/**
 * Every reason the merge will be refused, said before the click rather than
 * delivered as a toast after it. `null` when nothing is blocking — the dialog
 * uses that to decide whether to arm the button, so "no message" and "safe to
 * proceed" are deliberately the same answer.
 *
 * The sentences themselves come from `ProjectService`, not from here: they are
 * the same strings `merge` throws, so the pre-check can never drift into
 * disagreeing with the check that actually holds.
 */
export function describeMergeRefusal(impact: MergeImpactCopy): string | null {
  return impact.blockers.length > 0 ? impact.blockers.join(" ") : null;
}
