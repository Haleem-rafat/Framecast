import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import {
  ChannelAnalyticsService,
  fromDayString,
  toDayString,
} from "@/services/channel-analytics.service";
import { projectService } from "@/services/project.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The analytics collector, against a real Postgres and a fake Google.
 *
 * Same discipline as publish.service.test.ts and release.service.test.ts:
 * every test gets its own throwaway `User` (src/test/fixtures.ts), because the
 * suite shares a database with real data. YouTube is never called — `fetch` is
 * injected into `ChannelAnalyticsService`, and the fake below answers both APIs
 * this collector talks to, in their real response shapes.
 *
 * Two APIs, and telling them apart is most of what the fake does. The Data API
 * (`googleapis.com/youtube/v3/channels`) returns lifetime totals as strings;
 * the Analytics API (`youtubeanalytics.googleapis.com`) returns
 * `columnHeaders` + `rows` and answers the revenue query separately from the
 * core metrics. Getting either shape wrong here would make these tests prove
 * something about a fixture rather than about the collector.
 */

// A collection is a claim, a snapshot, several report queries and a bounded set
// of writes — a few dozen sequential round trips to a remote database, and the
// backfill tests drive several collections in a row.
vi.setConfig({ testTimeout: 40_000 });

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("chanalytics");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
});

// ---------------------------------------------------------------------------
// A fake Google
// ---------------------------------------------------------------------------

interface FakeGoogleOptions {
  /** Lifetime channel totals, per access token. */
  channelStats?: { subscriberCount: number; viewCount: number; videoCount: number };
  /**
   * `youtubeVideoId` → the days it has figures for. A video absent from this
   * map is one the Analytics API says nothing about, which is exactly what a
   * low-view video looks like.
   */
  videoDays?: Record<string, Array<{ day: string; views: number; minutes?: number }>>;
  /** Fail `channels.list` with this status and reason. */
  channelsFailure?: { status: number; reason?: string; message?: string };
  /** Fail the core `reports.query` with this status and reason. */
  reportsFailure?: { status: number; reason?: string; message?: string };
  /** Refuse the monetary query, as an unmonetised channel does. */
  revenueRefused?: boolean;
}

interface FakeGoogle {
  fetchImpl: typeof fetch;
  /** Every URL requested, in order — the quota assertions read this. */
  calls: string[];
  /** Just the Analytics API calls. */
  reportCalls: string[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function googleError(status: number, reason?: string, message?: string): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        message: message ?? `request failed with ${status}`,
        errors: reason ? [{ reason }] : [],
      },
    },
    status,
  );
}

function fakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const calls: string[] = [];
  const reportCalls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    // ---- Data API: channels.list ----
    if (url.includes("googleapis.com/youtube/v3/channels")) {
      if (options.channelsFailure) {
        return googleError(
          options.channelsFailure.status,
          options.channelsFailure.reason,
          options.channelsFailure.message,
        );
      }

      const stats = options.channelStats ?? {
        subscriberCount: 1234,
        viewCount: 987654,
        videoCount: 42,
      };

      return jsonResponse({
        items: [
          {
            statistics: {
              // Google sends these as decimal strings, not numbers.
              subscriberCount: String(stats.subscriberCount),
              viewCount: String(stats.viewCount),
              videoCount: String(stats.videoCount),
              hiddenSubscriberCount: false,
            },
          },
        ],
      });
    }

    // ---- Analytics API: reports.query ----
    if (url.includes("youtubeanalytics.googleapis.com")) {
      reportCalls.push(url);

      const parsed = new URL(url);
      const metrics = (parsed.searchParams.get("metrics") ?? "").split(",");
      const isRevenue = metrics.includes("estimatedRevenue");
      const startDate = parsed.searchParams.get("startDate") ?? "";
      const endDate = parsed.searchParams.get("endDate") ?? "";
      const requested = (parsed.searchParams.get("filters") ?? "")
        .replace("video==", "")
        .split(",")
        .filter(Boolean);

      if (isRevenue && options.revenueRefused) {
        // What an unmonetised channel actually answers: a 403 whose reason is
        // *not* a quota reason, so the client classifies it as a permission
        // refusal and drops only the revenue.
        return googleError(403, "forbidden", "Insufficient permission to access this report.");
      }

      if (!isRevenue && options.reportsFailure) {
        return googleError(
          options.reportsFailure.status,
          options.reportsFailure.reason,
          options.reportsFailure.message,
        );
      }

      const columnHeaders = isRevenue
        ? [{ name: "video" }, { name: "day" }, { name: "estimatedRevenue" }]
        : [
            { name: "video" },
            { name: "day" },
            { name: "views" },
            { name: "likes" },
            { name: "comments" },
            { name: "estimatedMinutesWatched" },
            { name: "averageViewDuration" },
            { name: "subscribersGained" },
          ];

      const rows: (string | number)[][] = [];

      for (const videoId of requested) {
        for (const entry of options.videoDays?.[videoId] ?? []) {
          // The API only ever returns days inside the requested range.
          if (entry.day < startDate || entry.day > endDate) {
            continue;
          }

          rows.push(
            isRevenue
              ? [videoId, entry.day, entry.views * 0.002]
              : [
                  videoId,
                  entry.day,
                  entry.views,
                  Math.floor(entry.views / 10),
                  Math.floor(entry.views / 50),
                  entry.minutes ?? entry.views * 3,
                  180,
                  Math.floor(entry.views / 100),
                ],
          );
        }
      }

      // A query that matched nothing returns no `rows` key at all — not an
      // empty array. The client has to treat the absence as "no traffic".
      return jsonResponse(rows.length > 0 ? { columnHeaders, rows } : { columnHeaders });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  return { fetchImpl, calls, reportCalls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A connected channel with `count` published videos, and their YouTube ids. */
async function connectChannel({
  owner = userId,
  title = "Money Mechanics",
  videos = 1,
  publishedDaysAgo = 40,
}: {
  owner?: string;
  title?: string;
  videos?: number;
  publishedDaysAgo?: number;
} = {}): Promise<{ channelId: string; youtubeVideoIds: string[] }> {
  const channel = await channelService.connect(owner, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title,
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    // Comfortably beyond `REFRESH_WINDOW_MS`, so `resolveAccessToken` decrypts
    // the stored token rather than trying to reach Google's token endpoint —
    // which nothing here stubs, and which would be a real network call.
    expiresInSeconds: 3600,
    scopes: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ],
  });

  const project = await projectService.create(owner, {
    name: `analytics-${randomUUID().slice(0, 8)}`,
    channelId: channel.id,
  });

  const publishedAt = new Date(Date.now() - publishedDaysAgo * 86_400_000);
  const youtubeVideoIds: string[] = [];

  for (let index = 0; index < videos; index += 1) {
    const youtubeVideoId = `yt_${randomUUID().slice(0, 8)}`;
    youtubeVideoIds.push(youtubeVideoId);

    const video = await prisma.video.create({
      data: {
        title: `Video ${index + 1}`,
        userId: owner,
        projectId: project.id,
        status: "PUBLISHED",
      },
      select: { id: true },
    });

    await prisma.publication.create({
      data: {
        videoId: video.id,
        channelId: channel.id,
        youtubeVideoId,
        title: `Video ${index + 1}`,
        status: "PUBLISHED",
        publishedAt,
      },
    });
  }

  return { channelId: channel.id, youtubeVideoIds };
}

/** `n` days before today, as the API's `YYYY-MM-DD`. */
function daysAgo(n: number): string {
  return toDayString(new Date(Date.now() - n * 86_400_000));
}

