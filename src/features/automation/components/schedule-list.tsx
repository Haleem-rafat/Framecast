import Link from "next/link";
import { AlertTriangle, CalendarClock, ChevronRight, ListOrdered } from "lucide-react";

import { ScheduleControls } from "@/features/automation/components/schedule-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { ScheduleSummary } from "@/services/schedule.service";

/**
 * The list of schedules.
 *
 * Three facts per row, and they are the three an operator actually wants: is it
 * running, when does it next run, and what is it going to make. Everything else
 * — the prompt answers, the full queue, the history — is a click away on the
 * schedule's own page, because a list that shows everything shows nothing.
 *
 * A paused schedule states its reason inline rather than only on the detail
 * page. Most pauses are not the operator's own doing (an empty queue, three
 * failures in a row), and the whole point of surfacing them is that the
 * operator was *not* watching when it happened.
 */
export function ScheduleList({ schedules }: { schedules: ScheduleSummary[] }) {
  return (
    <div className="space-y-3">
      {schedules.map((schedule) => (
        <Card key={schedule.id}>
          <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/automation/schedules/${schedule.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {schedule.name}
                </Link>
                <Badge variant={schedule.status === "ACTIVE" ? "default" : "secondary"}>
                  {schedule.status === "ACTIVE" ? "Active" : "Paused"}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  {schedule.projectName}
                </span>
                {/* A series-owned cadence is edited, and deleted, on its
                    series — together with the script style and format it runs
                    with. It is still listed here, because "what is going to
                    run" is this page's question and hiding half the answer
                    would be worse than sending the operator one click away. */}
                {schedule.seriesId && (
                  <Link
                    href={`/automation/series/${schedule.seriesId}`}
                    className="text-muted-foreground text-xs underline-offset-4 hover:underline"
                  >
                    <Badge variant="outline">
                      Series: {schedule.seriesName}
                    </Badge>
                  </Link>
                )}
              </div>

              <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <CalendarClock className="size-3.5 shrink-0" />
                {schedule.cadence}
              </p>

              {/* The next run time is only meaningful while active. Showing one
                  on a paused schedule would advertise a video that is not
                  coming. */}
              {schedule.status === "ACTIVE" && schedule.nextRunAt && (
                <p className="text-sm">
                  Next{" "}
                  <span className="font-medium" suppressHydrationWarning>
                    {schedule.nextRunAt.toLocaleString()}
                  </span>
                  {schedule.nextTopic && (
                    <>
                      {" — "}
                      <span className="text-muted-foreground">
                        {schedule.nextTopic}
                      </span>
                    </>
                  )}
                </p>
              )}

              {schedule.status === "PAUSED" && schedule.pausedReason && (
                <p className="text-muted-foreground flex items-start gap-1.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {schedule.pausedReason}
                </p>
              )}

              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <ListOrdered className="size-3.5 shrink-0" />
                {schedule.queuedTopicCount === 0
                  ? "No topics left in the queue"
                  : `${schedule.queuedTopicCount} topic${
                      schedule.queuedTopicCount === 1 ? "" : "s"
                    } queued`}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <ScheduleControls
                scheduleId={schedule.id}
                scheduleName={schedule.name}
                status={schedule.status}
                compact
              />
              <Link
                href={`/automation/schedules/${schedule.id}`}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Open ${schedule.name}`}
              >
                <ChevronRight className="size-4" />
              </Link>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
