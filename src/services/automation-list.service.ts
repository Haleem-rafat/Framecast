import "server-only";

import type { ScheduleStatus } from "@/generated/prisma/enums";
import { describeCadence, describeHealth } from "@/lib/automation-language";
import { prisma } from "@/lib/prisma";

/**
 * Everything that makes videos on a repeating cadence, as one list.
 *
 * ## Why this file exists
 *
 * The operator could not tell their own automations apart. The same idea — a
 * thing that makes videos over and over on a timer — was split across two
 * screens and drawn two different ways: series as a real data table, schedules
 * as a stack of cards, and a series' cadence listed *again* on the schedules
 * page as a third row referring back to the first. Finding "the thing that
 * publishes to my finance channel on Mondays" meant knowing which of two
 * internal models it happened to be stored as, which is a question about this
 * codebase and not about their work.
 *
 * A series *is* a schedule with a recipe attached — `Schedule.seriesId`, unique
 * — and that relationship is an implementation detail the landing page should
 * never have leaked. This service is the read model that stops leaking it: one
 * row per automation, each saying plainly what it is, where it publishes, when
 * it next fires and whether it is healthy.
 *
 * ## Why it reads Prisma directly
 *
 * `SeriesService.list` and `ScheduleService.list` both exist and both return
 * almost the right thing. Neither is used, for two reasons. The shapes disagree
 * in exactly the places that matter (a schedule knows its project, a series
 * knows its channel; a series counts videos, a schedule counts nothing), so
 * composing them would mean a second pass of lookups to fill the gaps. And a
 * series-owned schedule appears in *both* lists, so composing them would
 * produce the duplicate rows this whole change exists to remove — the schedule
 * half of this read model is explicitly `seriesId: null`.
 *
 * Both of those services stay exactly as they are: they back the detail pages
 * and every write path, which is where their guards belong. This is a
 * read-only projection for one screen, and it owns no rules.
 *
 * ## The seam for a third kind
 *
 * `SOURCES` is a list, not a pair. A shorts release cadence is being built
 * alongside this, and it is the same idea again — a status, a paused reason, a
 * consecutive-failure counter, a next occurrence, a channel — so it becomes
 * rows here rather than a third screen. Adding it is three edits and no
 * redesign:
 *
 *   1. add its name to `AutomationKind`,
 *   2. push a loader onto `SOURCES` that maps its rows to `AutomationEntry`,
 *   3. add its label, icon and controls to `AUTOMATION_KINDS` in
 *      src/features/automation/kinds.ts.
 *
 * Nothing in the table, the sort, the search, the empty state, the mobile cards
 * or the health column has to know that a third kind arrived. The one thing a
 * new kind must do is describe its own cadence as a *sentence* — see
 * `AutomationEntry.cadence` — because a release cadence has several times a day
 * and no weekday, and a shared recurrence shape would have had to grow a case
 * for it.
 */

/**
 * What sort of thing a row is, in the operator's terms rather than the
 * database's.
 *
 * `TOPIC_QUEUE` is a standalone `Schedule` — a cadence and a list of subjects,
 * using the account's default script style. `SERIES` is the same cadence with a
 * name, a channel, a script style and a shape pinned to it. The row says which
 * so that "why does this one have a Make one now button and that one not" has a
 * visible answer.
 */
export type AutomationKind = "SERIES" | "TOPIC_QUEUE";

export interface AutomationEntry {
  /**
   * Unique across every kind, because two kinds are two tables and their ids
   * are only unique within one. Used as the React key and the `DataTable` row
   * id; never in a URL.
   */
  rowId: string;
  /** The underlying row's own id, which the controls act on. */
  id: string;
  kind: AutomationKind;
  name: string;
  /** This automation's own page. Owned by the row rather than derived from the
   *  kind, so a future kind can point somewhere with a different shape. */
  href: string;
  status: ScheduleStatus;
  /** Null for an automation the operator paused by hand. Set — always with a
   *  sentence — by every path that stops one on its own. `describeHealth` reads
   *  exactly this to tell the two apart. */
  pausedReason: string | null;
  consecutiveFailures: number;
  /**
   * The rule as a finished sentence: "Every Monday at 6:00 AM, Cairo time".
   *
   * A string rather than the recurrence fields. Weekly-or-monthly is one kind's
   * shape, not the table's, and the release cadence being built beside this has
   * a set of times of day instead — so the column has to hold prose or it has
   * to hold a union that grows a branch per kind.
   */
  cadence: string;
  /** The zone the times above and `nextRunAt` below are read in. */
  timeZone: string;
  /** Null while paused — and meaningless then anyway, since showing a time
   *  would advertise a video that is not coming. */
  nextRunAt: Date | null;
  /** What the next run will make, when the kind can say. */
  nextUp: string | null;
  /** How much work is banked before this stalls, or null for a kind with no
   *  queue. Zero is the number that matters: it is what makes `nextRunAt` a
   *  lie. */
  backlog: number | null;
  /** How many videos this has produced so far. */
  produced: number;
  /** Where it publishes. Null only for a standalone schedule whose project has
   *  no channel — the one case where nothing can be said truthfully. */
  channel: { id: string; title: string } | null;
  /** Where the videos are filed. Null for a kind that is not project-scoped. */
  project: { id: string; name: string } | null;
}

/** One kind's loader. A source owns its own query and its own mapping, and
 *  knows nothing about the others. */
type AutomationSource = (userId: string) => Promise<AutomationEntry[]>;

/**
 * Series, each with the schedule it owns.
 *
 * The video count is the series' own videos rather than its successful runs,
 * and deliberately: "Make one now" produces an episode without an occurrence,
 * so counting runs would under-report a show the operator has been driving by
 * hand.
 */