/** Drives ticks until none is due, so a backfill can be run to completion. */
async function collectUntilIdle(
  service: ChannelAnalyticsService,
  limit = 30,
): Promise<number> {
  let runs = 0;

  for (let index = 0; index < limit; index += 1) {
    // The claim only takes a channel whose `nextCollectionAt` has arrived, and
    // a successful run pushes that fifteen minutes out while backfilling. Time
    // is moved rather than waited on.
    await prisma.channelCollection.updateMany({
      data: { nextCollectionAt: new Date(Date.now() - 1000) },
    });

    const result = await service.tick();

    if (!result) {
      break;
    }

    runs += 1;

    if (result.outcome === "failed" || result.backfilledTo === null) {
      break;
    }
  }

  return runs;
}

// ---------------------------------------------------------------------------

describe("ChannelAnalyticsService.tick", () => {
  it("writes a channel snapshot and per-video days on a first collection", async () => {
    const { channelId, youtubeVideoIds } = await connectChannel({ videos: 1 });
    const [videoId] = youtubeVideoIds;

    const google = fakeGoogle({
      channelStats: { subscriberCount: 5000, viewCount: 250_000, videoCount: 12 },
      videoDays: {
        [videoId]: [
          { day: daysAgo(3), views: 400 },
          { day: daysAgo(4), views: 250 },
        ],
      },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    const result = await service.tick();

    expect(result?.outcome).toBe("collected");
    expect(result?.snapshotTaken).toBe(true);

    const snapshot = await prisma.channelStatistic.findFirstOrThrow({
      where: { channelId },
    });
    expect(snapshot.subscriberCount).toBe(BigInt(5000));
    expect(snapshot.viewCount).toBe(BigInt(250_000));
    expect(snapshot.videoCount).toBe(12);

    const days = await prisma.videoAnalytic.findMany({
      where: { publication: { channelId } },
      orderBy: { capturedFor: "asc" },
    });
    expect(days).toHaveLength(2);
    expect(days.map((row) => toDayString(row.capturedFor))).toEqual([
      daysAgo(4),
      daysAgo(3),
    ]);
    expect(days[1].views).toBe(BigInt(400));
    // 400 views × 3 minutes each, from the fake's shape.
    expect(days[1].watchTimeMinutes).toBeCloseTo(1200, 5);
  });

  it("never asks about the last two days, which YouTube does not report", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 10 }] },
    });

    await new ChannelAnalyticsService(google.fetchImpl).tick();

    const today = toDayString(new Date());
    const yesterday = daysAgo(1);

    for (const call of google.reportCalls) {
      const endDate = new URL(call).searchParams.get("endDate") ?? "";
      expect(endDate < yesterday).toBe(true);
      expect(endDate).not.toBe(today);
    }
  });

  it("costs one Data API unit per collection", async () => {
    // The Data API's 10,000 units are shared with publishing across the whole
    // Google Cloud project, so this is the number that has to stay small. Every
    // per-video figure comes from the Analytics API's separate pool.
    await connectChannel({ videos: 60 });

    const google = fakeGoogle();
    await new ChannelAnalyticsService(google.fetchImpl).tick();

    const dataApiCalls = google.calls.filter((url) =>
      url.includes("googleapis.com/youtube/v3/"),
    );
    expect(dataApiCalls).toHaveLength(1);
    expect(dataApiCalls[0]).toContain("part=statistics");

    // 60 videos batch into two groups of ≤50, each asked twice (core metrics
    // and revenue) per date range.
    const batchSizes = google.reportCalls.map(
      (url) =>
        (new URL(url).searchParams.get("filters") ?? "")
          .replace("video==", "")
          .split(",").length,
    );
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(50);
  });
});

