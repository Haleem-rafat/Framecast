import "server-only";

import type { PublishVisibility, ScheduleStatus } from "@/generated/prisma/enums";
import { describeCadence, describeHealth } from "@/lib/automation-language";
import { prisma } from "@/lib/prisma";
import { describeSlots } from "@/lib/release-time";

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
 * ## The seam for a further kind
 *
 * `SOURCES` is a list, not a pair. The shorts release cadence arrived through
 * it: the same idea again — a status, a paused reason, a consecutive-failure
 * counter, a next occurrence, a channel — so it is rows here rather than a
 * third screen. Adding another is three edits and no redesign:
 *
 *   1. add its name to `AutomationKind`,
 *   2. push a loader onto `SOURCES` that maps its rows to `AutomationEntry`,
 *   3. add its label, icon and controls to `AUTOMATION_KINDS` in
 *      src/features/automation/kinds.tsx.
 *
 * Nothing in the table, the sort, the search, the empty state, the mobile cards
 * or the health column had to know the third kind arrived. The one thing a new
 * kind must do is describe its own cadence as a *sentence* — see
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
 *
 * `RELEASE_CADENCE` is the odd one and the row has to be honest about it: it
 * makes nothing. It spends what the other two banked, publishing one already-cut
 * short per slot. That is why its backlog is clips rather than subjects and why
 * an empty bank is its normal resting state rather than a fault.
 */
export type AutomationKind = "SERIES" | "TOPIC_QUEUE" | "RELEASE_CADENCE";

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
  /**
   * How many of `produced` actually reached YouTube.
   *
   * The pair is the point. "Made 34, published 30" is a different and far more
   * useful fact than either half alone — it is the difference between a show
   * that is working and a show that is quietly filling a folder. Counting only
   * `PUBLISHED` publications rather than every `Publication` row is what keeps
   * it honest: a row exists from the moment an upload starts.
   */
  published: number;
  /**
   * Whether this automation publishes its own output, or null for a kind that
   * cannot.
   *
   * Present-and-disabled is a different state from absent, and the canvas draws
   * both: a series with the switch off gets a publish node it can turn on, and
   * a shorts drip gets none at all, because publishing *is* what a drip does
   * and offering to switch it off would be offering to switch the drip off
   * twice.
   */
  autoPublish: { enabled: boolean; visibility: PublishVisibility } | null;
  /** Where it publishes. Null only for a standalone schedule whose project has
   *  no channel — the one case where nothing can be said truthfully. */
  channel: { id: string; title: string } | null;
  /**
   * Set when the channel in the cell beside it is not the channel this
   * automation's videos would actually upload to.
   *
   * Only a series can be in this state, and only a series created before
   * `ProjectService.update` stopped moving a project's channel out from under
   * one: a series carries its own `channelId` and this table reads it, while
   * `PublishService` uploads to the project's. Null for every healthy row and
   * for the two kinds that read the channel through the project anyway, so a
   * non-null value is unambiguously "this row's channel column is not where its
   * videos go".
   *
   * A sentence rather than a flag, because the only useful thing to show is
   * which two channels disagree.
   */
  channelWarning: string | null;
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
      autoPublish: true,
      publishVisibility: true,
      // The project's own channel joins its name so this row can tell whether
      // the channel it is about to print is the one an upload would use. See
      // `AutomationEntry.channelWarning`.
      project: {
        select: { name: true, channelId: true, channel: { select: { title: true } } },
      },
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

  // One grouped count for every series at once rather than a query per row —
  // the same shape `loadReleaseCadences` already uses for its bank, and for the
  // same reason: an operator with a show on every channel would otherwise pay a
  // round trip per row for a number that is only a badge.
  //
  // `status: "PUBLISHED"` is what makes this the honest half of "made 34,
  // published 30". A `Publication` row exists from the moment an upload starts,
  // so counting rows rather than successes would report a video that failed to
  // upload as having gone out.
  const publishedGroups = await prisma.video.groupBy({
    by: ["seriesId"],
    where: {
      userId,
      deletedAt: null,
      seriesId: { in: rows.map((row) => row.id) },
      publication: { is: { status: "PUBLISHED" } },
    },
    _count: { _all: true },
  });
  const publishedOf = new Map(
    publishedGroups.map((group) => [group.seriesId, group._count._all]),
  );

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
        published: publishedOf.get(row.id) ?? 0,
        autoPublish: {
          enabled: row.autoPublish,
          visibility: row.publishVisibility,
        },
        channel: { id: row.channelId, title: row.channel.title },
        project: { id: row.projectId, name: row.project.name },
        channelWarning:
          row.project.channelId === row.channelId
            ? null
            : `Episodes of this show are filed in "${row.project.name}", which publishes ` +
              `to ${row.project.channel?.title ?? "no channel"} — not ` +
              `${row.channel.title}. Publishing one is refused until the two agree.`,
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
      autoPublish: true,
      publishVisibility: true,
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

  // A standalone schedule tags no videos of its own, so "what went out" is
  // reached through the runs that produced one — the same route `produced`
  // above already takes, narrowed to the runs whose video actually published.
  const publishedGroups = await prisma.scheduleRun.groupBy({
    by: ["scheduleId"],
    where: {
      scheduleId: { in: rows.map((row) => row.id) },
      video: { is: { publication: { is: { status: "PUBLISHED" } } } },
    },
    _count: { _all: true },
  });
  const publishedOf = new Map(
    publishedGroups.map((group) => [group.scheduleId, group._count._all]),
  );

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
    published: publishedOf.get(row.id) ?? 0,
    autoPublish: { enabled: row.autoPublish, visibility: row.publishVisibility },
    channel:
      row.project.channelId && row.project.channel
        ? { id: row.project.channelId, title: row.project.channel.title }
        : null,
    project: { id: row.projectId, name: row.project.name },
    // A standalone schedule reads its channel through the project, exactly as
    // the renderer and the publisher do, so there is no second copy to disagree
    // with.
    channelWarning: null,
  }));
};

