import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReleaseCadenceControls } from "@/features/automation/components/release-cadence-controls";
import { ReleaseCadenceForm } from "@/features/automation/components/release-cadence-form";
import { ReleaseQueue } from "@/features/automation/components/release-queue";
import { ReleaseRunHistory } from "@/features/automation/components/release-run-history";
import { NotFoundError } from "@/lib/errors";
import { requireUser } from "@/server/session";
import { releaseService } from "@/services/release.service";

export const metadata: Metadata = { title: "Shorts drip" };

/** Same list, same reasoning, as the create page. */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

interface ReleaseCadencePageProps {
  params: Promise<{ id: string }>;
}

export default async function ReleaseCadencePage({ params }: ReleaseCadencePageProps) {
  const user = await requireUser();
  const { id } = await params;

  let cadence;

  try {
    cadence = await releaseService.get(user.id, id);
  } catch (error) {
    // Scoped by `userId` inside the service, so a foreign or invented id is a
    // 404 here rather than a leak of whether the row exists.
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  }

  return (
    <>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/automation/releases">
            <ArrowLeft />
            All drips
          </Link>
        </Button>

        <PageHeader
          title={cadence.channelTitle}
          description={cadence.cadence}
          actions={
            <ReleaseCadenceControls
              cadenceId={cadence.id}
              channelTitle={cadence.channelTitle}
              status={cadence.status}
              releaseInFlight={cadence.releaseInFlight}
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={cadence.status === "ACTIVE" ? "default" : "secondary"}>
          {cadence.status === "ACTIVE" ? "Active" : "Paused"}
        </Badge>
        <Badge variant="outline">{cadence.visibility.toLowerCase()}</Badge>
        {cadence.status === "ACTIVE" && cadence.nextReleaseAt && (
          <span className="text-muted-foreground text-sm">
            Next release{" "}
            <span className="text-foreground font-medium" suppressHydrationWarning>
              {cadence.nextReleaseAt.toLocaleString()}
            </span>
          </span>
        )}
        {cadence.releaseInFlight && (
          <Badge variant="outline">An upload is in progress right now</Badge>
        )}
      </div>

      {/* A cadence that stopped on its own has to say why, prominently: the
          operator was by definition not watching when it happened. The case
          this is built for is a spent YouTube quota, which is shared across
          every channel and so looks like a fault with this one. */}
      {cadence.status === "PAUSED" && cadence.pausedReason && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>This drip is paused</AlertTitle>
          <AlertDescription>{cadence.pausedReason}</AlertDescription>
        </Alert>
      )}

      <ReleaseQueue
        entries={cadence.queue}
        bankedCount={cadence.bankedCount}
        daysOfCover={cadence.daysOfCover}
        slotsPerDay={cadence.slotMinutes.length}
      />

      <ReleaseRunHistory runs={cadence.runs} />

      <ReleaseCadenceForm channels={[]} timeZones={TIME_ZONES} cadence={cadence} />
    </>
  );
}