describe("a channel that fails", () => {
  it("does not stop the other channels from being collected", async () => {
    // The failure this models is the one that actually happens: a revoked or
    // expired OAuth grant, which Google answers with a 401 on the first call.
    const dead = await connectChannel({ title: "Dead Token", videos: 1 });
    const healthy = await connectChannel({ title: "Healthy", videos: 1 });

    const google = fakeGoogle({
      videoDays: { [healthy.youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 900 }] },
    });

    // Only the first channel's token fails. `claimDue` orders candidates by
    // `connectedAt` ascending, so the first `channels.list` of the run is the
    // dead channel's — which is what makes "the failure comes first" true
    // rather than assumed, and is the ordering that matters: a failure that
    // happened *after* the healthy channel would prove nothing.
    let seenChannels = 0;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("googleapis.com/youtube/v3/channels")) {
        seenChannels += 1;
        // The first channel claimed is the one connected first — `claimDue`
        // orders by `connectedAt` ascending — which is the dead one.
        if (seenChannels === 1) {
          return googleError(401, "authError", "Invalid Credentials");
        }
      }

      return google.fetchImpl(url, init);
    }) as typeof fetch;

    const service = new ChannelAnalyticsService(fetchImpl);

    const first = await service.tick();
    const second = await service.tick();

    expect(first?.channelTitle).toBe("Dead Token");
    expect(first?.outcome).toBe("failed");
    expect(first?.reason).toContain("Invalid Credentials");

    // The second channel was collected in full, in the very next tick.
    expect(second?.channelTitle).toBe("Healthy");
    expect(second?.outcome).toBe("collected");

    expect(
      await prisma.videoAnalytic.count({
        where: { publication: { channelId: healthy.channelId } },
      }),
    ).toBe(1);
    expect(
      await prisma.videoAnalytic.count({
        where: { publication: { channelId: dead.channelId } },
      }),
    ).toBe(0);
  });

  it("names the failing channel and the reason on the page", async () => {
    await connectChannel({ title: "Broken" });

    const google = fakeGoogle({
      channelsFailure: { status: 401, reason: "authError", message: "Invalid Credentials" },
    });

    await new ChannelAnalyticsService(google.fetchImpl).tick();

    const overview = await new ChannelAnalyticsService(
      google.fetchImpl,
    ).getOverview(userId);

    const channel = overview.channels.find((row) => row.title === "Broken");
    expect(channel?.health).toBe("failing");
    expect(channel?.lastError).toContain("Invalid Credentials");
    // Never collected *and* failing: the reason must win over "never", or the
    // operator sees "not collected yet" forever with nothing explaining it.
    expect(channel?.lastCollectedAt).toBeNull();
    expect(channel?.lifetime).toBeNull();
  });

  it("backs a failing channel off instead of retrying every poll", async () => {
    await connectChannel({ title: "Broken" });

    const google = fakeGoogle({
      channelsFailure: { status: 500, message: "backend error" },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.consecutiveFailures).toBe(1);
    expect(state.nextCollectionAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    // The claim is released, not held — a channel still holding a lease is a
    // channel every later tick skips.
    expect(state.claimExpiresAt).toBeNull();

    // And nothing is due, so a second tick finds nothing rather than hammering.
    expect(await service.tick()).toBeNull();
  });
});

