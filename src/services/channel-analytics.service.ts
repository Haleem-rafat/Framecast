import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  fetchVideosDailyMetrics,
  VIDEO_BATCH_SIZE,
  YouTubeAnalyticsError,
  type VideoDayMetrics,
} from "@/lib/youtube-analytics";
import {
  fetchChannelStatistics,
  YouTubeDataApiError,
} from "@/lib/youtube-statistics";
import { channelService } from "@/services/channel.service";
import { hoursUntilQuotaReset } from "@/services/publish.service";

/**
 * Pulls real YouTube performance for every connected channel into
 * `ChannelStatistic` and `VideoAnalytic`, and reads it back for /analytics.
 *
 * ## What this collects, and from which API
 *
 * Two Google services are involved and they answer different questions.
 *
 *   * **Data API** (`channels.list`, 1 unit) → `ChannelStatistic`. Lifetime
 *     subscriber, view and video counts as of right now. There is no history
 *     to be had: YouTube will not tell you what a channel's subscriber count
 *     was last Tuesday, which is exactly why `ChannelStatistic` is a snapshot
 *     table and why channel growth on /analytics is only ever measured from
 *     the first collection forward.
 *
 *   * **Analytics API** (`reports.query`) → `VideoAnalytic`. Per video, per
 *     day: views, likes, comments, watch time, average view duration,
 *     subscribers gained and revenue. Every column in that table comes from
 *     here — see `fetchChannelStatistics`'s doc comment for why `videos.list`
 *     is deliberately not used to fill any of them.
 *
 * `impressions` and `clickThroughRate` are collected by neither and stay at
 * their zero defaults. The Analytics API rejects those two metrics outright
 * for a channel query (see `impressionsKnown` in youtube-analytics.ts), and
 * /analytics therefore does not display them — a rendered 0% CTR would be a
 * measurement this app never made.
 *
 * ## Quota
 *
 * The Data API's 10,000 units a day are **per Google Cloud project, not per
 * channel**, and they are the same units publishing spends. This collector is
 * built to be invisible in that budget:
 *
 *   * **1 Data API unit per channel per day. Not per run — per day.** The only
 *     Data API call here is `channels.list`, and `captureChannelSnapshot`
 *     skips it outright once a snapshot exists for the current UTC day. So a
 *     channel backfilling every fifteen minutes costs exactly the same single
 *     unit as one sitting idle on the daily cadence. Ten channels is 10 units
 *     against 10,000 — 0.1% — on the busiest possible day.
 *   * Every per-video figure comes from the Analytics API, which has its own
 *     separate allowance that publishing does not touch. Two `reports.query`
 *     calls per 50 videos per date range: a 200-video channel costs 8 calls a
 *     day in steady state, and while backfilling, 8 per run.
 *
 * The consequence worth stating plainly: no cadence choice in this file can
 * starve publishing, because the shared pool is spent once a day per channel
 * regardless of how often the collector runs.
 *
 * ## Not competing with a render
 *
 * The worker calls `tick()` from its **idle** branch — after a video claim and
 * a short claim have both come back empty — rather than ahead of them like the
 * schedule and release ticks. Those two *create* work and would starve behind
 * a busy worker; this one does not. Analytics are a day old by the time
 * YouTube will report them at all, so deferring a collection behind a
 * ten-minute render costs nothing anybody can perceive, and a collection is a
 * dozen sequential HTTPS round trips that would otherwise hold the loop.
 *
 * The one exception is `OVERDUE_HOURS`: a worker that never goes idle would
 * otherwise never collect at all, so a channel that has been due for that long
 * is picked up ahead of the video claim. Bounded to one channel per tick, same
 * as every other path here.
 */

/**
 * How long a worker holds a claimed channel.
 *
 * A collection is a `channels.list`, a handful of `reports.query` calls and a
 * bounded set of writes — seconds, not minutes. Five minutes is generous
 * enough that a slow Google response never strands the claim, and short enough
 * that a worker killed mid-collection leaves the channel collectable again
 * within one poll interval rather than at the next day's due time.
 *
 * The lease is *not* what prevents a double collection — `nextCollectionAt` is
 * already advanced past this run by the time the lease is taken, the same
 * discipline `ScheduleService.claimDue` documents at length. Its job is only to
 * stop a *second* worker starting the same channel while the first is still in
 * Google's API.
 */
const CLAIM_LEASE_SECONDS = 300;

/**
 * Steady-state cadence: once a day per channel.
 *
 * Finer would buy nothing. The Analytics API does not report a day's figures
 * until roughly two days after it, and revises them for a day or two more, so
 * polling hourly would re-read numbers that cannot have changed while
 * multiplying a quota shared with publishing by twenty-four.
 */
const COLLECTION_INTERVAL_HOURS = 24;

/**
 * Cadence while a channel is still backfilling.
 *
 * The alternative was one chunk a day, which for a channel with a year of
 * videos means the dashboard is not fully populated for a fortnight. Fifteen
 * minutes converges the same year in about three hours, and it is safe
 * precisely because it does not change the size of a run: each one is still a
 * single bounded chunk of days, so this trades *elapsed time* for nothing but
 * a few dozen extra quota units on the first day.
 */
