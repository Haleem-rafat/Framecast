/**
 * A thin client over the YouTube Analytics API (v2 `reports.query`).
 *
 * This is a *different* API from the Data API the rest of the app uses to
 * upload and update videos: different host, different quota pool, different
 * scope. `YOUTUBE_SCOPES` in youtube-oauth.ts already requests both analytics
 * scopes, so every already-connected channel can be queried without asking the
 * operator to reconnect.
 *
 * Kept free of Prisma and of `server-only` so it can be tested against a
 * stubbed fetch without a database.
 */

/** One day's numbers for one video, as the API reports them. */
export interface VideoDayMetrics {
  /** The day these figures describe, `YYYY-MM-DD` in the channel's timezone. */
  day: string;
  views: number;
  likes: number;
  comments: number;
  estimatedMinutesWatched: number;
  /** Mean seconds watched per view. */
  averageViewSeconds: number;
  subscribersGained: number;
  /**
   * Null rather than 0 when the channel is not monetised or the operator
   * declined the monetary scope. Zero would be a claim that the video earned
   * nothing, which is a different statement from "we were not allowed to ask".
   */
  estimatedRevenue: number | null;
}

/**
 * Metrics requested for every video, in the order the API returns their
 * columns. Every one of these is documented as supported for a channel owner
 * querying their own videos.
 *
 * `impressions` and `impressionClickThroughRate` are deliberately NOT here.
 * They appear in YouTube Studio and in the bulk Reporting API, but the
 * Analytics API rejects them for channel queries — asking for them fails the
 * whole request, taking the metrics that do work down with them. `VideoAnalytic`
 * has columns for both; they stay at their zero defaults, and `impressionsKnown`
 * below is how a caller can tell "not measured" from "measured as zero".
 */
const CORE_METRICS = [
  "views",
  "likes",
  "comments",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersGained",
] as const;

/** The Analytics API never reports impressions or CTR for a channel query. */
export const impressionsKnown = false;

const REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";

export interface AnalyticsQuery {
  accessToken: string;
  /** The YouTube video id, e.g. `xjRAQfC2lFE`. */
  youtubeVideoId: string;
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive, `YYYY-MM-DD`. */
  endDate: string;
  fetchImpl?: typeof fetch;
}

/** The API's own error envelope, when it bothers to send one. */
interface ApiError {
  error?: { message?: string; code?: number };
}

export class YouTubeAnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the failure is the operator's permissions rather than a bug —
     * an unmonetised channel, a declined scope, a revoked grant. Callers use
     * this to skip a channel rather than fail an entire refresh. */
    readonly isPermission: boolean,
  ) {
    super(message);
    this.name = "YouTubeAnalyticsError";
  }
}

async function query(
  metrics: readonly string[],
  { accessToken, youtubeVideoId, startDate, endDate, fetchImpl = fetch }: AnalyticsQuery,
): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  const url = new URL(REPORTS_URL);
  // `channel==MINE` scopes the report to the channel the token belongs to, so
  // a token for one channel can never read another's figures even if a wrong
  // video id were passed.
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", metrics.join(","));
  url.searchParams.set("filters", `video==${youtubeVideoId}`);
  // Without a dimension the API collapses the whole range into a single row.
  // `VideoAnalytic` is keyed by day, so the day has to come back as data.
  url.searchParams.set("dimensions", "day");

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as ApiError;
      detail = body.error?.message ?? "";
    } catch {
      // A non-JSON error body (an HTML 502 from a proxy, say) is still a
      // failure worth reporting — just without the detail.
    }

    throw new YouTubeAnalyticsError(
      detail || `YouTube Analytics returned ${response.status}`,
      response.status,
      response.status === 401 || response.status === 403,
    );
  }

  const body = (await response.json()) as {
    columnHeaders?: { name: string }[];
    rows?: (string | number)[][];
  };

  return {
    columns: (body.columnHeaders ?? []).map((header) => header.name),
    // A video with no traffic in the window returns no `rows` key at all,
    // which is an empty result and not an error.
    rows: body.rows ?? [],
  };
}

function column(columns: string[], row: (string | number)[], name: string): number {
  const index = columns.indexOf(name);

  // A metric the API silently omitted reads as 0 rather than NaN. Indexing by
  // name rather than by position matters: the API is documented to return
  // columns in the requested order, but a missing column would otherwise shift
  // every subsequent value onto the wrong metric.
  if (index === -1) return 0;

  const value = row[index];

  return typeof value === "number" ? value : Number(value) || 0;
}

/**
 * Daily metrics for one video across a date range.
 *
 * Revenue is fetched in a second, separate request on purpose: an unmonetised
 * channel returns 403 for `estimatedRevenue`, and asking for it in the same
 * call as the core metrics would lose the views and watch time along with it.
 * A revenue failure leaves `estimatedRevenue` null and is otherwise ignored.
 */
export async function fetchVideoDailyMetrics(
  options: AnalyticsQuery,
): Promise<VideoDayMetrics[]> {
  const core = await query(CORE_METRICS, options);

  const revenueByDay = new Map<string, number>();
  try {
    const revenue = await query(["estimatedRevenue"], options);
    for (const row of revenue.rows) {
      const day = String(row[revenue.columns.indexOf("day")] ?? "");
      if (day) revenueByDay.set(day, column(revenue.columns, row, "estimatedRevenue"));
    }
  } catch (error) {
    // Only a permissions refusal is expected here. Anything else is a real
    // fault worth surfacing rather than quietly reporting "no revenue".
    if (!(error instanceof YouTubeAnalyticsError) || !error.isPermission) {
      throw error;
    }
  }

  const dayIndex = core.columns.indexOf("day");

  return core.rows.map((row) => {
    const day = String(row[dayIndex] ?? "");

    return {
      day,
      views: column(core.columns, row, "views"),
      likes: column(core.columns, row, "likes"),
      comments: column(core.columns, row, "comments"),
      estimatedMinutesWatched: column(core.columns, row, "estimatedMinutesWatched"),
      // The API names this `averageViewDuration` and reports it in seconds;
      // `VideoAnalytic.averageViewSeconds` says so in its own name.
      averageViewSeconds: column(core.columns, row, "averageViewDuration"),
      subscribersGained: column(core.columns, row, "subscribersGained"),
      estimatedRevenue: revenueByDay.get(day) ?? null,
    };
  });
}