describe("quota exhaustion", () => {
  it("surfaces rather than retrying silently, and waits for the reset", async () => {
    await connectChannel({ title: "Spent" });

    const google = fakeGoogle({
      channelsFailure: { status: 403, reason: "quotaExceeded" },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    const result = await service.tick();

    expect(result?.outcome).toBe("failed");
    expect(result?.reason).toContain("quota");
    expect(result?.reason).toContain("midnight Pacific Time");
    // Says out loud that it will not keep trying, which is the difference
    // between a surfaced failure and a silent retry loop.
    expect(result?.reason).toContain("will not retry");

    const state = await prisma.channelCollection.findFirstOrThrow();
    // Pushed past the reset rather than retried in an hour: the allowance is
    // per Google Cloud project and shared with `videos.insert`, so retrying
    // early cannot succeed and can only take units publishing needs.
    expect(state.nextCollectionAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    expect(await service.tick()).toBeNull();

    const overview = await service.getOverview(userId);
    expect(overview.channels[0]?.lastError).toContain("quota");
  });

  it("treats a quota 403 as quota, not as a dead token", async () => {
    // Both answer 403. Telling the operator to reconnect a perfectly healthy
    // channel because the project ran out of units would be the wrong advice.
    await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      reportsFailure: { status: 403, reason: "quotaExceeded" },
    });

    const result = await new ChannelAnalyticsService(google.fetchImpl).tick();

    expect(result?.reason).toContain("quota");
    expect(result?.reason).not.toContain("reconnect");
  });
});

describe("a video the Analytics API says nothing about", () => {
  it("records no rows for it and does not fail the collection", async () => {
    // YouTube withholds figures for a video below its privacy threshold. The
    // response is an empty result — no `rows` key at all — which is exactly
    // what a video with genuinely no traffic returns, and neither is an error.
    const { channelId, youtubeVideoIds } = await connectChannel({ videos: 2 });
    const [busy, quiet] = youtubeVideoIds;

    const google = fakeGoogle({
      videoDays: { [busy]: [{ day: daysAgo(3), views: 700 }] },
    });

    const result = await new ChannelAnalyticsService(google.fetchImpl).tick();

    expect(result?.outcome).toBe("collected");

    const rows = await prisma.videoAnalytic.findMany({
      where: { publication: { channelId } },
      select: { publicationId: true, views: true },
    });

    // One row for the busy video, and *nothing* for the quiet one. Not a zero:
    // "not reported" and "measured as nothing" are different claims, and a zero
    // row would be aggregated into the channel's averages as a real datapoint.
    expect(rows).toHaveLength(1);
    expect(rows[0].views).toBe(BigInt(700));

    const quietPublication = await prisma.publication.findFirstOrThrow({
      where: { youtubeVideoId: quiet },
      select: { id: true },
    });
    expect(
      await prisma.videoAnalytic.count({
        where: { publicationId: quietPublication.id },
      }),
    ).toBe(0);
  });

  it("collects a channel with no published videos at all", async () => {
    const { channelId } = await connectChannel({ videos: 0 });

    const google = fakeGoogle();
    const result = await new ChannelAnalyticsService(google.fetchImpl).tick();

    expect(result?.outcome).toBe("collected");
    expect(result?.snapshotTaken).toBe(true);
    expect(await prisma.channelStatistic.count({ where: { channelId } })).toBe(1);

    // Nothing to backfill, so it drops straight to the daily cadence rather
    // than spinning every fifteen minutes over an empty list.
    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.backfillComplete).toBe(true);
    expect(state.nextCollectionAt.getTime()).toBeGreaterThan(
      Date.now() + 20 * 3_600_000,
    );
  });
});

describe("re-running on the same day", () => {
  it("updates the existing rows instead of duplicating them", async () => {
    const { channelId, youtubeVideoIds } = await connectChannel({ videos: 1 });
    const [videoId] = youtubeVideoIds;
    const day = daysAgo(3);

    const first = fakeGoogle({ videoDays: { [videoId]: [{ day, views: 100 }] } });
    await new ChannelAnalyticsService(first.fetchImpl).tick();

    const publication = await prisma.publication.findFirstOrThrow({
      where: { channelId },
      select: { id: true },
    });

    expect(
      await prisma.videoAnalytic.count({ where: { publicationId: publication.id } }),
    ).toBe(1);

    // Make it due again immediately, as the worker would the next day.
    await prisma.channelCollection.updateMany({
      data: { nextCollectionAt: new Date(Date.now() - 1000) },
    });

    // YouTube has since revised the day upward — which is the normal case for
    // a recent day, and the whole reason the revision window is re-collected.
    const second = fakeGoogle({ videoDays: { [videoId]: [{ day, views: 175 }] } });
    const result = await new ChannelAnalyticsService(second.fetchImpl).tick();

    expect(result?.outcome).toBe("collected");

    const rows = await prisma.videoAnalytic.findMany({
      where: { publicationId: publication.id },
    });

    // `@@unique([publicationId, capturedFor])` holds: still one row, and it
    // carries the revised figure rather than the stale one.
    expect(rows).toHaveLength(1);
    expect(rows[0].views).toBe(BigInt(175));
  });

  it("takes only one channel snapshot per day however often it runs", async () => {
    const { channelId } = await connectChannel({ videos: 1 });

    const google = fakeGoogle();
    const service = new ChannelAnalyticsService(google.fetchImpl);

    await service.tick();
    await prisma.channelCollection.updateMany({
      data: { nextCollectionAt: new Date(Date.now() - 1000) },
    });
    const second = await service.tick();

    expect(second?.outcome).toBe("collected");
    expect(second?.snapshotTaken).toBe(false);
    // Otherwise a backfilling channel writes ninety-six near-identical rows a
    // day and the growth series measures the collector's cadence, not growth.
    expect(await prisma.channelStatistic.count({ where: { channelId } })).toBe(1);
  });
});

