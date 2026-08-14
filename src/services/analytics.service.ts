import "server-only";

import { addDays, format, startOfDay, subDays } from "date-fns";

import type {
  AiProviderType,
  PublishStatus,
  VideoStatus,
} from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

export const ANALYTICS_WINDOW_DAYS = 30;

/**
 * Ceiling on the raw `ProviderUsage` rows pulled to build the daily series.
 *
 * Prisma cannot `groupBy` a truncated date, and this codebase has no raw-SQL
 * precedent to follow, so the series is bucketed in memory instead. The cap
 * keeps that bounded; when it bites, `dailyTruncated` says so and the page
 * hides the chart rather than drawing a curve whose oldest days are quietly
 * short. The headline totals never come from this fetch — they come from
 * `groupBy`, which is exact regardless.
 */
const USAGE_SERIES_LIMIT = 5_000;

/** Same idea for render timings, which are computed from raw start/finish pairs. */
const RENDER_SAMPLE_LIMIT = 1_000;

export interface VideoStatusCount {
  status: VideoStatus;
  count: number;
}

export interface RenderReliability {
  succeeded: number;
  failed: number;
  cancelled: number;
  /** Null when no finished render in the window recorded both timestamps. */
  medianSeconds: number | null;
  p90Seconds: number | null;
  longestSeconds: number | null;
  /** How many renders the three durations above were computed from. */
  timedCount: number;
}

export interface PublishStatusCount {
  status: PublishStatus;
  count: number;
}

export interface PublishSummary {
  byStatus: PublishStatusCount[];
  published: number;
  /**
   * Of the published ones, how many got their custom thumbnail attached.
   * YouTube rejects custom thumbnails from unverified channels, so a gap here
   * is a real, fixable condition rather than noise.
   */
  thumbnailApplied: number;
}

export interface ProviderUsageRow {
  provider: AiProviderType;
  costUsd: number;
  requests: number;
  failures: number;
}

export interface OperationUsageRow {
  operation: string;
  costUsd: number;
  requests: number;
  failures: number;
  /**
   * Null when nothing in this operation records a latency. The voice-over path
   * never sets `latencyMs`, so its row is legitimately blank rather than zero.
   */
  avgLatencyMs: number | null;
}

export interface DailyUsagePoint {
  /** `yyyy-MM-dd`, in the server's timezone. */
  date: string;
  costUsd: number;
  requests: number;
}

export interface UsageAnalytics {
  totalCostUsd: number;
  totalRequests: number;
  totalFailures: number;
  byProvider: ProviderUsageRow[];
  byOperation: OperationUsageRow[];
  daily: DailyUsagePoint[];
  /** True when the window held more rows than `USAGE_SERIES_LIMIT`. */
  dailyTruncated: boolean;
}

export interface AnalyticsOverview {
  windowDays: number;
  videosByStatus: VideoStatusCount[];
  videosCreatedInWindow: number;
  render: RenderReliability;
  publish: PublishSummary;
  /**
   * Deployment-wide, not per operator. `ProviderUsage` has no `userId`, and
   * the rows the pipeline writes never set `credentialId` either, so there is
   * no join back to an owner — see `providerUsage.create` in script.service.ts
   * and voiceover.service.ts. Only aggregates are exposed here, never
   * individual rows, and the page labels the section accordingly.
   */
  usage: UsageAnalytics;
}

/**
 * Nearest-rank percentile over an ascending array. Chosen over interpolation
 * because a render duration that never happened is a worse answer than one
 * that did — every value reported here is a real render's real time.
 */
function percentile(ascending: number[], fraction: number): number | null {
  if (ascending.length === 0) {
    return null;
  }

  const rank = Math.ceil(fraction * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));

  return ascending[index];
}

