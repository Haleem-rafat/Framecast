import Link from "next/link";
import { AlertTriangle, Clock, Radio } from "lucide-react";

import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { BarList } from "@/features/analytics/components/bar-list";
import type {
  ChannelPerformance as ChannelPerformanceRow,
  CollectionHealth,
} from "@/services/channel-analytics.service";
import {
  formatCompactNumber,
  formatCurrency,
  formatDuration,
} from "@/utils/format";

/**
 * Real YouTube performance, one card per connected channel.
 *
 * ## The rule this component is built around
 *
 * Every figure here was captured at a moment in the past, by a collector that
 * can fail, against an API that does not report the last two days at all. So
 * no number appears without the reader being able to see how old it is, and a
 * channel with nothing collected shows *why* rather than a chart of zeros.
 *
 * That is not decoration. An empty chart and a chart of genuine zeros look
 * identical, and the difference between them is "we have not asked YouTube
 * yet" versus "nobody watched your videos" — which is the single most
 * misleading thing an analytics page can get wrong.
 */

const HEALTH_LABELS: Record<CollectionHealth, string> = {
  never: "Not collected yet",
  backfilling: "Backfilling history",
  ok: "Up to date",
  failing: "Collection failing",
};

const HEALTH_VARIANTS: Record<
  CollectionHealth,
  "default" | "secondary" | "outline" | "destructive"
> = {
  never: "outline",
  backfilling: "secondary",
  ok: "secondary",
  failing: "destructive",
};

interface ChannelPerformanceProps {
  channels: ChannelPerformanceRow[];
  windowDays: number;
}

export function ChannelPerformance({
  channels,
  windowDays,
}: ChannelPerformanceProps) {
  if (channels.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Channel performance</CardTitle>
          <CardDescription>
            Subscribers, views and watch time pulled from YouTube.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground py-6 text-center text-sm text-balance">
            No channels are connected, so there is nothing to pull.{" "}
            {/* Named the page and made the operator go and find it. It is one
                link; the whole point of an empty state is that the next step is
                in it. */}
            <Link href="/channels" className="text-foreground underline underline-offset-4">
              Connect one
            </Link>{" "}
            and collection starts on its own.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {channels.map((channel) => (
        <ChannelCard key={channel.channelId} channel={channel} windowDays={windowDays} />
      ))}
    </div>
  );
}

function ChannelCard({
  channel,
  windowDays,
}: {
  channel: ChannelPerformanceRow;
  windowDays: number;
}) {
  const { window: totals, lifetime } = channel;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate">{channel.title}</CardTitle>
            <CardDescription>
              {channel.trackedVideos === 0
                ? "No published videos to track yet"
                : `${channel.trackedVideos} published ${channel.trackedVideos === 1 ? "video" : "videos"} tracked`}
            </CardDescription>
          </div>
          <Badge variant={HEALTH_VARIANTS[channel.health]} className="shrink-0">
            {HEALTH_LABELS[channel.health]}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The failure notice comes first and is never collapsed into the
          * badge alone. A channel whose OAuth grant has died fails silently
          * everywhere else in this app until somebody tries to publish; this
          * is where it becomes visible, so the sentence has to be readable
          * rather than hinted at. */}
        {channel.lastError && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive flex gap-2 rounded-md border p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="text-balance">{channel.lastError}</p>
              {channel.nextCollectionAt && (
                <p className="text-destructive/80 text-xs">
                  Next attempt <RelativeTime date={channel.nextCollectionAt} />.
                </p>
              )}
            </div>
          </div>
        )}

        {lifetime ? (
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Figure
              label="Subscribers"
              value={formatCompactNumber(lifetime.subscriberCount)}
              change={channel.subscriberChange}
            />
            <Figure
              label="Lifetime views"
              value={formatCompactNumber(lifetime.viewCount)}
              change={channel.viewChange}
            />
            <Figure
              label="Videos"
              value={formatCompactNumber(lifetime.videoCount)}
              change={null}
            />
          </dl>
        ) : (
          <NotCollectedYet channel={channel} />
        )}

        {totals && (
          <>
            <Separator />

            <div className="space-y-3">
              <p className="text-muted-foreground text-xs">
                Last {windowDays} days, from YouTube Analytics
              </p>

              <BarList
                items={[
                  {
                    label: "Views",
                    value: totals.views,
                    display: formatCompactNumber(totals.views),
                  },
                  {
                    label: "Watch time",
                    value: totals.watchTimeMinutes,
                    display: `${formatCompactNumber(Math.round(totals.watchTimeMinutes))} min`,
                  },
                  {
                    label: "Likes",
                    value: totals.likes,
                    display: formatCompactNumber(totals.likes),
                  },
                  {
                    label: "Comments",
                    value: totals.comments,
                    display: formatCompactNumber(totals.comments),
                  },
                ]}
              />

              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Figure
                  label="Avg. view time"
                  value={formatDuration(Math.round(totals.averageViewSeconds))}
                  change={null}
                />
                <Figure
                  label="Subs gained"
                  value={
                    (totals.subscribersGained >= 0 ? "+" : "") +
                    formatCompactNumber(totals.subscribersGained)
                  }
                  change={null}
                />
                {/* Rendered only when the Analytics API actually answered the
                  * monetary query for this channel. An unmonetised channel
                  * gets no cell at all rather than "$0.00", which would be a
                  * statement about the operator's income that nothing here
                  * measured. See ChannelCollection.revenueAvailable. */}
                {totals.estimatedRevenue !== null && (
                  <Figure
                    label="Est. revenue"
                    value={formatCurrency(totals.estimatedRevenue)}
                    change={null}
                  />
                )}
              </dl>
            </div>

            {channel.topVideos.length > 0 && (
              <>
                <Separator />
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    Most watched in the window
                  </p>
                  <BarList
                    items={channel.topVideos.map((video) => ({
                      label: video.title,
                      value: video.views,
                      display: `${formatCompactNumber(video.views)} views`,
                    }))}
                  />
                </div>
              </>
            )}
          </>
        )}

        <Freshness channel={channel} />
      </CardContent>
    </Card>
  );
}

