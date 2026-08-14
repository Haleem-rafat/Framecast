import type { Metadata } from "next";
import { CalendarClock, CircleAlert, Clapperboard, Upload } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { StatCard } from "@/components/shared/stat-card";
import { PublicationTable } from "@/features/studio/components/publication-table";
import { ReadyToPublishList } from "@/features/studio/components/ready-to-publish-list";
import { requireUser } from "@/server/session";
import { publishingService } from "@/services/publishing.service";

export const metadata: Metadata = { title: "Publishing" };

export default async function PublishingPage() {
  const user = await requireUser();
  const { publications, readyToPublish } = await publishingService.getOverview(
    user.id,
  );

  // Counted here rather than in the service: the rows are already in hand and
  // small enough that a second set of grouped queries would cost more round
  // trips than the arithmetic saves.
  const published = publications.filter(
    (entry) => entry.status === "PUBLISHED",
  ).length;
  const scheduled = publications.filter(
    (entry) => entry.status === "SCHEDULED",
  ).length;
  const failed = publications.filter((entry) => entry.status === "FAILED").length;

  return (
    <>
      <PageHeader
        title="Publishing"
        description="What has gone to YouTube, what is scheduled, what failed, and what is waiting."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Published"
          value={String(published)}
          icon={Upload}
          hint="Live on a connected channel"
        />
        <StatCard
          label="Scheduled"
          value={String(scheduled)}
          icon={CalendarClock}
          hint="Uploaded, waiting on YouTube's clock"
        />
        <StatCard
          label="Failed"
          value={String(failed)}
          icon={CircleAlert}
          tone={failed > 0 ? "danger" : "default"}
          hint="Blocks a retry until the row is cleared"
        />
        <StatCard
          label="Ready to publish"
          value={String(readyToPublish.length)}
          icon={Clapperboard}
          hint="Rendered, with nothing claiming them yet"
        />
      </div>

      <Reveal className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Ready to publish
        </h2>
        <ReadyToPublishList videos={readyToPublish} />
      </Reveal>

      <Reveal className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Publications</h2>
        <PublicationTable publications={publications} />
      </Reveal>

      <p className="text-muted-foreground text-xs text-balance">
        A failed publish is not retried automatically and cannot be retried
        from here: the row it leaves behind is what stops an upload firing
        again on its own, and clearing it is a deliberate manual step. Nothing
        in Framecast can unpublish or change a video&apos;s visibility once
        YouTube has it — that is YouTube Studio&apos;s job.
      </p>
    </>
  );
}
