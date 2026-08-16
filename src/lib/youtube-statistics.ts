/**
 * A thin client over the YouTube **Data** API's `channels.list`, for the one
 * thing the Analytics API cannot answer: what a channel's lifetime totals are
 * right now.
 *
 * Two different Google services are involved in collecting analytics and they
 * are not interchangeable. This module is the Data API — the same service and
 * the same 10,000-unit daily pool that `videos.insert` and `thumbnails.set`
 * spend from, shared across the whole Google Cloud project rather than per
 * channel. `youtube-analytics.ts` beside it is the Analytics API: different
 * host, different quota, different query shape.
 *
 * Only `channels.list` is here, and that is a decision rather than an
 * omission. See `fetchChannelStatistics` below for why `videos.list` is not.
 *
 * Kept free of Prisma and of `server-only` so it can be tested against a
 * stubbed fetch without a database, exactly as `youtube-analytics.ts` is.
 */

const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

/**
 * A channel's lifetime totals, as `channels.list` reports them at the instant
 * it is called. This is the whole of what `ChannelStatistic` stores, and the
 * API offers no history — see `subscriberCountHidden` for the one field that
 * needs care.
 */
export interface ChannelStatisticsSnapshot {
  subscriberCount: number;
  viewCount: number;
  videoCount: number;
  /**
   * True when the channel has chosen to hide its subscriber count publicly.
   *
   * YouTube then returns `hiddenSubscriberCount: true` and either omits
   * `subscriberCount` or rounds it hard. An owner's own token usually still
   * gets the real figure, but not always, so the flag is surfaced rather than
   * assumed away: a rounded count written into a growth series produces
   * step changes that did not happen.
   */
  subscriberCountHidden: boolean;
}

/** The API's own error envelope, when it bothers to send one. */
interface ApiError {
  error?: {
    message?: string;
    errors?: Array<{ reason?: string }>;
  };
}

/**
 * A failed Data API call, classified into the three cases the collector
 * treats differently.
 *
 * The status code alone cannot separate them and 403 in particular cannot:
 * Google answers 403 for a revoked grant, for a channel that has gone, *and*
 * for a spent daily allowance, and only the last of those is fixed by waiting.
 * The distinguishing token is `error.errors[].reason` in the body, so the body
 * is read — best-effort, because Google's edge answers some failures with an
 * HTML page and a parse error must never replace a real reason with a worse
 * one.
 */
export class YouTubeDataApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The operator's permissions rather than a bug — a revoked grant, a
     *  deleted channel. Waiting will not fix it; reconnecting might. */
    readonly isPermission: boolean,
    /**
     * The shared 10,000-unit daily pool is spent. Distinguished because it is
     * the one failure that is *not* about this channel at all: it fails every
     * channel in the project identically, and it also means publishing is
     * about to fail. The collector stops for the day rather than retrying.
     */
    readonly isQuota: boolean,
  ) {
    super(message);
    this.name = "YouTubeDataApiError";
  }
}

/** Reasons Google uses for "the daily allowance is gone". */
const QUOTA_REASONS = ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"];

async function describeFailure(response: Response): Promise<YouTubeDataApiError> {
  let message = "";
  let reasons: string[] = [];

  try {
    const body = (await response.json()) as ApiError;
    message = body.error?.message ?? "";
    reasons = (body.error?.errors ?? []).map((entry) => entry?.reason ?? "");
  } catch {
    // A non-JSON error body (an HTML 502 from a proxy, say) is still a failure
    // worth reporting — just without the detail.
  }

  const isQuota = reasons.some((reason) => QUOTA_REASONS.includes(reason));

  return new YouTubeDataApiError(
    message || `YouTube returned ${response.status}`,
    response.status,
    // A quota 403 is emphatically not a permission problem, so it must not be
    // classified as one — the collector's responses to the two are opposite.
    !isQuota && (response.status === 401 || response.status === 403),
    isQuota,
  );
}

/** `"12345"` → `12345`. Google sends these counts as decimal strings. */
function count(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The channel's current lifetime totals. Costs **1 quota unit**.
 *
 * `mine=true` rather than an explicit channel id, matching how
 * youtube-oauth.ts and brand.service.ts already identify a channel: the token
 * decides which channel is read, so a wrong id cannot make one channel's token
 * report another channel's figures.
 *
 * ## Why there is no `videos.list` beside this
 *
 * `videos.list?part=statistics` would be the obvious companion — 1 unit per 50
 * ids, so almost free — and it is deliberately absent.
 *
 * It returns **lifetime** totals, valid only for the instant it is called, and
 * `VideoAnalytic` is keyed `[publicationId, capturedFor]` — one row per video
 * per *day*. A lifetime figure has no day to be keyed to. Writing it into
 * today's row would mean `views` held "total ever" on rows the collector wrote
 * live and "gained that day" on rows the backfill wrote for past dates, so the
 * same column would mean two different things depending on when it happened to
 * be written, and any sum over a window would be wrong in a way no reader
 * could see. Every column in `VideoAnalytic` therefore comes from the
 * Analytics API, which reports all of them per day and can be asked about the
 * past; lifetime per video is the sum of its rows, exact once the backfill
 * reaches the publication date, which it is designed to do.
 *
 * `ChannelStatistic` is the opposite case and is why this function exists at
 * all: it is explicitly a "point-in-time snapshot" of lifetime totals, its own
 * schema comment says so, and no daily source for it exists.
 */
export async function fetchChannelStatistics({
  accessToken,
  fetchImpl = fetch,
}: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ChannelStatisticsSnapshot> {
  const url = new URL(CHANNELS_URL);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("mine", "true");

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw await describeFailure(response);
  }

  const body = (await response.json()) as {
    items?: Array<{
      statistics?: {
        subscriberCount?: string;
        viewCount?: string;
        videoCount?: string;
        hiddenSubscriberCount?: boolean;
      };
    }>;
  };

  const statistics = body.items?.[0]?.statistics;

  if (!statistics) {
    // A 200 with no items means the token authenticated but owns no channel —
    // a channel deleted or moved out from under a still-valid grant. Treated
    // as a permission failure because reconnecting is the only fix, and
    // because a zeroed snapshot would be recorded as real collapse to zero.
    throw new YouTubeDataApiError(
      "YouTube returned no channel for this connection. The channel may have been deleted or moved to another account — reconnect it.",
      response.status,
      true,
      false,
    );
  }

  return {
    subscriberCount: count(statistics.subscriberCount),
    viewCount: count(statistics.viewCount),
    videoCount: count(statistics.videoCount),
    subscriberCountHidden: statistics.hiddenSubscriberCount === true,
  };
}