const BACKFILL_INTERVAL_MINUTES = 15;

/**
 * How many days of history one backfill run walks.
 *
 * Bounded so the first collection after a channel is connected is the same
 * size as every other collection. The failure mode this exists to prevent is
 * the obvious implementation — "on first run, fetch everything" — which for
 * several channels with a year of videos each is a burst of hundreds of API
 * calls in one loop iteration, on a 640 MB worker, against a quota the publish
 * path shares.
 */
const BACKFILL_CHUNK_DAYS = 30;

/**
 * How far back the backfill will ever go.
 *
 * A year covers every window /analytics offers several times over. The
 * Analytics API will happily serve older data, and collecting it would be
 * spending real quota on rows nothing reads.
 */
const BACKFILL_FLOOR_DAYS = 365;

/**
 * How many recent days are re-collected on every run.
 *
 * YouTube revises recent figures — a day's views are not final when first
 * reported, and revenue settles later still. Re-asking for the last few days
 * and upserting is what keeps stored rows in step with what YouTube Studio
 * shows. Four days covers the revision window with a day to spare.
 */
const REVISION_WINDOW_DAYS = 4;

/**
 * The Analytics API has nothing to say about today or yesterday — figures are
 * not available for roughly two days. Asking anyway wastes a request and
 * returns an empty row set that is indistinguishable from a video with no
 * traffic, so the collector simply never asks about days this recent.
 */
const REPORTING_LAG_DAYS = 2;

/** How long a channel may be due before it outranks a render. See the module
 *  comment on why collection normally waits for an idle worker. */
const OVERDUE_HOURS = 6;

/** Candidates read per due-check. Small on purpose: the list is only a hint,
 *  and the conditional update below is what actually wins a channel — same
 *  reasoning as `ScheduleService.claimDue`'s own batch. */
const CANDIDATE_BATCH = 5;

/** Rows per `createMany`. Keeps a 30-day × 50-video backfill chunk from
 *  becoming one 1,500-row statement on a shared, remote database. */
const WRITE_CHUNK = 500;

/** Postgres unique-violation code. Two workers racing to create the same
 *  channel's collection row is a lost claim, not a fault. */
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/** Backoff after a failure, by consecutive-failure count. A dead OAuth token
 *  will not fix itself, so retrying it every fifteen minutes forever is noise
 *  in the log and units off a shared quota; the operator has to reconnect the
 *  channel either way, and /analytics tells them so. */
const FAILURE_BACKOFF_HOURS = [1, 3, 6, 12, 24];

export const CHANNEL_ANALYTICS_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Day arithmetic
//
// Every date below is a *calendar day*, handled in UTC end to end. `capturedFor`
// is `@db.Date`, the Analytics API takes and returns `YYYY-MM-DD` strings, and
// local-time arithmetic across a daylight-saving boundary is how a collector
// silently skips or repeats a day.
// ---------------------------------------------------------------------------

