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

/** One video's days, keyed by the YouTube video id the caller asked about. */
export interface VideoMetricsBatch {
  /** `youtubeVideoId` → that video's days, ascending. Videos the API had
   *  nothing to say about are simply absent — see `fetchVideosDailyMetrics`. */
  byVideo: Map<string, VideoDayMetrics[]>;
  /**
   * Whether monetary figures were obtainable for this channel at all.
   *
   * False means the API refused the revenue report — an unmonetised channel,
   * a channel not in the Partner Programme, a declined monetary scope. It is a
   * property of the channel and not of any one video, which is why it is
   * reported once for the batch rather than per row, and why every
   * `estimatedRevenue` below is null when it is false.
   */
  revenueAvailable: boolean;
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

/**
 * How many video ids may go into one `filters=video==...` list.
 *
 * The API documents a ceiling of 500 for this filter. Fifty is used instead,
 * and the reason is the response rather than the request: with
 * `dimensions=video,day` the row count is videos × days, so 500 videos over a
 * 30-day backfill chunk would be 15,000 rows in a single JSON body parsed on a
 * worker with 640 MB sharing the box with FFmpeg. Fifty keeps the worst case
 * at 1,500 rows, and the extra requests cost one quota unit each against a
 * pool this collector barely touches.
 */
export const VIDEO_BATCH_SIZE = 50;

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

export interface BatchAnalyticsQuery {
  accessToken: string;
  /** Up to `VIDEO_BATCH_SIZE` YouTube video ids. */
  youtubeVideoIds: string[];
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive, `YYYY-MM-DD`. */
  endDate: string;
  fetchImpl?: typeof fetch;
}

/** The API's own error envelope, when it bothers to send one. */
interface ApiError {
  error?: {
    message?: string;
    code?: number;
    errors?: Array<{ reason?: string }>;
  };
}

/** Reasons Google uses for "the daily allowance is gone". */
const QUOTA_REASONS = ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"];

export class YouTubeAnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the failure is the operator's permissions rather than a bug —
     * an unmonetised channel, a declined scope, a revoked grant. Callers use
     * this to skip a channel rather than fail an entire refresh. */
    readonly isPermission: boolean,
    /**
     * True when the Analytics API's own daily allowance is spent. Separate
     * from `isPermission` because the responses are opposite: a permission
     * failure is about this channel and needs the operator, a spent quota is
     * about the whole project and needs only time. A 403 can be either, so the
     * body's `reason` decides.
     */
    readonly isQuota: boolean = false,
  ) {
    super(message);
    this.name = "YouTubeAnalyticsError";
  }
}

