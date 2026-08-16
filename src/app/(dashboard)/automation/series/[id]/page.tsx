import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScheduleRunHistory } from "@/features/automation/components/schedule-run-history";
import { ScheduleTopicQueue } from "@/features/automation/components/schedule-topic-queue";
import { SeriesControls } from "@/features/automation/components/series-controls";
import { SeriesForm } from "@/features/automation/components/series-form";
import { SeriesRecipe } from "@/features/automation/components/series-recipe";
import { SeriesVideos } from "@/features/automation/components/series-videos";
import { describeNextRun } from "@/lib/automation-language";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/session";
import { seriesService } from "@/services/series.service";

export const metadata: Metadata = { title: "Series" };

/** Same list, same reasoning, as the create page. */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

interface SeriesDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * One show.
 *
 * The topic queue and the run history are the schedule's own components, passed
 * the schedule id this series owns — not copies. The queue is a real
 * `ScheduleTopic` list managed by the real schedule actions, and the history is
 * a real `ScheduleRun` list written by the real due-check, so reusing them is
 * not a saving in code so much as a guarantee that the series page cannot drift
 * from what the worker actually does.
 */
export default async function SeriesDetailPage({ params }: SeriesDetailPageProps) {
  const user = await requireUser();
  const { id } = await params;

  let series;

  try {
    series = await seriesService.get(user.id, id);
  } catch (error) {
    // Scoped by `userId` inside the service, so a foreign or invented id is a
    // 404 here rather than a leak of whether the row exists.
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  }

  const setup = await seriesService.getSetup(user.id);

  return (
    <>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/automation">
            <ArrowLeft />
            All automations
          </Link>
        </Button>

        <PageHeader
          title={series.name}
          description={`${series.cadence} · ${series.channelTitle}`}
          actions={
            <SeriesControls
              seriesId={series.id}
              seriesName={series.name}
              status={series.status}
              queuedTopicCount={series.queuedTopicCount}
              runInFlight={series.runInFlight}
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={series.status === "ACTIVE" ? "default" : "secondary"}>
          {series.status === "ACTIVE" ? "Active" : "Paused"}
        </Badge>
        {series.status === "ACTIVE" && series.nextRunAt && (
          <span className="text-muted-foreground text-sm">
            Next episode{" "}
            {/* The same sentence the automation table uses, so clicking a row
                that said "Tomorrow at 6:00 AM" does not land on
                "17/08/2026, 06:00:00". Read in the show's own zone, which the
                cadence beside it names. */}
            <span className="text-foreground font-medium" suppressHydrationWarning>
              {describeNextRun(series.nextRunAt, series.timeZone, new Date())}
            </span>
          </span>
        )}
        {series.runInFlight && (
          <Badge variant="outline">An episode is being made right now</Badge>
        )}
      </div>

      {/* The one state on this page where everything else it says is a lie.
          Every screen — this header, the recipe card, the automation table —
          reads this show's own `channelId`, while an upload goes to the
          project's. When they disagree, a publish would put this show's
          episodes on a channel nobody was ever shown, permanently.

          Stated rather than corrected, and stated here rather than fixed
          quietly somewhere: nothing can tell which of the two the operator
          meant, and both possible guesses (re-brand the show, or redirect the
          episodes already filed under it) are the operator's call. Publishing
          refuses outright until they make it — see
          `PublishService.resolvePublishTarget`. */}
      {series.channelMismatch && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>
            This series and its project disagree about the channel
          </AlertTitle>
          <AlertDescription>
            This show says {series.channelMismatch.seriesChannelTitle}, and the
            project &ldquo;{series.projectName}&rdquo; it files episodes in says{" "}
            {series.channelMismatch.projectChannelTitle ?? "no channel at all"}.
            Everything on this page describes the first; a publish would have
            used the second, and an upload to the wrong channel cannot be undone.
            Publishing an episode is refused until the two agree.{" "}
            <Link href="/projects" className="underline underline-offset-3">
              Point the project at{" "}
              {series.channelMismatch.seriesChannelTitle}
            </Link>{" "}
            if this show is right, or edit the series below if it is not.
          </AlertDescription>
        </Alert>
      )}

      {/* A show that stopped on its own has to say why, prominently: the
          operator was by definition not watching when it happened. */}
      {series.status === "PAUSED" && series.pausedReason && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>This series is paused</AlertTitle>
          <AlertDescription>{series.pausedReason}</AlertDescription>
        </Alert>
      )}

      <SeriesRecipe series={series} />

      {/* The schedule's own queue component, driven by the schedule's own
          actions, on the schedule this series owns. */}
      <ScheduleTopicQueue scheduleId={series.scheduleId} topics={series.topics} />

      <SeriesVideos videos={series.videos} format={series.format} />

      <ScheduleRunHistory runs={series.runs} />

      <SeriesForm setup={setup} timeZones={TIME_ZONES} series={series} />
    </>
  );
}
