import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Clapperboard } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScheduleControls } from "@/features/automation/components/schedule-controls";
import { ScheduleForm } from "@/features/automation/components/schedule-form";
import { ScheduleRunHistory } from "@/features/automation/components/schedule-run-history";
import { ScheduleTopicQueue } from "@/features/automation/components/schedule-topic-queue";
import { describeNextRun } from "@/lib/automation-language";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/session";
import { automationService } from "@/services/automation.service";
import { scheduleService } from "@/services/schedule.service";

export const metadata: Metadata = { title: "Schedule" };

/** Same list, same reasoning, as the create page. */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

interface SchedulePageProps {
  params: Promise<{ id: string }>;
}

export default async function SchedulePage({ params }: SchedulePageProps) {
  const user = await requireUser();
  const { id } = await params;

  let schedule;

  try {
    schedule = await scheduleService.get(user.id, id);
  } catch (error) {
    // Scoped by `userId` inside the service, so a foreign or invented id is a
    // 404 here rather than a leak of whether the row exists.
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  }

  const setup = await automationService.getSetup(user.id);

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
          title={schedule.name}
          description={schedule.cadence}
          actions={
            <ScheduleControls
              scheduleId={schedule.id}
              scheduleName={schedule.name}
              status={schedule.status}
              runInFlight={schedule.runInFlight}
              deletable={schedule.seriesId === null}
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={schedule.status === "ACTIVE" ? "default" : "secondary"}>
          {schedule.status === "ACTIVE" ? "Active" : "Paused"}
        </Badge>
        {schedule.status === "ACTIVE" && schedule.nextRunAt && (
          <span className="text-muted-foreground text-sm">
            Next run{" "}
            {/* The same sentence the automation table uses, so clicking a row
                that said "Tomorrow at 6:00 AM" does not land on
                "17/08/2026, 06:00:00". Read in the schedule's own zone, which
                the cadence beside it names. */}
            <span className="text-foreground font-medium" suppressHydrationWarning>
              {describeNextRun(schedule.nextRunAt, schedule.timeZone, new Date())}
            </span>
          </span>
        )}
        {schedule.runInFlight && (
          <Badge variant="outline">A run is in progress right now</Badge>
        )}
      </div>

      {/* A schedule that stopped on its own has to say why, prominently: the
          operator was by definition not watching when it happened. */}
      {schedule.status === "PAUSED" && schedule.pausedReason && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>This schedule is paused</AlertTitle>
          <AlertDescription>{schedule.pausedReason}</AlertDescription>
        </Alert>
      )}

      {/* A series-owned cadence is edited on its series, where the script style
          and the format it runs with are edited too. `ScheduleService.update`
          refuses it outright — the answers stored here are reconciled against
          the *series'* script style, and this form has no idea which that is —
          so offering the form and then failing the save would be the worst of
          both. Everything else on this page is read-only or safe: the queue and
          pause/resume mean the same thing whoever presses them. */}
      {schedule.seriesId && (
        <Alert>
          <Clapperboard />
          <AlertTitle>Part of the “{schedule.seriesName}” series</AlertTitle>
          <AlertDescription>
            <span>
              This cadence belongs to a series, so it is edited there — together
              with the script style, the format and the channel every episode
              inherits.
            </span>
            <Button asChild variant="outline" size="sm" className="mt-1">
              <Link href={`/automation/series/${schedule.seriesId}`}>
                Open the series
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <ScheduleTopicQueue scheduleId={schedule.id} topics={schedule.topics} />

      <ScheduleRunHistory runs={schedule.runs} />

      {!schedule.seriesId && setup.prompt && setup.projects.length > 0 && (
        <ScheduleForm
          projects={setup.projects}
          prompt={setup.prompt}
          timeZones={TIME_ZONES}
          schedule={schedule}
        />
      )}
    </>
  );
}
