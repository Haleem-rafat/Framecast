import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScheduleControls } from "@/features/automation/components/schedule-controls";
import { ScheduleForm } from "@/features/automation/components/schedule-form";
import { ScheduleRunHistory } from "@/features/automation/components/schedule-run-history";
import { ScheduleTopicQueue } from "@/features/automation/components/schedule-topic-queue";
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
          <Link href="/automation/schedules">
            <ArrowLeft />
            All schedules
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
            <span className="text-foreground font-medium" suppressHydrationWarning>
              {schedule.nextRunAt.toLocaleString()}
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

      <ScheduleTopicQueue scheduleId={schedule.id} topics={schedule.topics} />

      <ScheduleRunHistory runs={schedule.runs} />

      {setup.prompt && setup.projects.length > 0 && (
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
