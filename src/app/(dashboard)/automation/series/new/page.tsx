import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { SeriesForm } from "@/features/automation/components/series-form";
import { requireUser } from "@/server/session";
import { seriesService } from "@/services/series.service";

export const metadata: Metadata = { title: "New series" };

/**
 * The timezone list, resolved once per process rather than per request — same
 * list and same reasoning as the schedule pages, which is also why it is
 * resolved on the server: the *worker* is what has to resolve whatever the
 * operator picks.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

export default async function NewSeriesPage() {
  const user = await requireUser();
  const setup = await seriesService.getSetup(user.id);

  if (setup.blockers.length > 0) {
    return (
      <>
        <PageHeader
          title="New series"
          description="A few things have to be in place before a show can run unattended."
        />
        <ReadinessNotice blockers={setup.blockers} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New series"
        description="Answer this once. Every episode is written in the style you pick, in the shape you pick, on the channel you pick — and the topics come from the list you write below, never from a model guessing."
      />

      <SeriesForm setup={setup} timeZones={TIME_ZONES} />
    </>
  );
}
