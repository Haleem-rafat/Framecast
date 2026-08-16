import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Timer } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ReleaseCadenceList } from "@/features/automation/components/release-cadence-list";
import { requireUser } from "@/server/session";
import { channelService } from "@/services/channel.service";
import { releaseService } from "@/services/release.service";

export const metadata: Metadata = { title: "Shorts drip" };

/**
 * The shorts drip: banked clips, released on a timer, one cadence per channel.
 *
 * Deliberately *not* gated on the readiness check the schedules page uses.
 * That check exists because a schedule spends provider money — a run with no
 * ElevenLabs key is billed for a script and then dies at narration. A drip
 * spends nothing: it uploads a file that already exists, and the only thing it
 * needs is a connected channel. Requiring an Anthropic key to release a clip
 * that was cut last week would be a gate on something this page never touches.
 */
export default async function ReleasesPage() {
  const user = await requireUser();

  const [cadences, channels] = await Promise.all([
    releaseService.list(user.id),
    channelService.list(user.id),
  ]);

  // Every channel already has one, so there is nothing to add. Offering the
  // button anyway would send the operator to a form whose channel select is
  // empty — `ReleaseService.create` refuses a second cadence on a channel, so
  // this is the UI agreeing with the service rather than guessing.
  const canAdd = channels.length > cadences.length;

  return (
    <>
      <PageHeader
        title="Shorts drip"
        description="Each channel releases its banked shorts at times of day you choose. Nothing here generates a clip — it publishes the ones your finished videos have already been cut into."
        actions={
          canAdd && cadences.length > 0 ? (
            <Button asChild>
              <Link href="/automation/releases/new">
                <Plus />
                New cadence
              </Link>
            </Button>
          ) : undefined
        }
      />

      {channels.length === 0 ? (
        <EmptyState
          icon={Timer}
          title="No channels connected"
          description="A drip publishes to a YouTube channel, so it needs one connected first. Connect a channel and its shorts can start going out on a timer."
          action={
            <Button asChild>
              <Link href="/channels">Connect a channel</Link>
            </Button>
          }
        />
      ) : cadences.length === 0 ? (
        <EmptyState
          icon={Timer}
          title="No drip set up yet"
          description="Three long videos a week yield about twenty-one shorts — exactly three a day. A cadence releases them on a timer instead of generating anything new, so the whole week's shorts cost nothing beyond the videos you already made."
          action={
            <Button asChild>
              <Link href="/automation/releases/new">
                <Plus />
                Set up a drip
              </Link>
            </Button>
          }
        />
      ) : (
        <ReleaseCadenceList cadences={cadences} />
      )}
    </>
  );
}