describe("the backfill", () => {
  it("walks history in bounded chunks rather than one burst", async () => {
    const { channelId, youtubeVideoIds } = await connectChannel({
      videos: 1,
      publishedDaysAgo: 90,
    });

    // Ninety days of daily traffic — more than one chunk can cover.
    const days = Array.from({ length: 88 }, (_, index) => ({
      day: daysAgo(index + 2),
      views: 10 + index,
    }));

    const google = fakeGoogle({ videoDays: { [youtubeVideoIds[0]]: days } });
    const service = new ChannelAnalyticsService(google.fetchImpl);

    const firstRun = await service.tick();
    expect(firstRun?.outcome).toBe("collected");

    const afterFirst = await prisma.videoAnalytic.count({
      where: { publication: { channelId } },
    });

    // One run covers the revision window plus a single 30-day chunk — not the
    // whole 90 days. This is the constraint that stops a first collection
    // being a burst of hundreds of API calls in one loop iteration.
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(days.length);

    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.backfillComplete).toBe(false);
    // Still on the fast cadence while there is history left to walk.
    expect(state.nextCollectionAt.getTime()).toBeLessThan(Date.now() + 3_600_000);

    // Run it out.
    await collectUntilIdle(service);

    const finished = await prisma.channelCollection.findFirstOrThrow();
    expect(finished.backfillComplete).toBe(true);
    // And once caught up it drops to a daily cadence.
    expect(finished.nextCollectionAt.getTime()).toBeGreaterThan(
      Date.now() + 20 * 3_600_000,
    );

    expect(
      await prisma.videoAnalytic.count({ where: { publication: { channelId } } }),
    ).toBe(days.length);
  });

  it("stops at the earliest publication rather than the floor", async () => {
    const { channelId, youtubeVideoIds } = await connectChannel({
      videos: 1,
      publishedDaysAgo: 20,
    });

    const google = fakeGoogle({
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(5), views: 42 }] },
    });
    const service = new ChannelAnalyticsService(google.fetchImpl);

    await collectUntilIdle(service);

    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.backfillComplete).toBe(true);

    // Never asked about a day before the video existed — there is nothing there
    // to find, and every request spends real quota.
    const earliestAsked = google.reportCalls
      .map((url) => new URL(url).searchParams.get("startDate") ?? "")
      .sort()[0];
    expect(earliestAsked >= daysAgo(21)).toBe(true);

    expect(
      await prisma.videoAnalytic.count({ where: { publication: { channelId } } }),
    ).toBe(1);
  });
});

