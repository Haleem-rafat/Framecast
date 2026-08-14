import type { Metadata } from "next";
import { CircleAlert, Clapperboard, Timer, Wallet, Zap } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { BarList } from "@/features/analytics/components/bar-list";
import { DailyCostChart } from "@/features/analytics/components/daily-cost-chart";
import { OperationReliability } from "@/features/analytics/components/operation-reliability";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import type { PublishStatus, VideoStatus } from "@/generated/prisma/enums";
import { analyticsService } from "@/services/analytics.service";
import { requireUser } from "@/server/session";
import { formatCurrency, formatElapsed, formatPercent } from "@/utils/format";

export const metadata: Metadata = { title: "Analytics" };

const VIDEO_STATUS_LABELS: Record<VideoStatus, string> = {
  DRAFT: "Draft",
  QUEUED: "Queued",
  GENERATING: "Generating",
  RENDERING: "Rendering",
  READY: "Ready",
  PUBLISHED: "Published",
  FAILED: "Failed",
};

const PUBLISH_STATUS_LABELS: Record<PublishStatus, string> = {
  PENDING: "Pending",
  SCHEDULED: "Scheduled",
  UPLOADING: "Uploading",
  PUBLISHED: "Published",
  FAILED: "Failed",
};

/** `formatElapsed` takes milliseconds; the service reports seconds. */
function seconds(value: number | null): string {
  return value === null ? "—" : formatElapsed(value * 1000);
}