const loadSeries: AutomationSource = async (userId) => {
  const rows = await prisma.series.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      channelId: true,
      channel: { select: { title: true } },
      projectId: true,
      project: { select: { name: true } },
      _count: { select: { videos: { where: { deletedAt: null } } } },
      schedule: {
        select: {
          status: true,
          pausedReason: true,
          consecutiveFailures: true,
          frequency: true,
          dayOfWeek: true,
          dayOfMonth: true,
          hour: true,
          minute: true,
          timeZone: true,
          nextRunAt: true,
          // Only the head, exactly as both list services do it: the next topic
          // is the one worth showing, and the rest is a count.
          topics: {
            where: { consumedAt: null },
            orderBy: { position: "asc" },
            take: 1,
            select: { topic: true },
          },
          _count: { select: { topics: { where: { consumedAt: null } } } },
        },
      },
    },
  });

  // A series with no schedule cannot happen — the pair is written together and
  // retired together — but the foreign key lives on `Schedule`, so the relation
  // is optional and the compiler is right to insist. Skipped rather than shown
  // half-drawn: a row with no cadence has nothing truthful for three columns.
  return rows.flatMap((row) => {
    const schedule = row.schedule;

    if (!schedule) return [];

    return [
      {
        rowId: `series:${row.id}`,
        id: row.id,
        kind: "SERIES" as const,
        name: row.name,
        href: `/automation/series/${row.id}`,
        status: schedule.status,
        pausedReason: schedule.pausedReason,
        consecutiveFailures: schedule.consecutiveFailures,
        cadence: describeCadence(schedule),
        timeZone: schedule.timeZone,
        nextRunAt: schedule.nextRunAt,
        nextUp: schedule.topics[0]?.topic ?? null,
        backlog: schedule._count.topics,
        produced: row._count.videos,
        channel: { id: row.channelId, title: row.channel.title },
        project: { id: row.projectId, name: row.project.name },
      },
    ];
  });
};

/**
 * Schedules that belong to no series.
 *
 * `seriesId: null` is the whole merge. Without it a show appears twice — once
 * as itself and once as the cadence underneath it — which is the duplication
 * the old schedules page papered over with a "Series: …" badge pointing back at
 * the other row.
 *
 * The channel comes through the project, which is how the renderer resolves it
 * too (`video -> project -> channel`), so the column says where a video from
 * this schedule would actually end up rather than where anybody hoped.
 */
const loadTopicQueues: AutomationSource = async (userId) => {
  const rows = await prisma.schedule.findMany({
    where: { userId, deletedAt: null, seriesId: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
      pausedReason: true,
      consecutiveFailures: true,
      frequency: true,
      dayOfWeek: true,
      dayOfMonth: true,
      hour: true,
      minute: true,
      timeZone: true,
      nextRunAt: true,
      projectId: true,
      project: {
        select: {
          name: true,
          channelId: true,
          channel: { select: { title: true } },
        },
      },
      topics: {
        where: { consumedAt: null },
        orderBy: { position: "asc" },
        take: 1,
        select: { topic: true },
      },
      _count: {
        select: {
          topics: { where: { consumedAt: null } },
          // A schedule tags no videos of its own, so its output is the runs
          // that produced one. Occurrences that skipped or failed are excluded
          // — the column is "what did this make", not "how often did it try".
          runs: { where: { videoId: { not: null } } },
        },
      },
    },
  });

  return rows.map((row) => ({
    rowId: `schedule:${row.id}`,
    id: row.id,
    kind: "TOPIC_QUEUE" as const,
    name: row.name,
    href: `/automation/schedules/${row.id}`,
    status: row.status,
    pausedReason: row.pausedReason,
    consecutiveFailures: row.consecutiveFailures,
    cadence: describeCadence(row),
    timeZone: row.timeZone,
    nextRunAt: row.nextRunAt,
    nextUp: row.topics[0]?.topic ?? null,
    backlog: row._count.topics,
    produced: row._count.runs,
    channel:
      row.project.channelId && row.project.channel
        ? { id: row.project.channelId, title: row.project.channel.title }
        : null,
    project: { id: row.projectId, name: row.project.name },
  }));
};

/** Add a kind here. See the note at the top of this file. */
const SOURCES: AutomationSource[] = [loadSeries, loadTopicQueues];

/**
 * The order the operator sees on load, and the reason the table passes no
 * default sort.
 *
 * Attention first: anything that has stopped, then anything failing its way
 * towards stopping, then everything that is fine — ranked by the same
 * `describeHealth` the column renders, so the top of the list and the badge
 * beside it can never disagree. Within a rank, whatever fires soonest, because
 * among healthy automations that is the only question left. A paused row has no
 * next occurrence and sinks to the bottom of its own group rather than to the
 * top on a null.
 */
function compareEntries(a: AutomationEntry, b: AutomationEntry): number {
  const rank = describeHealth(b).rank - describeHealth(a).rank;

  if (rank !== 0) return rank;

  const left = a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY;

  if (left !== right) return left - right;

  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export class AutomationListService {
  /**
   * Every recurring automation this account owns.
   *
   * The sources run together rather than in sequence — they touch different
   * tables and nothing here depends on anything there — so the page pays for
   * the slowest one rather than the sum.
   */
  async list(userId: string): Promise<AutomationEntry[]> {
    const batches = await Promise.all(SOURCES.map((source) => source(userId)));

    return batches.flat().sort(compareEntries);
  }
}

export const automationListService = new AutomationListService();