/**
 * Shorts release cadences — one per channel, spending the bank the other two
 * kinds fill.
 *
 * `produced` counts runs that actually put a clip on YouTube, matching the other
 * loaders' "what did this make" rather than "how often did it try": a slot that
 * skipped on an empty bank made nothing, and counting it would flatter a cadence
 * that has been idling for a week.
 *
 * `backlog` is the same query `ReleaseService` releases from, not an
 * approximation of it. The number decides whether `nextRunAt` above it is a
 * promise or a lie, so a second definition that drifted from the first would be
 * worse than no number at all.
 */
const loadReleaseCadences: AutomationSource = async (userId) => {
  const rows = await prisma.releaseCadence.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      pausedReason: true,
      consecutiveFailures: true,
      slotMinutes: true,
      timeZone: true,
      nextReleaseAt: true,
      channelId: true,
      channel: { select: { title: true } },
      _count: { select: { runs: { where: { youtubeVideoId: { not: null } } } } },
    },
  });

  // One grouped count rather than a query per cadence: an operator with a
  // cadence on every channel would otherwise pay a round trip per row for a
  // number that is only a badge.
  const banked = await prisma.short.groupBy({
    by: ["videoId"],
    where: {
      status: "READY",
      outputPath: { not: null },
      publication: { is: null },
      video: {
        userId,
        deletedAt: null,
        project: { channelId: { in: rows.map((row) => row.channelId) }, deletedAt: null },
      },
    },
    _count: { _all: true },
  });

  const videos = await prisma.video.findMany({
    where: { id: { in: banked.map((group) => group.videoId) } },
    select: {
      id: true,
      project: { select: { channelId: true } },
      // Read for the same reason `ReleaseService.bankedShortsWhere` filters on
      // it: a clip whose series and whose project disagree about the channel is
      // releasable by neither cadence, so counting it here would promise a drip
      // that is never going to happen. The condition cannot be expressed in the
      // `groupBy` above — Prisma compares a field to a literal, not to a field
      // on a different relation — so it is applied while the videos are being
      // mapped, which is a pass this loader was making anyway.
      series: { select: { channelId: true } },
    },
  });

  const channelOfVideo = new Map(
    videos
      .filter(
        (video) =>
          video.series === null || video.series.channelId === video.project.channelId,
      )
      .map((video) => [video.id, video.project.channelId]),
  );
  const bankByChannel = new Map<string, number>();
  for (const group of banked) {
    const channelId = channelOfVideo.get(group.videoId);
    if (!channelId) continue;
    bankByChannel.set(channelId, (bankByChannel.get(channelId) ?? 0) + group._count._all);
  }

  return rows.map((row) => ({
    rowId: `release:${row.id}`,
    id: row.id,
    kind: "RELEASE_CADENCE" as const,
    // Named after the channel rather than given a name of its own. A cadence is
    // `@unique` per channel, so "KIDO FUN ZONE" identifies it exactly, and one
    // more name to invent is one more thing that can disagree with the channel
    // it publishes to.
    name: row.channel.title,
    href: `/automation/releases/${row.id}`,
    status: row.status,
    pausedReason: row.pausedReason,
    consecutiveFailures: row.consecutiveFailures,
    cadence: describeSlots({ slotMinutes: row.slotMinutes, timeZone: row.timeZone }),
    timeZone: row.timeZone,
    nextRunAt: row.nextReleaseAt,
    // A cadence cannot say what goes out next without loading the head of the
    // bank per row. The count below is the honest thing it can afford.
    nextUp: null,
    backlog: bankByChannel.get(row.channelId) ?? 0,
    produced: row._count.runs,
    // Identical to `produced` by construction: that count already filters on
    // `youtubeVideoId: { not: null }`, which is the same question asked once.
    // Stated rather than left implied, because a reader comparing the three
    // loaders will otherwise wonder which of them is wrong.
    published: row._count.runs,
    // A cadence has no switch. Publishing is the entirety of what it does, and
    // offering to turn it off would be offering to turn the cadence off twice.
    autoPublish: null,
    channel: { id: row.channelId, title: row.channel.title },
    // Not project-scoped: a cadence spends every project's shorts for its
    // channel, so naming one project would be picking a favourite.
    project: null,
    // A cadence *is* the channel's — `ReleaseCadence.channelId` is unique per
    // channel and there is no second copy of it anywhere.
    channelWarning: null,
  }));
};

/** Add a kind here. See the note at the top of this file. */
const SOURCES: AutomationSource[] = [loadSeries, loadTopicQueues, loadReleaseCadences];

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
