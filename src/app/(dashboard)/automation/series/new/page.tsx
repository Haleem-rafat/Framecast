import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { SeriesWizard } from "@/features/automation/components/wizard/series-wizard";
import { requireUser } from "@/server/session";
import { brandService } from "@/services/brand.service";
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

  // Every channel's brand, read up front: the wizard's voice, music, look and
  // caption steps start from the chosen channel's current answers and write
  // back through the branding screen's own action, which needs the fields
  // they do not touch as well. An operator has a handful of channels, so one
  // read each is cheaper than a round trip every time the channel changes.
  const brandings = Object.fromEntries(
    await Promise.all(
      setup.channels.map(
        async (channel) =>
          [channel.id, await brandService.getBranding(user.id, channel.id)] as const,
      ),
    ),
  );

  return (
    // The header sits in the wizard's own column, so the title and the step
    // under it share a left edge instead of the step floating off-centre.
    <div className="mx-auto w-full max-w-[700px] space-y-6">
      <PageHeader
        title="New series"
        description="A recurring show, answered once. Every episode is written, voiced and scheduled the way you set it up here — and the topics come from your list, never from a model guessing."
      />

      <SeriesWizard setup={setup} brandings={brandings} timeZones={TIME_ZONES} />
    </div>
  );
}
