import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { ScheduleList } from "@/features/automation/components/schedule-list";
import { requireUser } from "@/server/session";
import { automationService } from "@/services/automation.service";
import { scheduleService } from "@/services/schedule.service";

export const metadata: Metadata = { title: "Schedules" };

/**
 * Recurring automation: the one-click flow, on a timer.
 *
 * Gated on the same readiness check the one-click flow itself is gated on, and
 * for a sharper reason. A schedule set up on an account with no ElevenLabs key
 * does not fail now — it fails at 09:00 next Monday, in a worker, with nobody
 * watching, and again the Monday after that. Refusing here means the failure
 * happens while the operator is looking at the screen that caused it.
 */
export default async function SchedulesPage() {
  const user = await requireUser();

  const [setup, schedules] = await Promise.all([
    automationService.getSetup(user.id),
    scheduleService.list(user.id),
  ]);

  const ready = setup.blockers.length === 0 && setup.prompt !== null;

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Set a cadence once — every Monday, or the first of the month — and Framecast produces a video from the next topic in the queue. Publishing stays yours."
        actions={
          ready && schedules.length > 0 ? (
            <Button asChild>
              <Link href="/automation/schedules/new">
                <Plus />
                New schedule
              </Link>
            </Button>
          ) : undefined
        }
      />

      {!ready ? (
        <ReadinessNotice blockers={setup.blockers} />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="A schedule runs the one-click flow on its own — weekly or monthly — taking each video's topic from a list you write in advance. It stops when the list runs out rather than inventing one."
          action={
            <Button asChild>
              <Link href="/automation/schedules/new">
                <Plus />
                New schedule
              </Link>
            </Button>
          }
        />
      ) : (
        <ScheduleList schedules={schedules} />
      )}
    </>
  );
}
