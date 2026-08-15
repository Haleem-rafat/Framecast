import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MonitorPlay } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { RelativeTime } from "@/components/shared/relative-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BrandingForm } from "@/features/channels/components/branding-form";
import { LogoStudio } from "@/features/channels/components/logo-studio";
import { isAppError } from "@/lib/errors";
import { brandService } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Channel branding" };

interface ChannelBrandingPageProps {
  params: Promise<{ id: string }>;
}

/**
 * One channel's identity, on a route rather than in a dialog.
 *
 * A route because of what is on it. This is five groups, a dozen controls, a
 * gallery of generated images and a legal declaration with four bullet points
 * of consequence — `/channels` is a list of one-line cards, and a
 * `ResponsiveDialog` becomes a bottom sheet on a phone, where all of that would
 * be a scrolling drawer over a page the operator can no longer see. Two more
 * reasons settle it: logo generation runs for a minute or more and holds state
 * that exists nowhere else, which is exactly the thing that should not sit
 * behind a click-outside-to-dismiss; and the codebase already answers this
 * question the same way for the same shape — `/videos/[id]` and
 * `/automation/schedules/[id]` are both routes reached from a list of cards,
 * with the same `requireUser` → `await params` → service-scoped read →
 * `notFound()` skeleton this page uses.
 *
 * It is also, unlike a dialog, a URL: reloadable, linkable, and testable by
 * reloading it — which is how the persistence of every field on it was
 * checked.
 *
 * Not in `src/config/navigation.ts`, and deliberately: it is per channel, so
 * there is no single href for it. It is reached from the channel's own card.
 */
export default async function ChannelBrandingPage({
  params,
}: ChannelBrandingPageProps) {
  const user = await requireUser();
  const { id } = await params;

  // Both scoped by `userId` inside the service, so a foreign or invented id is
  // a routing miss rather than a leak of whether the row exists. Sequential,
  // not `Promise.all`: the branding read is the cheaper of the two and there is
  // nothing to show if the channel is not the operator's.
  const [channel, branding] = await Promise.all([
    channelService.get(user.id, id),
    brandService.getBranding(user.id, id),
  ]).catch((error: unknown) => {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  });

  return (
    <>
      {/* The back link and the header in one element, so the layout's 24px gap
        * does not open up between a control and the thing it belongs to. */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/channels">
            <ArrowLeft />
            All channels
          </Link>
        </Button>

        <PageHeader
          title={channel.title}
          description="Everything every video from this channel inherits — its logo, its colours, how it is written, what it sounds like, and what it tells YouTube."
          actions={
            <div className="flex items-center gap-3">
              <Avatar size="lg">
                <AvatarImage src={channel.thumbnailUrl ?? undefined} alt="" />
                <AvatarFallback>
                  <MonitorPlay className="size-4" />
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 text-sm">
                {channel.handle && (
                  <p className="truncate font-medium">{channel.handle}</p>
                )}
                <p className="text-muted-foreground text-xs">
                  Connected <RelativeTime date={channel.connectedAt} />
                </p>
              </div>
              {!channel.isActive && <Badge variant="outline">Inactive</Badge>}
            </div>
          }
        />
      </div>

      <LogoStudio
        channelId={channel.id}
        channelTitle={channel.title}
        logoPath={branding.logoPath}
      />

      <BrandingForm
        channelId={channel.id}
        channelTitle={channel.title}
        branding={branding}
      />

      <p className="text-muted-foreground text-xs">
        {branding.updatedAt ? (
          <>
            Last saved <RelativeTime date={branding.updatedAt} />.
          </>
        ) : (
          "Never saved — everything above is the default this channel already renders and publishes with."
        )}
      </p>
    </>
  );
}
