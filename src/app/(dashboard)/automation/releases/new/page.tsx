import type { Metadata } from "next";
import Link from "next/link";
import { Timer } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ReleaseCadenceForm } from "@/features/automation/components/release-cadence-form";
import { requireUser } from "@/server/session";
import { channelService } from "@/services/channel.service";
import { releaseService } from "@/services/release.service";

export const metadata: Metadata = { title: "New shorts drip" };

/**
 * The timezone list, resolved once per process rather than per request.
 *
 * Same reasoning as the schedules form's: `Intl.supportedValuesOf` walks ICU's
 * whole zone table, the answer cannot change without restarting Node, and
 * computing it on the server means every operator sees the same list regardless
 * of their browser's ICU build — which matters because the *worker* is the
 * thing that has to resolve whatever they pick.
 */
const TIME_ZONES = Intl.supportedValuesOf("timeZone");

export default async function NewReleaseCadencePage() {
  const user = await requireUser();

  const [channels, cadences] = await Promise.all([
    channelService.list(user.id),
    releaseService.list(user.id),
  ]);

  // A channel has at most one cadence (see `ReleaseCadence.channelId`), so the
  // ones that already have theirs are not offered. Filtering here rather than
  // letting the operator pick one and be refused on save: the refusal would be
  // correct and still be the worse experience.
  const taken = new Set(cadences.map((cadence) => cadence.channelId));
  const available = channels.filter((channel) => !taken.has(channel.id));

  if (available.length === 0) {
    return (
      <>
        <PageHeader
          title="New shorts drip"
          description="Every connected channel already has one."
        />
        <EmptyState
          icon={Timer}
          title={
            channels.length === 0
              ? "No channels connected"
              : "Every channel already has a drip"
          }
          description={
            channels.length === 0
              ? "A drip publishes to a YouTube channel, so it needs one connected first."
              : "Each channel releases on its own times, and has one cadence to set them. Open the one you want to change rather than adding a second — two cadences on one channel would race for the same queue of clips."
          }
          action={
            <Button asChild>
              <Link href={channels.length === 0 ? "/channels" : "/automation/releases"}>
                {channels.length === 0 ? "Connect a channel" : "Back to the drip"}
              </Link>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New shorts drip"
        description="Pick the times of day this channel posts, and its banked shorts go out one per slot — oldest video first, in play order."
      />

      <ReleaseCadenceForm channels={available} timeZones={TIME_ZONES} />
    </>
  );
}