/** `2026-08-16` for the UTC day containing `at`. */
export function toDayString(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `2026-08-16` → the Date Prisma stores in a `@db.Date` column. */
export function fromDayString(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function addDaysUtc(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 86_400_000);
}

/** Midnight UTC on the day containing `at`. */
function startOfDayUtc(at: Date): Date {
  return fromDayString(toDayString(at));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A channel won by `claimDue`, carrying everything `collect` needs. */
export interface ChannelCollectionClaim {
  collectionId: string;
  channelId: string;
  userId: string;
  channelTitle: string;
  backfilledThrough: Date | null;
  backfillComplete: boolean;
}

/** What one collection produced, for the worker's log. */
export interface CollectionResult {
  channelTitle: string;
  outcome: "collected" | "failed";
  /** Rows written to `VideoAnalytic`, new and revised. */
  videoDays: number;
  /** True when this run also took a channel snapshot. */
  snapshotTaken: boolean;
  /** How far back the backfill reached, or null when it was already complete. */
  backfilledTo: string | null;
  reason?: string;
}

/** Why a channel's collection is not healthy, in the operator's words. */
export type CollectionHealth =
  /** Connected, but nothing has ever been collected. */
  | "never"
  /** Collected at least once and still walking its history. */
  | "backfilling"
  /** Collected, current, nothing wrong. */
  | "ok"
  /** The last attempt failed. `lastError` says why. */
  | "failing";

export interface ChannelWindowTotals {
  views: number;
  likes: number;
  comments: number;
  watchTimeMinutes: number;
  subscribersGained: number;
  /**
   * Weighted across the window (total watch time ÷ total views), never a mean
   * of per-day means — a day with three views would otherwise count as much as
   * a day with thirty thousand.
   */
  averageViewSeconds: number;
  /**
   * Null when this channel's monetary figures were never obtainable. Not zero:
   * see `ChannelCollection.revenueAvailable`.
   */
  estimatedRevenue: number | null;
}

export interface TopVideoRow {
  publicationId: string;
  title: string;
  youtubeVideoId: string | null;
  views: number;
  watchTimeMinutes: number;
}

export interface ChannelPerformance {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  /** Lifetime totals as of `capturedAt`. Null when never collected. */
  lifetime: {
    subscriberCount: number;
    viewCount: number;
    videoCount: number;
    capturedAt: Date;
  } | null;
  /** Change since the oldest snapshot in the window. Null with fewer than two
   *  snapshots — one point is not a trend, and rendering it as +0 implies a
   *  flat line that was never measured. */
  subscriberChange: number | null;
  viewChange: number | null;
  /** Null when no `VideoAnalytic` row exists in the window at all. */
  window: ChannelWindowTotals | null;
  /** The most recent day any figure covers. This is the number that makes a
   *  three-day-old dashboard admit it — see /analytics. */
  dataThrough: Date | null;
  topVideos: TopVideoRow[];
  /** How many of this channel's published videos are being tracked. */
  trackedVideos: number;
  health: CollectionHealth;
  lastCollectedAt: Date | null;
  nextCollectionAt: Date | null;
  lastError: string | null;
}

export interface ChannelAnalyticsOverview {
  windowDays: number;
  channels: ChannelPerformance[];
  /** True when at least one channel has ever been collected. Drives whether
   *  /analytics shows the section as "not started" or as data with gaps. */
  anyCollected: boolean;
  /** True when any channel's revenue is knowable, which is what decides
   *  whether the revenue column appears at all. */
  revenueKnown: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ChannelAnalyticsService {
  constructor(
    /** Injected so tests never call Google. Both API clients take a `fetch`. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // -------------------------------------------------------------------------
  // The worker path
  // -------------------------------------------------------------------------

  /**
   * One due-check. Claims at most one channel and collects it; returns null
   * when nothing was due.
   *
   * At most one, for the reason `ScheduleService.tick` gives: the worker's poll
   * loop is shared with renders, and draining every due channel in a burst
   * would hold it through several channels' worth of Google round trips. The
   * next poll takes the next channel, which at a five-second interval is a wait
   * of seconds against a cadence of a day.
   */
  async tick(): Promise<CollectionResult | null> {
    const claim = await this.claimDue();

    if (!claim) {
      return null;
    }

    return this.collect(claim);
  }

  /**
   * True when some channel has been due for longer than `OVERDUE_HOURS`.
   *
   * The worker asks this before claiming a video, so that a box which never
   * goes idle still collects eventually. Deliberately a `count` on the same
   * index the due-check scans rather than a claim: it must be cheap enough to
   * run on a poll that will almost always find nothing.
   */
  async hasOverdueChannel(now: Date = new Date()): Promise<boolean> {
    const cutoff = new Date(now.getTime() - OVERDUE_HOURS * 3_600_000);

    const overdue = await prisma.channelCollection.count({
      where: {
        nextCollectionAt: { lte: cutoff },
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        channel: { deletedAt: null, isActive: true },
      },
      take: 1,
    });

    if (overdue > 0) {
      return true;
    }

    // A channel connected more than `OVERDUE_HOURS` ago that has never been
    // collected has no row to have a `nextCollectionAt` on, so it cannot show
    // up in the query above and would otherwise be invisible to this check
    // forever on a permanently busy worker.
    const uncollected = await prisma.channel.count({
      where: {
        deletedAt: null,
        isActive: true,
        connectedAt: { lte: cutoff },
        collection: { is: null },
      },
      take: 1,
    });

    return uncollected > 0;
  }

  /**
   * Wins exactly one due channel, advancing it past this run in the same write.
   *
   * ## Why this cannot collect twice
   *
   * The same shape as `ScheduleService.claimDue` and `JobService.claimNext`,
   * and for the same reason: Prisma's `updateMany` has no `LIMIT`, so an
   * unconditional "claim the oldest due channel" would let two workers both
   * match and both believe they won. Instead a short candidate list is read as
   * a *hint*, and each candidate is won with an update whose `where` repeats
   * the exact `nextCollectionAt` just read. That conditional update is the
   * lock; after it lands no other caller's `where` can match this row, because
   * the value it matched on is gone.
   *
   * A channel with no collection row yet is claimed by *creating* the row, and
   * the unique index on `channelId` settles that race the same way — the loser
   * gets P2002 and moves on to the next candidate.
   *
   * ## Why a lost claim is not an error
   *
   * Both loss paths `continue` rather than throw. Losing a race means another
   * worker is collecting this channel right now, which is the desired outcome,
   * not a fault to report.
   */
  async claimDue(now: Date = new Date()): Promise<ChannelCollectionClaim | null> {
    const claimFree = [
      { claimExpiresAt: null },
      { claimExpiresAt: { lt: now } },
    ];

    const candidates = await prisma.channel.findMany({
      where: {
        deletedAt: null,
        // A channel the operator has switched off is not collected. It is not
        // an error either — it simply stops, and /analytics keeps showing the
        // last figures with their capture time.
        isActive: true,
        OR: [
          // Never collected: no row exists yet. This is every channel the first
          // time the worker runs after deploy, which is why the migration
          // deliberately seeds nothing.
          { collection: { is: null } },
          {
            collection: {
              nextCollectionAt: { lte: now },
              // A channel whose previous collection is still in flight, or
              // whose worker died holding it. The lapsed case is why this is a
              // lease and not a lock: nothing else would ever clear it.
              OR: claimFree,
            },
          },
        ],
      },
      // Oldest connection first, so a channel connected before this feature
      // existed is not permanently outranked by one connected yesterday.
      orderBy: { connectedAt: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        title: true,
        collection: {
          select: {
            id: true,
            nextCollectionAt: true,
            backfilledThrough: true,
            backfillComplete: true,
          },
        },
      },
    });

    for (const candidate of candidates) {
      const existing = candidate.collection;
      const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000);

      if (!existing) {
        // First ever collection for this channel. Creating the row *is* the
        // claim; `channelId` is unique, so only one worker's insert survives.
        try {
          const created = await prisma.channelCollection.create({
            data: {
              channelId: candidate.id,
              // Advanced before the work starts, exactly as the update branch
              // below does, so a crash mid-collection cannot be re-claimed by
              // a second worker until the lease lapses.
              nextCollectionAt: this.nextDueAt(now, false),
              claimExpiresAt: leaseUntil,
              lastAttemptAt: now,
            },
            select: { id: true },
          });

          return {
            collectionId: created.id,
            channelId: candidate.id,
            userId: candidate.userId,
            channelTitle: candidate.title,
            backfilledThrough: null,
            backfillComplete: false,
          };
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            continue;
          }
          throw error;
        }
      }

      const dueAt = existing.nextCollectionAt;

      const { count } = await prisma.channelCollection.updateMany({
        where: {
          id: existing.id,
          // The lock. Only one caller can still match this exact value.
          nextCollectionAt: dueAt,
          OR: claimFree,
        },
        data: {
          nextCollectionAt: this.nextDueAt(now, existing.backfillComplete),
          claimExpiresAt: leaseUntil,
          // Moved by the claim rather than by the outcome, because it answers
          // "did the collector look?" — which is the question an operator asks
          // when the figures have not moved, and it must be answerable even
          // when the answer is "it looked and it failed".
          lastAttemptAt: now,
        },
      });

      if (count === 1) {
        return {
          collectionId: existing.id,
          channelId: candidate.id,
          userId: candidate.userId,
          channelTitle: candidate.title,
          backfilledThrough: existing.backfilledThrough,
          backfillComplete: existing.backfillComplete,
        };
      }
    }

    return null;
  }

  /** When a channel should next be looked at, given whether it is caught up. */
  private nextDueAt(now: Date, backfillComplete: boolean): Date {
    return backfillComplete
      ? new Date(now.getTime() + COLLECTION_INTERVAL_HOURS * 3_600_000)
      : new Date(now.getTime() + BACKFILL_INTERVAL_MINUTES * 60_000);
  }

  /**
   * Collects one claimed channel, and writes down what happened either way.
   *
   * Every error is caught and recorded against *this* channel. That is the
   * whole reason collection is one-channel-per-claim rather than a loop over
   * every channel inside a single tick: a dead OAuth token, a deleted channel
   * or a refused scope fails here, is written to `lastError`, and the next tick
   * picks up a different channel entirely. One broken connection cannot stall
   * the others, and /analytics names the channel and quotes the reason.
   */
  async collect(claim: ChannelCollectionClaim): Promise<CollectionResult> {
    try {
      const result = await this.runCollection(claim);

      return { channelTitle: claim.channelTitle, outcome: "collected", ...result };
    } catch (error) {
      const reason = await this.recordFailure(claim, error);

      return {
        channelTitle: claim.channelTitle,
        outcome: "failed",
        videoDays: 0,
        snapshotTaken: false,
        backfilledTo: null,
        reason,
      };
    }
  }

  private async runCollection(
    claim: ChannelCollectionClaim,
  ): Promise<Omit<CollectionResult, "channelTitle" | "outcome" | "reason">> {
    const now = new Date();

    // The one place a token is decrypted, and the first thing that can fail. A
    // channel whose grant has been revoked throws `ProviderError` from here
    // with a sentence that already tells the operator to reconnect it.
    const accessToken = await channelService.resolveAccessToken(
      claim.userId,
      claim.channelId,
    );

    const snapshotTaken = await this.captureChannelSnapshot(
      claim.channelId,
      accessToken,
      now,
    );

    const publications = await prisma.publication.findMany({
      where: {
        channelId: claim.channelId,
        status: "PUBLISHED",
        youtubeVideoId: { not: null },
        video: { deletedAt: null },
      },
      select: { id: true, youtubeVideoId: true, publishedAt: true, createdAt: true },
    });

    // Nothing published yet is a perfectly healthy channel, not a failure. The
    // snapshot above still recorded its subscriber count, and the backfill has
    // no history to walk, so it is marked complete and drops to the daily
    // cadence rather than spinning every fifteen minutes over an empty list.
    if (publications.length === 0) {
      await this.recordSuccess(claim, {
        now,
        backfilledThrough: null,
        backfillComplete: true,
        revenueAvailable: null,
      });

      return { videoDays: 0, snapshotTaken, backfilledTo: null };
    }

    const idToPublication = new Map(
      publications
        .filter((row): row is typeof row & { youtubeVideoId: string } =>
          Boolean(row.youtubeVideoId),
        )
        .map((row) => [row.youtubeVideoId, row.id]),
    );

    // The Analytics API cannot answer about the last couple of days, so the
    // window ends where its data ends rather than at today.
    const latestReportableDay = addDaysUtc(startOfDayUtc(now), -REPORTING_LAG_DAYS);
    const revisionStart = addDaysUtc(latestReportableDay, -(REVISION_WINDOW_DAYS - 1));

    const ranges: Array<{ start: Date; end: Date; revise: boolean }> = [
      { start: revisionStart, end: latestReportableDay, revise: true },
    ];

    const backfill = this.nextBackfillRange(claim, publications, revisionStart, now);

    if (backfill) {
      ranges.push({ start: backfill.start, end: backfill.end, revise: false });
    }

    let videoDays = 0;
    // Null until a monetary query has actually been attempted, so a channel
    // with no reportable days does not get recorded as "not monetised".
    let revenueAvailable: boolean | null = null;

    for (const range of ranges) {
      const batchResult = await this.collectRange({
        accessToken,
        idToPublication,
        start: range.start,
        end: range.end,
        revise: range.revise,
      });

      videoDays += batchResult.written;

      if (batchResult.revenueAvailable !== null) {
        // False anywhere wins: the refusal is a property of the channel, so one
        // range being refused means the channel is not monetised regardless of
        // what an empty range reported.
        revenueAvailable =
          revenueAvailable === false ? false : batchResult.revenueAvailable;
      }
    }

    await this.recordSuccess(claim, {
      now,
      backfilledThrough: backfill?.start ?? claim.backfilledThrough,
      backfillComplete: backfill ? backfill.complete : true,
      revenueAvailable,
    });

    return {
      videoDays,
      snapshotTaken,
      backfilledTo: backfill ? toDayString(backfill.start) : null,
    };
  }

  /**
   * Writes one `ChannelStatistic` row, at most once per UTC day.
   *
   * Once a day rather than once a run, and that matters only while a channel is
   * backfilling: at fifteen-minute intervals a per-run snapshot would write
   * ninety-six near-identical rows a day, and the growth series /analytics
   * derives from this table would be dominated by the collector's own cadence
   * rather than by the channel's growth. The claim guarantees no other worker
   * is collecting this channel, so the read-then-write below cannot race.
   *
   * Returns whether a row was actually written.
   */
  private async captureChannelSnapshot(
    channelId: string,
    accessToken: string,
    now: Date,
  ): Promise<boolean> {
    const existing = await prisma.channelStatistic.findFirst({
      where: { channelId, capturedAt: { gte: startOfDayUtc(now) } },
      select: { id: true },
    });

    if (existing) {
      return false;
    }

    const snapshot = await fetchChannelStatistics({
      accessToken,
      fetchImpl: this.fetchImpl,
    });

    await prisma.channelStatistic.create({
      data: {
        channelId,
        subscriberCount: BigInt(Math.max(0, Math.round(snapshot.subscriberCount))),
        viewCount: BigInt(Math.max(0, Math.round(snapshot.viewCount))),
        videoCount: Math.max(0, Math.round(snapshot.videoCount)),
        capturedAt: now,
      },
    });

    return true;
  }

  /**
   * The next chunk of history to walk, or null when there is none left.
   *
   * Walks *backwards* from wherever the last run stopped, one
   * `BACKFILL_CHUNK_DAYS` window at a time, and stops at whichever comes first:
   * the day the channel's earliest video was published, or `BACKFILL_FLOOR_DAYS`.
   * Stopping at the earliest publication is what makes "lifetime views for this
   * video" the exact sum of its rows rather than an approximation — there is no
   * day before its publication that could contribute.
   */
  private nextBackfillRange(
    claim: ChannelCollectionClaim,
    publications: Array<{ publishedAt: Date | null; createdAt: Date }>,
    revisionStart: Date,
    now: Date,
  ): { start: Date; end: Date; complete: boolean } | null {
    if (claim.backfillComplete) {
      return null;
    }

    // The first run has walked nothing, so it starts where the always-collected
    // revision window starts and works back from there.
    const cursor = claim.backfilledThrough ?? revisionStart;
    const end = addDaysUtc(cursor, -1);

    const earliestPublication = publications.reduce<Date | null>((earliest, row) => {
      // `publishedAt` is null for a publication that never reported one;
      // `createdAt` is the closest honest substitute and is never null.
      const at = startOfDayUtc(row.publishedAt ?? row.createdAt);
      return earliest === null || at < earliest ? at : earliest;
    }, null);

    const floor = addDaysUtc(startOfDayUtc(now), -BACKFILL_FLOOR_DAYS);
    const limit =
      earliestPublication && earliestPublication > floor ? earliestPublication : floor;

    if (end < limit) {
      return null;
    }

    const chunkStart = addDaysUtc(end, -(BACKFILL_CHUNK_DAYS - 1));
    const start = chunkStart < limit ? limit : chunkStart;

    return { start, end, complete: start <= limit };
  }

  /**
   * Queries one date range for every tracked video and writes the rows.
   *
   * `revise` picks the write strategy, and the difference is not an
   * optimisation — it is what each range means:
   *
   *   * The revision window re-asks about days already stored, because YouTube
   *     revises them. It `upsert`s, so a second run on the same day updates the
   *     row rather than colliding with `@@unique([publicationId, capturedFor])`.
   *   * A backfill chunk covers days the cursor has never crossed, so nothing
   *     should exist for them. `createMany({ skipDuplicates: true })` writes it
   *     in a handful of statements instead of one round trip per row, and the
   *     skip makes a re-run after a partial failure safe rather than fatal.
   */
  private async collectRange({
    accessToken,
    idToPublication,
    start,
    end,
    revise,
  }: {
    accessToken: string;
    idToPublication: Map<string, string>;
    start: Date;
    end: Date;
    revise: boolean;
  }): Promise<{ written: number; revenueAvailable: boolean | null }> {
    const videoIds = [...idToPublication.keys()];
    const startDate = toDayString(start);
    const endDate = toDayString(end);

    let written = 0;
    let revenueAvailable: boolean | null = null;

    for (let offset = 0; offset < videoIds.length; offset += VIDEO_BATCH_SIZE) {
      const batch = videoIds.slice(offset, offset + VIDEO_BATCH_SIZE);

      const { byVideo, revenueAvailable: batchRevenue } = await fetchVideosDailyMetrics({
        accessToken,
        youtubeVideoIds: batch,
        startDate,
        endDate,
        fetchImpl: this.fetchImpl,
      });

      revenueAvailable = revenueAvailable === false ? false : batchRevenue;

      const rows: Prisma.VideoAnalyticCreateManyInput[] = [];

      for (const youtubeVideoId of batch) {
        const publicationId = idToPublication.get(youtubeVideoId);
        const days = byVideo.get(youtubeVideoId);

        // A video the API said nothing about. Normal, and specifically normal
        // for a video with too few views to report on — YouTube withholds
        // figures below a privacy threshold. Writing zeros here would turn
        // "not reported" into "measured as nothing", which is the exact lie
        // this collector exists to avoid.
        if (!publicationId || !days) {
          continue;
        }

        for (const day of days) {
          rows.push(this.toRow(publicationId, day));
        }
      }

      written += rows.length;

      if (rows.length === 0) {
        continue;
      }

      if (revise) {
        for (const row of rows) {
          await prisma.videoAnalytic.upsert({
            where: {
              publicationId_capturedFor: {
                publicationId: row.publicationId,
                capturedFor: row.capturedFor as Date,
              },
            },
            create: row,
            update: {
              views: row.views,
              likes: row.likes,
              comments: row.comments,
              watchTimeMinutes: row.watchTimeMinutes,
              averageViewSeconds: row.averageViewSeconds,
              subscribersGained: row.subscribersGained,
              estimatedRevenue: row.estimatedRevenue,
            },
          });
        }
      } else {
        for (let index = 0; index < rows.length; index += WRITE_CHUNK) {
          await prisma.videoAnalytic.createMany({
            data: rows.slice(index, index + WRITE_CHUNK),
            skipDuplicates: true,
          });
        }
      }
    }

    return { written, revenueAvailable };
  }

  private toRow(
    publicationId: string,
    day: VideoDayMetrics,
  ): Prisma.VideoAnalyticCreateManyInput {
    return {
      publicationId,
      capturedFor: fromDayString(day.day),
      views: BigInt(Math.max(0, Math.round(day.views))),
      likes: BigInt(Math.max(0, Math.round(day.likes))),
      comments: BigInt(Math.max(0, Math.round(day.comments))),
      watchTimeMinutes: day.estimatedMinutesWatched,
      averageViewSeconds: day.averageViewSeconds,
      // Can legitimately be negative — a day on which more people unsubscribed
      // than subscribed — so this one is not clamped at zero.
      subscribersGained: Math.round(day.subscribersGained),
      // Null means "never allowed to ask", and the column cannot hold null.
      // Zero is written and `ChannelCollection.revenueAvailable` records that
      // it is meaningless, which is what stops /analytics rendering it.
      estimatedRevenue: new Prisma.Decimal(day.estimatedRevenue ?? 0),
      // `impressions` and `clickThroughRate` are left at their defaults. The
      // Analytics API refuses both for a channel query — see `impressionsKnown`.
    };
  }

  private async recordSuccess(
    claim: ChannelCollectionClaim,
    {
      now,
      backfilledThrough,
      backfillComplete,
      revenueAvailable,
    }: {
      now: Date;
      backfilledThrough: Date | null;
      backfillComplete: boolean;
      revenueAvailable: boolean | null;
    },
  ): Promise<void> {
    await prisma.channelCollection.update({
      where: { id: claim.collectionId },
      data: {
        lastCollectedAt: now,
        // The claim already advanced this; setting it again from the *outcome*
        // is what moves a channel that has just finished backfilling off the
        // fifteen-minute cadence and onto the daily one.
        nextCollectionAt: this.nextDueAt(now, backfillComplete),
        // Released here rather than in a `finally`, because a channel still
        // holding a lease is a channel the next tick skips.
        claimExpiresAt: null,
        backfilledThrough,
        backfillComplete,
        // Left untouched when this run never asked, so one range with no
        // reportable days cannot erase what an earlier run established.
        ...(revenueAvailable === null ? {} : { revenueAvailable }),
        lastError: null,
        consecutiveFailures: 0,
      },
    });
  }

  /**
   * Writes a failure down, chooses when to try again, and returns the sentence
   * the operator will read.
   *
   * The three cases get genuinely different treatment:
   *
   *   * **Quota spent.** Surfaced, never retried into. `nextCollectionAt` moves
   *     past the Pacific-midnight reset, because the allowance is per Google
   *     Cloud project and retrying before then cannot succeed — it can only
   *     spend units that `videos.insert` needs. The message names the reset.
   *   * **Permissions.** A revoked grant or a deleted channel. Backed off hard,
   *     because no amount of retrying fixes it; the operator has to reconnect,
   *     and /analytics tells them which channel and why.
   *   * **Everything else.** A 500, a network fault. Backed off on a curve and
   *     retried, because these do fix themselves.
   */
  private async recordFailure(
    claim: ChannelCollectionClaim,
    error: unknown,
  ): Promise<string> {
    const now = new Date();
    const failures =
      (await prisma.channelCollection
        .findUnique({
          where: { id: claim.collectionId },
          select: { consecutiveFailures: true },
        })
        .then((row) => row?.consecutiveFailures ?? 0)) + 1;

    const isQuota =
      (error instanceof YouTubeDataApiError && error.isQuota) ||
      (error instanceof YouTubeAnalyticsError && error.isQuota);

    let message: string;
    let retryAt: Date;

    if (isQuota) {
      const hours = hoursUntilQuotaReset(now);
      message =
        `YouTube's daily API quota for this project is spent, so ${claim.channelTitle} ` +
        `could not be collected. The quota is shared with publishing and resets at ` +
        `midnight Pacific Time — about ${hours} hour${hours === 1 ? "" : "s"} from now. ` +
        `Collection will not retry before then.`;
      retryAt = new Date(now.getTime() + hours * 3_600_000);
    } else {
      message = messageOf(error);
      const backoff =
        FAILURE_BACKOFF_HOURS[
          Math.min(failures, FAILURE_BACKOFF_HOURS.length) - 1
        ];
      retryAt = new Date(now.getTime() + backoff * 3_600_000);
    }

    await prisma.channelCollection.update({
      where: { id: claim.collectionId },
      data: {
        nextCollectionAt: retryAt,
        claimExpiresAt: null,
        lastError: message,
        consecutiveFailures: failures,
      },
    });

    return message;
  }

  // -------------------------------------------------------------------------
  // The page path
  // -------------------------------------------------------------------------

  /**
   * Every connected channel's YouTube performance, for /analytics.
   *
   * Scoped by `userId` throughout, matching how the rest of that page already
   * works: `Channel.userId` owns a channel outright, so a member sees their own
   * channels and nobody else's — including, in particular, nobody else's
   * revenue.
   *
   * Every `BigInt` and `Decimal` is converted to `number` here rather than at
   * the boundary. This is the payload a server component hands to the client,
   * and Next.js cannot serialise either type across that boundary — a `BigInt`
   * that escapes this method is a render-time crash, not a wrong number.
   * Subscriber and view counts are far below `Number.MAX_SAFE_INTEGER` (nine
   * quadrillion), so the conversion is lossless for any real channel.
   */
  async getOverview(userId: string): Promise<ChannelAnalyticsOverview> {
    const now = new Date();
    const windowStart = addDaysUtc(
      startOfDayUtc(now),
      -(CHANNEL_ANALYTICS_WINDOW_DAYS - 1),
    );

    const channels = await prisma.channel.findMany({
      where: { userId, deletedAt: null },
      orderBy: { connectedAt: "asc" },
      select: {
        id: true,
        title: true,
        thumbnailUrl: true,
        collection: {
          select: {
            lastCollectedAt: true,
            nextCollectionAt: true,
            lastError: true,
            backfillComplete: true,
            revenueAvailable: true,
          },
        },
      },
    });

    const performances = await Promise.all(
      channels.map((channel) => this.performanceFor(channel, windowStart)),
    );

    return {
      windowDays: CHANNEL_ANALYTICS_WINDOW_DAYS,
      channels: performances,
      anyCollected: performances.some((row) => row.lastCollectedAt !== null),
      revenueKnown: performances.some((row) => row.window?.estimatedRevenue !== null),
    };
  }

  private async performanceFor(
    channel: {
      id: string;
      title: string;
      thumbnailUrl: string | null;
      collection: {
        lastCollectedAt: Date | null;
        nextCollectionAt: Date | null;
        lastError: string | null;
        backfillComplete: boolean;
        revenueAvailable: boolean | null;
      } | null;
    },
    windowStart: Date,
  ): Promise<ChannelPerformance> {
    const publication = { publication: { channelId: channel.id } };
    const inWindow = { ...publication, capturedFor: { gte: windowStart } };

    const [latest, oldestInWindow, totals, dataThrough, top, trackedVideos] =
      await Promise.all([
        prisma.channelStatistic.findFirst({
          where: { channelId: channel.id },
          orderBy: { capturedAt: "desc" },
          select: {
            subscriberCount: true,
            viewCount: true,
            videoCount: true,
            capturedAt: true,
          },
        }),
        prisma.channelStatistic.findFirst({
          where: { channelId: channel.id, capturedAt: { gte: windowStart } },
          orderBy: { capturedAt: "asc" },
          select: { subscriberCount: true, viewCount: true, capturedAt: true },
        }),
        prisma.videoAnalytic.aggregate({
          where: inWindow,
          _sum: {
            views: true,
            likes: true,
            comments: true,
            watchTimeMinutes: true,
            subscribersGained: true,
            estimatedRevenue: true,
          },
          _count: { _all: true },
        }),
        prisma.videoAnalytic.aggregate({
          where: publication,
          _max: { capturedFor: true },
        }),
        prisma.videoAnalytic.groupBy({
          by: ["publicationId"],
          where: inWindow,
          _sum: { views: true, watchTimeMinutes: true },
          orderBy: { _sum: { views: "desc" } },
          take: 5,
        }),
        prisma.publication.count({
          where: {
            channelId: channel.id,
            status: "PUBLISHED",
            youtubeVideoId: { not: null },
            video: { deletedAt: null },
          },
        }),
      ]);

    const window = totals._count._all > 0 ? this.toWindowTotals(totals, channel.collection?.revenueAvailable ?? null) : null;

    return {
      channelId: channel.id,
      title: channel.title,
      thumbnailUrl: channel.thumbnailUrl,
      lifetime: latest
        ? {
            subscriberCount: Number(latest.subscriberCount),
            viewCount: Number(latest.viewCount),
            videoCount: latest.videoCount,
            capturedAt: latest.capturedAt,
          }
        : null,
      // Two distinct snapshots or nothing: comparing a snapshot against itself
      // renders as "+0 this month" for a channel nobody has measured twice,
      // which reads as "no growth" rather than as "not known yet".
      subscriberChange:
        latest && oldestInWindow && oldestInWindow.capturedAt < latest.capturedAt
          ? Number(latest.subscriberCount) - Number(oldestInWindow.subscriberCount)
          : null,
      viewChange:
        latest && oldestInWindow && oldestInWindow.capturedAt < latest.capturedAt
          ? Number(latest.viewCount) - Number(oldestInWindow.viewCount)
          : null,
      window,
      dataThrough: dataThrough._max.capturedFor ?? null,
      topVideos: await this.topVideos(top),
      trackedVideos,
      health: this.healthOf(channel.collection),
      lastCollectedAt: channel.collection?.lastCollectedAt ?? null,
      nextCollectionAt: channel.collection?.nextCollectionAt ?? null,
      lastError: channel.collection?.lastError ?? null,
    };
  }

  private toWindowTotals(
    totals: {
      _sum: {
        views: bigint | null;
        likes: bigint | null;
        comments: bigint | null;
        watchTimeMinutes: number | null;
        subscribersGained: number | null;
        estimatedRevenue: Prisma.Decimal | null;
      };
    },
    revenueAvailable: boolean | null,
  ): ChannelWindowTotals {
    const views = Number(totals._sum.views ?? 0);
    const watchTimeMinutes = totals._sum.watchTimeMinutes ?? 0;

    return {
      views,
      likes: Number(totals._sum.likes ?? 0),
      comments: Number(totals._sum.comments ?? 0),
      watchTimeMinutes,
      subscribersGained: totals._sum.subscribersGained ?? 0,
      // Watch time ÷ views, in seconds. Exact, and immune to the day-with-three-
      // views problem that averaging the per-day averages would have.
      averageViewSeconds: views > 0 ? (watchTimeMinutes * 60) / views : 0,
      estimatedRevenue:
        revenueAvailable === true
          ? Number(totals._sum.estimatedRevenue ?? 0)
          : null,
    };
  }

  private async topVideos(
    groups: Array<{
      publicationId: string;
      _sum: { views: bigint | null; watchTimeMinutes: number | null };
    }>,
  ): Promise<TopVideoRow[]> {
    if (groups.length === 0) {
      return [];
    }

    const publications = await prisma.publication.findMany({
      where: { id: { in: groups.map((group) => group.publicationId) } },
      select: { id: true, title: true, youtubeVideoId: true },
    });

    const byId = new Map(publications.map((row) => [row.id, row]));

    return groups.flatMap((group) => {
      const publication = byId.get(group.publicationId);

      if (!publication) {
        return [];
      }

      return [
        {
          publicationId: group.publicationId,
          title: publication.title,
          youtubeVideoId: publication.youtubeVideoId,
          views: Number(group._sum.views ?? 0),
          watchTimeMinutes: group._sum.watchTimeMinutes ?? 0,
        },
      ];
    });
  }

  private healthOf(
    collection: {
      lastCollectedAt: Date | null;
      lastError: string | null;
      backfillComplete: boolean;
    } | null,
  ): CollectionHealth {
    if (!collection || collection.lastCollectedAt === null) {
      // A row can exist with a `lastError` and no `lastCollectedAt` — the very
      // first attempt failed. That is "failing", not "never": there is a reason
      // to show, and "never collected" would hide it.
      return collection?.lastError ? "failing" : "never";
    }

    if (collection.lastError) {
      return "failing";
    }

    return collection.backfillComplete ? "ok" : "backfilling";
  }
}

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const channelAnalyticsService = new ChannelAnalyticsService();
