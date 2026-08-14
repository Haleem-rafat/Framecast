import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { ScheduleForm } from "@/features/automation/components/schedule-form";
import { requireUser } from "@/server/session";
import { automationService } from "@/services/automation.service";

export const metadata: Metadata = { title: "New schedule" };

/**
 * The timezone list, resolved once per process rather than per request.
 *
 * `Intl.supportedValuesOf` walks ICU's whole zone table — around 400 entries —
 * and the answer cannot change without restarting Node. Computing it on the
 * server rather than in the browser also means every operator sees the same
 * list regardless of their browser's ICU build, which matters because the
 * *worker* is the thing that has to resolve whatever they pick.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

export default async function NewSchedulePage() {
  const user = await requireUser();
  const setup = await automationService.getSetup(user.id);

  if (setup.blockers.length > 0 || !setup.prompt) {
    return (
      <>
        <PageHeader
          title="New schedule"
          description="A few things have to be in place before a schedule can run unattended."
        />
        <ReadinessNotice blockers={setup.blockers} />
      </>
    );
  }

  // `getSetup` already reports an operator with no usable project as a blocker,
  // so this is unreachable through the UI — it exists so the non-null narrowing
  // below is honest rather than asserted.
  if (setup.projects.length === 0) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title="New schedule"
        description="Pick a cadence and write the topics up front. Each run takes the next one down the list."
      />

      <ScheduleForm
        projects={setup.projects}
        prompt={setup.prompt}
        timeZones={TIME_ZONES}
      />
    </>
  );
}