async function query(
  metrics: readonly string[],
  {
    accessToken,
    videoIds,
    startDate,
    endDate,
    dimensions,
    fetchImpl = fetch,
  }: {
    accessToken: string;
    videoIds: string[];
    startDate: string;
    endDate: string;
    dimensions: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  const url = new URL(REPORTS_URL);
  // `channel==MINE` scopes the report to the channel the token belongs to, so
  // a token for one channel can never read another's figures even if a wrong
  // video id were passed.
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", metrics.join(","));
  url.searchParams.set("filters", `video==${videoIds.join(",")}`);
  // Without a `day` dimension the API collapses the whole range into a single
  // row. `VideoAnalytic` is keyed by day, so the day has to come back as data —
  // and when more than one video is asked about, `video` has to as well, or
  // every video's figures arrive summed together under one indistinguishable
  // row per day.
  url.searchParams.set("dimensions", dimensions);

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    let detail = "";
    let reasons: string[] = [];

    try {
      const body = (await response.json()) as ApiError;
      detail = body.error?.message ?? "";
      reasons = (body.error?.errors ?? []).map((entry) => entry?.reason ?? "");
    } catch {
      // A non-JSON error body (an HTML 502 from a proxy, say) is still a
      // failure worth reporting — just without the detail.
    }

    const isQuota = reasons.some((reason) => QUOTA_REASONS.includes(reason));

    throw new YouTubeAnalyticsError(
      detail || `YouTube Analytics returned ${response.status}`,
      response.status,
      // A spent quota answers 403 too, and treating it as a permission problem
      // would tell the operator to reconnect a channel that is working fine.
      !isQuota && (response.status === 401 || response.status === 403),
      isQuota,
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

function text(columns: string[], row: (string | number)[], name: string): string {
  const index = columns.indexOf(name);
  return index === -1 ? "" : String(row[index] ?? "");
}

/**
 * Daily metrics for up to `VIDEO_BATCH_SIZE` videos across a date range, in
 * two requests regardless of how many videos are asked about.
 *
 * ## Why revenue is a second request
 *
 * An unmonetised channel returns 403 for `estimatedRevenue`, and asking for it
 * in the same call as the core metrics would lose the views and watch time
 * along with it. Split, a revenue refusal costs only revenue: `revenueAvailable`
 * comes back false, every `estimatedRevenue` is null, and the numbers that did
 * work are returned intact.
 *
 * A refusal is the *only* revenue failure swallowed. A 500, a network fault or
 * a spent quota is a real fault and rethrows, because "this channel earns
 * nothing" and "we could not ask today" must not look the same to the caller.
 *
 * ## What an absent video means
 *
 * A video the API has nothing to say about — too few views to report on, or no
 * traffic at all in the window — is simply missing from `byVideo`. That is the
 * documented behaviour for a low-view video and it is not a failure: YouTube
 * withholds figures below a privacy threshold, and every channel has videos in
 * that state. Callers must treat absence as "nothing to record", never as an
 * error and never as zero.
 */
export async function fetchVideosDailyMetrics({
  accessToken,
  youtubeVideoIds,
  startDate,
  endDate,
  fetchImpl = fetch,
}: BatchAnalyticsQuery): Promise<VideoMetricsBatch> {
  const byVideo = new Map<string, VideoDayMetrics[]>();

  if (youtubeVideoIds.length === 0) {
    return { byVideo, revenueAvailable: true };
  }

  const shared = {
    accessToken,
    videoIds: youtubeVideoIds,
    startDate,
    endDate,
    dimensions: "video,day",
    fetchImpl,
  };

  const core = await query(CORE_METRICS, shared);

  // `video|day` → revenue, so a day's revenue can be matched back to the exact
  // row it belongs to rather than to whichever day happened to sort alongside.
  const revenueByKey = new Map<string, number>();
  let revenueAvailable = true;

  try {
    const revenue = await query(["estimatedRevenue"], shared);

    for (const row of revenue.rows) {
      const key = `${text(revenue.columns, row, "video")}|${text(revenue.columns, row, "day")}`;
      revenueByKey.set(key, column(revenue.columns, row, "estimatedRevenue"));
    }
  } catch (error) {
    // Only a permissions refusal is expected here. Anything else — a 500, a
    // spent quota — is a real fault worth surfacing rather than quietly
    // reporting "no revenue".
    if (!(error instanceof YouTubeAnalyticsError) || !error.isPermission) {
      throw error;
    }

    revenueAvailable = false;
  }

  for (const row of core.rows) {
    const videoId = text(core.columns, row, "video");
    const day = text(core.columns, row, "day");

    if (!videoId || !day) {
      continue;
    }

    const days = byVideo.get(videoId) ?? [];

    days.push({
      day,
      views: column(core.columns, row, "views"),
      likes: column(core.columns, row, "likes"),
      comments: column(core.columns, row, "comments"),
      estimatedMinutesWatched: column(core.columns, row, "estimatedMinutesWatched"),
      // The API names this `averageViewDuration` and reports it in seconds;
      // `VideoAnalytic.averageViewSeconds` says so in its own name.
      averageViewSeconds: column(core.columns, row, "averageViewDuration"),
      subscribersGained: column(core.columns, row, "subscribersGained"),
      estimatedRevenue: revenueAvailable
        ? (revenueByKey.get(`${videoId}|${day}`) ?? 0)
        : null,
    });

    byVideo.set(videoId, days);
  }

  for (const days of byVideo.values()) {
    days.sort((a, b) => a.day.localeCompare(b.day));
  }

  return { byVideo, revenueAvailable };
}

/**
 * Daily metrics for one video across a date range.
 *
 * A thin wrapper over `fetchVideosDailyMetrics` so there is exactly one place
 * that knows the request shape, the revenue split and the column decoding.
 * Returns an empty array for a video the API withheld figures for, which is
 * the same "absence is not an error" rule the batch function documents.
 */
export async function fetchVideoDailyMetrics(
  options: AnalyticsQuery,
): Promise<VideoDayMetrics[]> {
  const { byVideo } = await fetchVideosDailyMetrics({
    accessToken: options.accessToken,
    youtubeVideoIds: [options.youtubeVideoId],
    startDate: options.startDate,
    endDate: options.endDate,
    fetchImpl: options.fetchImpl,
  });

  return byVideo.get(options.youtubeVideoId) ?? [];
}