/**
 * What a connected-but-never-collected channel shows.
 *
 * The honest answer, in place of the numbers: nothing has been asked for yet,
 * and here is when it will be. Deliberately not a chart with a zero baseline,
 * and deliberately not "0 subscribers" — both would read as a measurement.
 */
function NotCollectedYet({ channel }: { channel: ChannelPerformanceRow }) {
  return (
    <div className="bg-muted/40 space-y-2 rounded-md p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Radio className="size-4 shrink-0" aria-hidden />
        No figures pulled from YouTube yet
      </div>
      <p className="text-muted-foreground text-sm text-balance">
        {channel.lastError
          ? "The last attempt failed, so nothing has been recorded for this channel."
          : channel.nextCollectionAt
            ? "This channel is connected and queued. Nothing is shown until YouTube has actually been asked."
            : "This channel is connected. Collection starts the next time the worker is idle."}
      </p>
      {channel.nextCollectionAt && !channel.lastError && (
        <p className="text-muted-foreground text-xs">
          First collection <RelativeTime date={channel.nextCollectionAt} />.
        </p>
      )}
    </div>
  );
}

/**
 * The line that stops this card from lying about how current it is.
 *
 * Two different timestamps, because they answer two different questions and a
 * dashboard that conflates them is exactly the "looks live, is three days old"
 * failure worth avoiding:
 *
 *   * `capturedAt` — when this app last successfully talked to YouTube.
 *   * `dataThrough` — the most recent day the *figures* actually cover, which
 *     trails capture by about two days no matter how often collection runs,
 *     because the Analytics API does not report sooner than that.
 */
function Freshness({ channel }: { channel: ChannelPerformanceRow }) {
  if (!channel.lastCollectedAt) {
    return null;
  }

  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Clock className="size-3 shrink-0" aria-hidden />
      Captured <RelativeTime date={channel.lastCollectedAt} />
      {channel.dataThrough && (
        <>
          {" · figures run through "}
          <time dateTime={channel.dataThrough.toISOString()}>
            {channel.dataThrough.toISOString().slice(0, 10)}
          </time>
        </>
      )}
      {channel.health === "backfilling" && " · still filling in older days"}
    </p>
  );
}

function Figure({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  /** Null renders nothing at all — see `subscriberChange` on why a single
   *  snapshot must not render as "+0". */
  change: number | null;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-mono text-lg">
        {value}
        {change !== null && change !== 0 && (
          <span
            className={
              change > 0
                ? "ml-1.5 align-middle font-sans text-xs text-emerald-600 dark:text-emerald-500"
                : "text-destructive ml-1.5 align-middle font-sans text-xs"
            }
          >
            {change > 0 ? "+" : "−"}
            {formatCompactNumber(Math.abs(change))}
          </span>
        )}
      </dd>
    </div>
  );
}