describe("revenue", () => {
  it("is reported when YouTube answers the monetary query", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 1000 }] },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.revenueAvailable).toBe(true);

    const overview = await service.getOverview(userId);
    // 1000 views × $0.002, from the fake's shape.
    expect(overview.channels[0]?.window?.estimatedRevenue).toBeCloseTo(2, 3);
    expect(overview.revenueKnown).toBe(true);
  });

  it("is null, not zero, for a channel YouTube refuses to answer for", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      revenueRefused: true,
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 1000 }] },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    const result = await service.tick();

    // The refusal costs only revenue. Views and watch time came back intact,
    // which is the entire reason revenue is a separate request.
    expect(result?.outcome).toBe("collected");
    expect(result?.videoDays).toBe(1);

    const state = await prisma.channelCollection.findFirstOrThrow();
    expect(state.revenueAvailable).toBe(false);

    const overview = await service.getOverview(userId);
    expect(overview.channels[0]?.window?.views).toBe(1000);
    // Null rather than 0: "$0.00 earned" and "we were never allowed to ask"
    // are different statements, and the page renders no revenue cell at all.
    expect(overview.channels[0]?.window?.estimatedRevenue).toBeNull();
    expect(overview.revenueKnown).toBe(false);
  });

  it("is scoped to the owner, so one operator never sees another's", async () => {
    const otherUserId = await createTestUser("chanalytics-other");

    try {
      const mine = await connectChannel({ title: "Mine", videos: 1 });
      const theirs = await connectChannel({
        owner: otherUserId,
        title: "Theirs",
        videos: 1,
      });

      const google = fakeGoogle({
        videoDays: {
          [mine.youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 10 }],
          [theirs.youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 99_999 }],
        },
      });

      const service = new ChannelAnalyticsService(google.fetchImpl);
      await service.tick();
      await service.tick();

      const overview = await service.getOverview(userId);

      expect(overview.channels.map((row) => row.title)).toEqual(["Mine"]);
      expect(overview.channels[0]?.window?.views).toBe(10);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("a channel that has never been collected", () => {
  it("reports 'never', with no figures and no implied zeros", async () => {
    await connectChannel({ title: "Fresh" });

    const overview = await new ChannelAnalyticsService(
      fakeGoogle().fetchImpl,
    ).getOverview(userId);

    const channel = overview.channels[0];

    expect(channel?.health).toBe("never");
    expect(channel?.lastCollectedAt).toBeNull();
    // Every one of these is null rather than 0. A rendered zero would read as
    // a measurement of a channel nobody has asked YouTube about yet.
    expect(channel?.lifetime).toBeNull();
    expect(channel?.window).toBeNull();
    expect(channel?.dataThrough).toBeNull();
    expect(channel?.subscriberChange).toBeNull();
    expect(channel?.topVideos).toEqual([]);
    expect(overview.anyCollected).toBe(false);
  });

  it("withholds a change figure until there are two snapshots to compare", async () => {
    const { channelId } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      channelStats: { subscriberCount: 100, viewCount: 1000, videoCount: 3 },
    });
    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const afterOne = await service.getOverview(userId);
    expect(afterOne.channels[0]?.lifetime?.subscriberCount).toBe(100);
    // One point is not a trend, and "+0" would read as a measured flat line.
    expect(afterOne.channels[0]?.subscriberChange).toBeNull();

    // A second snapshot, backdated so it is genuinely older than the first.
    await prisma.channelStatistic.create({
      data: {
        channelId,
        subscriberCount: BigInt(60),
        viewCount: BigInt(400),
        videoCount: 2,
        capturedAt: new Date(Date.now() - 5 * 86_400_000),
      },
    });

    const afterTwo = await service.getOverview(userId);
    expect(afterTwo.channels[0]?.subscriberChange).toBe(40);
    expect(afterTwo.channels[0]?.viewChange).toBe(600);
  });

  it("reports how stale its figures are", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(4), views: 30 }] },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const overview = await service.getOverview(userId);
    const channel = overview.channels[0];

    expect(channel?.lastCollectedAt).toBeInstanceOf(Date);
    // The figures trail the capture, and the page has to be able to say by how
    // much — a dashboard that looks live but is days old is the failure here.
    expect(channel?.dataThrough).toEqual(fromDayString(daysAgo(4)));
    expect(channel!.dataThrough!.getTime()).toBeLessThan(
      channel!.lastCollectedAt!.getTime(),
    );
  });
});