export class AnalyticsService {
  async getOverview(userId: string): Promise<AnalyticsOverview> {
    const since = subDays(startOfDay(new Date()), ANALYTICS_WINDOW_DAYS - 1);

    // Videos, renders and publications all reach a `userId` and are scoped to
    // it. Soft-deleted videos are excluded everywhere, so a deleted video's
    // renders stop counting the moment the video does.
    const ownVideo = { userId, deletedAt: null };

    const [
      videoGroups,
      videosCreatedInWindow,
      renderGroups,
      renderSamples,
      publicationGroups,
      publishedCount,
      thumbnailAppliedCount,
      usage,
    ] = await Promise.all([
      prisma.video.groupBy({
        by: ["status"],
        where: ownVideo,
        _count: { _all: true },
      }),
      prisma.video.count({
        where: { ...ownVideo, createdAt: { gte: since } },
      }),
      prisma.renderJob.groupBy({
        by: ["status"],
        where: { video: ownVideo, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.renderJob.findMany({
        where: {
          video: ownVideo,
          status: "SUCCEEDED",
          createdAt: { gte: since },
          // A job that never started or never finished has no duration to
          // report; including it as a zero would drag the median toward a
          // number no render ever took.
          startedAt: { not: null },
          finishedAt: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: RENDER_SAMPLE_LIMIT,
        select: { startedAt: true, finishedAt: true },
      }),
      prisma.publication.groupBy({
        by: ["status"],
        where: { video: ownVideo },
        _count: { _all: true },
      }),
      prisma.publication.count({
        where: { video: ownVideo, status: "PUBLISHED" },
      }),
      prisma.publication.count({
        where: { video: ownVideo, status: "PUBLISHED", thumbnailApplied: true },
      }),
      this.getUsage(since),
    ]);

    const durations = renderSamples
      .map((job) =>
        job.startedAt && job.finishedAt
          ? (job.finishedAt.getTime() - job.startedAt.getTime()) / 1000
          : null,
      )
      // A clock adjustment mid-render can produce a negative span; it is not a
      // duration anybody can act on, so it is dropped rather than shown as 0.
      .filter((seconds): seconds is number => seconds !== null && seconds >= 0)
      .sort((a, b) => a - b);

    const renderCount = (status: string) =>
      renderGroups.find((group) => group.status === status)?._count._all ?? 0;

    return {
      windowDays: ANALYTICS_WINDOW_DAYS,
      videosByStatus: videoGroups
        .map((group) => ({ status: group.status, count: group._count._all }))
        .sort((a, b) => b.count - a.count),
      videosCreatedInWindow,
      render: {
        succeeded: renderCount("SUCCEEDED"),
        failed: renderCount("FAILED"),
        cancelled: renderCount("CANCELLED"),
        medianSeconds: percentile(durations, 0.5),
        p90Seconds: percentile(durations, 0.9),
        longestSeconds: durations.at(-1) ?? null,
        timedCount: durations.length,
      },
      publish: {
        byStatus: publicationGroups
          .map((group) => ({ status: group.status, count: group._count._all }))
          .sort((a, b) => b.count - a.count),
        published: publishedCount,
        thumbnailApplied: thumbnailAppliedCount,
      },
      usage,
    };
  }

  /**
   * Deployment-wide provider spend and reliability. Takes only a date because
   * there is no user to scope by — see `AnalyticsOverview.usage`.
   */
  private async getUsage(since: Date): Promise<UsageAnalytics> {
    const window = { createdAt: { gte: since } };

    const [providerGroups, operationGroups, latencyGroups, rows] =
      await Promise.all([
        prisma.providerUsage.groupBy({
          by: ["provider", "succeeded"],
          where: window,
          _sum: { costUsd: true },
          _count: { _all: true },
        }),
        prisma.providerUsage.groupBy({
          by: ["operation", "succeeded"],
          where: window,
          _sum: { costUsd: true },
          _count: { _all: true },
        }),
        // `_avg` over a nullable column ignores nulls and returns null when
        // every row in the group is null — exactly the distinction between
        // "fast" and "not measured" that this table needs to preserve.
        prisma.providerUsage.groupBy({
          by: ["operation"],
          where: window,
          _avg: { latencyMs: true },
        }),
        prisma.providerUsage.findMany({
          where: window,
          orderBy: { createdAt: "desc" },
          take: USAGE_SERIES_LIMIT + 1,
          select: { createdAt: true, costUsd: true },
        }),
      ]);

    const dailyTruncated = rows.length > USAGE_SERIES_LIMIT;

    const byProvider = new Map<AiProviderType, ProviderUsageRow>();
    for (const group of providerGroups) {
      const row = byProvider.get(group.provider) ?? {
        provider: group.provider,
        costUsd: 0,
        requests: 0,
        failures: 0,
      };

      row.costUsd += Number(group._sum.costUsd ?? 0);
      row.requests += group._count._all;
      if (!group.succeeded) {
        row.failures += group._count._all;
      }

      byProvider.set(group.provider, row);
    }

    const avgLatencyByOperation = new Map(
      latencyGroups.map((group) => [group.operation, group._avg.latencyMs]),
    );

    const byOperation = new Map<string, OperationUsageRow>();
    for (const group of operationGroups) {
      const row = byOperation.get(group.operation) ?? {
        operation: group.operation,
        costUsd: 0,
        requests: 0,
        failures: 0,
        avgLatencyMs: avgLatencyByOperation.get(group.operation) ?? null,
      };

      row.costUsd += Number(group._sum.costUsd ?? 0);
      row.requests += group._count._all;
      if (!group.succeeded) {
        row.failures += group._count._all;
      }

      byOperation.set(group.operation, row);
    }

    const providerRows = [...byProvider.values()].sort(
      (a, b) => b.costUsd - a.costUsd || b.requests - a.requests,
    );
    const operationRows = [...byOperation.values()].sort(
      (a, b) => b.requests - a.requests,
    );

    return {
      // Summed from the exact `groupBy` result, never from the capped fetch.
      totalCostUsd: providerRows.reduce((sum, row) => sum + row.costUsd, 0),
      totalRequests: providerRows.reduce((sum, row) => sum + row.requests, 0),
      totalFailures: providerRows.reduce((sum, row) => sum + row.failures, 0),
      byProvider: providerRows,
      byOperation: operationRows,
      daily: dailyTruncated
        ? []
        : buildDailySeries(rows, since, ANALYTICS_WINDOW_DAYS),
      dailyTruncated,
    };
  }
}

/**
 * Buckets raw usage rows into one point per day, including days with no
 * activity — a gap-free axis is what makes a quiet week visible as a flat
 * stretch rather than as a chart that simply skips it.
 *
 * Bucketing is by the server's local date, which is also what `startOfDay`
 * used to pick the window, so the first and last buckets line up with the
 * boundaries the operator was told about.
 */
function buildDailySeries(
  rows: { createdAt: Date; costUsd: unknown }[],
  since: Date,
  days: number,
): DailyUsagePoint[] {
  const buckets = new Map<string, DailyUsagePoint>();

  for (let offset = 0; offset < days; offset += 1) {
    // `addDays` rather than adding 24h of milliseconds: across a daylight
    // saving change a day is 23 or 25 hours, and the arithmetic version would
    // drift off midnight and eventually emit the same date twice.
    const date = format(addDays(since, offset), "yyyy-MM-dd");
    buckets.set(date, { date, costUsd: 0, requests: 0 });
  }

  for (const row of rows) {
    const key = format(row.createdAt, "yyyy-MM-dd");
    const bucket = buckets.get(key);

    // A row can fall outside the pre-seeded range when a daylight-saving shift
    // moves a boundary by an hour. Dropping it keeps the axis honest rather
    // than inventing a 31st day.
    if (!bucket) {
      continue;
    }

    bucket.costUsd += Number(row.costUsd ?? 0);
    bucket.requests += 1;
  }

  return [...buckets.values()];
}

export const analyticsService = new AnalyticsService();