export default async function AnalyticsPage() {
  const user = await requireUser();
  const overview = await analyticsService.getOverview(user.id);
  const { render, publish, usage, windowDays } = overview;

  const renderAttempts = render.succeeded + render.failed + render.cancelled;
  // Cancellations are an operator's decision, not a reliability event, so they
  // are excluded from the denominator rather than counted as failures.
  const renderCompleted = render.succeeded + render.failed;
  const renderSuccessRate =
    renderCompleted > 0 ? render.succeeded / renderCompleted : null;

  const usageFailureRate =
    usage.totalRequests > 0 ? usage.totalFailures / usage.totalRequests : null;

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Production throughput, render reliability and provider cost over the last ${windowDays} days.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={`Videos started (${windowDays}d)`}
          value={String(overview.videosCreatedInWindow)}
          icon={Clapperboard}
          hint="New videos created in the window"
        />
        <StatCard
          label="Render success rate"
          value={
            renderSuccessRate === null ? "—" : formatPercent(renderSuccessRate)
          }
          icon={CircleAlert}
          tone={
            renderSuccessRate !== null && renderSuccessRate < 0.9
              ? "danger"
              : "default"
          }
          hint={
            renderCompleted === 0
              ? "No renders finished in the window"
              : `${render.succeeded} of ${renderCompleted} finished renders succeeded`
          }
        />
        <StatCard
          label="Median render time"
          value={seconds(render.medianSeconds)}
          icon={Timer}
          hint={
            render.timedCount === 0
              ? "No timed renders in the window"
              : `Across ${render.timedCount} timed ${render.timedCount === 1 ? "render" : "renders"}`
          }
        />
        <StatCard
          label={`Provider spend (${windowDays}d)`}
          value={formatCurrency(usage.totalCostUsd)}
          icon={Wallet}
          hint="Deployment-wide — not scoped per operator"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Videos by status</CardTitle>
            <CardDescription>
              Everything you own right now, not just the last {windowDays} days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {overview.videosByStatus.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No videos yet.
              </p>
            ) : (
              <BarList
                items={overview.videosByStatus.map((row) => ({
                  label: VIDEO_STATUS_LABELS[row.status],
                  value: row.count,
                  display: String(row.count),
                }))}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Render timings</CardTitle>
            <CardDescription>
              Measured from a job&apos;s start to its finish, successful renders
              only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {render.timedCount === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm text-balance">
                No render in the last {windowDays} days recorded both a start
                and a finish, so there is nothing to time.
              </p>
            ) : (
              // Three columns of "90th percentile" over a monospace duration
              // need about 110px each; a 375px screen has 343px of content box
              // minus the card's padding, so they stack there instead.
              <dl className="grid gap-3 text-sm sm:grid-cols-3 sm:gap-4">
                <div className="space-y-1">
                  <dt className="text-muted-foreground text-xs">Median</dt>
                  <dd className="font-mono text-lg">
                    {seconds(render.medianSeconds)}
                  </dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-muted-foreground text-xs">
                    90th percentile
                  </dt>
                  <dd className="font-mono text-lg">
                    {seconds(render.p90Seconds)}
                  </dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-muted-foreground text-xs">Longest</dt>
                  <dd className="font-mono text-lg">
                    {seconds(render.longestSeconds)}
                  </dd>
                </div>
              </dl>
            )}

            <Separator />

            <div className="text-muted-foreground space-y-1 text-sm">
              <p>
                {renderAttempts} render {renderAttempts === 1 ? "job" : "jobs"}{" "}
                in the window — {render.succeeded} succeeded, {render.failed}{" "}
                failed, {render.cancelled} cancelled.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Publishing</CardTitle>
          <CardDescription>
            Every publication attached to your videos, at its current status.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {publish.byStatus.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              Nothing has been sent to YouTube yet.
            </p>
          ) : (
            <>
              <BarList
                items={publish.byStatus.map((row) => ({
                  label: PUBLISH_STATUS_LABELS[row.status],
                  value: row.count,
                  display: String(row.count),
                }))}
              />
              {publish.published > 0 && (
                <p className="text-muted-foreground text-sm">
                  Custom thumbnail attached on {publish.thumbnailApplied} of{" "}
                  {publish.published} published{" "}
                  {publish.published === 1 ? "video" : "videos"}
                  {publish.thumbnailApplied < publish.published &&
                    " — YouTube only accepts custom thumbnails from verified channels."}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Provider usage</h2>
        <p className="text-muted-foreground text-sm text-balance">
          {/* Not an oversight worth hiding: ProviderUsage carries neither a
            * userId nor a populated credentialId, so these figures cannot be
            * attributed to an operator. Saying so is better than presenting
            * deployment-wide numbers as if they were yours. */}
          These figures cover the whole deployment. Provider usage is recorded
          without an owner, so unlike everything above it cannot be broken down
          per operator. Only aggregates are shown.
        </p>
      </div>

      {/* Spend is already the fourth stat card at the top of the page; showing
        * the same figure again here would just invite the reader to check
        * whether the two agree. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Provider calls"
          value={String(usage.totalRequests)}
          icon={Zap}
          hint={`Last ${windowDays} days`}
        />
        <StatCard
          label="Failed calls"
          value={
            usageFailureRate === null
              ? "—"
              : `${usage.totalFailures} (${formatPercent(usageFailureRate)})`
          }
          icon={CircleAlert}
          tone={usage.totalFailures > 0 ? "danger" : "default"}
          hint="Calls the pipeline recorded as unsuccessful"
        />
      </div>

      <DailyCostChart
        points={usage.daily}
        truncated={usage.dailyTruncated}
        windowDays={windowDays}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By provider</CardTitle>
            <CardDescription>
              Spend over the last {windowDays} days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usage.byProvider.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No provider calls recorded in this window.
              </p>
            ) : (
              <BarList
                items={usage.byProvider.map((row) => ({
                  label: PROVIDER_LABELS[row.provider],
                  value: row.costUsd,
                  display: `${formatCurrency(row.costUsd)} · ${row.requests} ${row.requests === 1 ? "call" : "calls"}`,
                }))}
              />
            )}
          </CardContent>
        </Card>

        <OperationReliability rows={usage.byOperation} />
      </div>

      <p className="text-muted-foreground text-xs text-balance">
        A cost of zero means the model has no entry in the pricing table
        (lib/cost.ts) rather than that the call was free — narration in
        particular is recorded without a price, so spend here is effectively
        script generation only. Token counts are deliberately not charted: the
        same column holds output tokens for text models and character counts
        for speech, and summing the two would produce a number that means
        nothing.
      </p>
    </>
  );
}