describe("the client boundary", () => {
  it("hands the page plain numbers, never BigInt or Decimal", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      channelStats: { subscriberCount: 5000, viewCount: 250_000, videoCount: 12 },
      videoDays: { [youtubeVideoIds[0]]: [{ day: daysAgo(3), views: 800 }] },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const overview = await service.getOverview(userId);

    // Next.js cannot pass a BigInt or a Prisma.Decimal through a server
    // component boundary — either one escaping this payload is a render-time
    // crash, not a wrong number. `JSON.stringify` is the same check the
    // framework effectively performs, and it throws on BigInt.
    expect(() => JSON.stringify(overview)).not.toThrow();

    const channel = overview.channels[0];
    expect(typeof channel?.lifetime?.subscriberCount).toBe("number");
    expect(typeof channel?.lifetime?.viewCount).toBe("number");
    expect(typeof channel?.window?.views).toBe("number");
    expect(typeof channel?.window?.estimatedRevenue).toBe("number");
    expect(typeof channel?.topVideos[0]?.views).toBe("number");
  });

  it("weights average view duration by views rather than averaging averages", async () => {
    const { youtubeVideoIds } = await connectChannel({ videos: 1 });

    const google = fakeGoogle({
      videoDays: {
        [youtubeVideoIds[0]]: [
          // A quiet day and a busy one. Averaging the two per-day averages
          // would let the three-view day count as much as the 3,000-view one.
          { day: daysAgo(3), views: 3000, minutes: 6000 },
          { day: daysAgo(4), views: 3, minutes: 30 },
        ],
      },
    });

    const service = new ChannelAnalyticsService(google.fetchImpl);
    await service.tick();

    const overview = await service.getOverview(userId);
    const totals = overview.channels[0]?.window;

    expect(totals?.views).toBe(3003);
    expect(totals?.watchTimeMinutes).toBeCloseTo(6030, 3);
    // 6030 minutes × 60 ÷ 3003 views ≈ 120.5 seconds.
    expect(totals?.averageViewSeconds).toBeCloseTo((6030 * 60) / 3003, 3);
  });
});

describe("claiming", () => {
  it("lets only one of two concurrent workers collect a channel", async () => {
    const { channelId } = await connectChannel({ videos: 1 });

    const google = fakeGoogle();
    const a = new ChannelAnalyticsService(google.fetchImpl);
    const b = new ChannelAnalyticsService(google.fetchImpl);

    const [first, second] = await Promise.all([a.claimDue(), b.claimDue()]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.channelId).toBe(channelId);

    // Exactly one state row, so no second claim can ever be created for it.
    expect(await prisma.channelCollection.count({ where: { channelId } })).toBe(1);
  });

  it("skips a channel the operator has switched off", async () => {
    const { channelId } = await connectChannel({ videos: 1 });
    await prisma.channel.update({
      where: { id: channelId },
      data: { isActive: false },
    });

    const service = new ChannelAnalyticsService(fakeGoogle().fetchImpl);
    expect(await service.claimDue()).toBeNull();
  });

  it("re-claims a channel whose worker died holding the lease", async () => {
    await connectChannel({ videos: 1 });

    const service = new ChannelAnalyticsService(fakeGoogle().fetchImpl);
    const claim = await service.claimDue();
    expect(claim).not.toBeNull();

    // A second claim is refused while the lease is live.
    expect(await service.claimDue()).toBeNull();

    // The worker dies. Nothing else would ever clear the claim, which is why
    // it is a lease and not a lock.
    await prisma.channelCollection.updateMany({
      data: {
        claimExpiresAt: new Date(Date.now() - 1000),
        nextCollectionAt: new Date(Date.now() - 1000),
      },
    });

    expect(await service.claimDue()).not.toBeNull();
  });
});
