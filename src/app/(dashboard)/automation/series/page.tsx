import type { Metadata } from "next";
import Link from "next/link";
import { Clapperboard, Plus } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ReadinessNotice } from "@/features/automation/components/readiness-notice";
import { SeriesList } from "@/features/automation/components/series-list";
import { requireUser } from "@/server/session";
import { seriesService } from "@/services/series.service";

export const metadata: Metadata = { title: "Series" };

/**
 * Every recurring show, in one place.
 *
 * Gated on the same readiness check the guided flow and the schedules page are
 * gated on, plus the two conditions a series has that they do not — a project
 * that actually publishes to a channel, and at least one script style to point
 * at. Refusing here means the failure happens while the operator is looking at
 * the screen that caused it, rather than at 09:00 next Monday in a worker.
 */
export default async function SeriesPage() {
  const user = await requireUser();

  const [setup, series] = await Promise.all([
    seriesService.getSetup(user.id),
    seriesService.list(user.id),
  ]);

  const ready = setup.blockers.length === 0;

  return (
    <>
      <PageHeader
        title="Series"
        description="A named show: one channel, one script style, one format, one cadence, one topic queue. Set it up once and every episode inherits all of it. Publishing stays yours."
        actions={
          ready && series.length > 0 ? (
            <Button asChild>
              <Link href="/automation/series/new">
                <Plus />
                New series
              </Link>
            </Button>
          ) : undefined
        }
      />

      {!ready ? (
        <ReadinessNotice blockers={setup.blockers} />
      ) : series.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="No series yet"
          description="Everything a recurring show needs already exists — the channel's brand, a script style, a format, a cadence, a topic queue — but scattered over five screens. A series is the name that bundles them, so a second show is one form rather than five places to remember."
          action={
            <Button asChild>
              <Link href="/automation/series/new">
                <Plus />
                New series
              </Link>
            </Button>
          }
        />
      ) : (
        <SeriesList series={series} />
      )}
    </>
  );
}
