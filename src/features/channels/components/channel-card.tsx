import Link from "next/link";
import { MonitorPlay, Palette } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/shared/relative-time";
import { DisconnectChannelButton } from "@/features/channels/components/disconnect-channel-button";
import { footageStyleLabel } from "@/lib/footage-styles";
import { audienceLabel } from "@/lib/youtube-audience";
import {
  categoryTitle,
  type PublishingDefaults,
} from "@/lib/youtube-categories";
import type { ChannelSummary } from "@/services/channel.service";

export function ChannelCard({
  channel,
  publishingDefaults,
}: {
  channel: ChannelSummary;
  /** Already resolved by `ChannelList` — a channel with no brand row arrives
   * here carrying the same defaults an upload would use for it. */
  publishingDefaults: PublishingDefaults;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-4">
        <Avatar size="lg">
          <AvatarImage src={channel.thumbnailUrl ?? undefined} alt="" />
          <AvatarFallback>
            <MonitorPlay className="size-4" />
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            {/* The channel name is this card's title, so it should be a
              * heading — a screen-reader user skimming a page of connected
              * channels by heading would otherwise find nothing at all. h3
              * sits under the page h1 and the section that holds the list.
              *
              * The heading is also the link to the channel's own screen, so
              * the obvious thing to click is the thing that is named — rather
              * than a card-wide click target that would swallow the buttons
              * on the right of it. */}
            <h3 className="truncate font-medium">
              <Link
                href={`/channels/${channel.id}`}
                className="focus-visible:ring-ring/50 rounded-sm outline-none hover:underline focus-visible:ring-3"
              >
                {channel.title}
              </Link>
            </h3>
            {!channel.isActive && <Badge variant="outline">Inactive</Badge>}
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {channel.handle ? `${channel.handle} · ` : ""}
            Connected <RelativeTime date={channel.connectedAt} />
          </p>
          {/* What this channel's uploads tell YouTube about themselves. On
            * the card rather than only inside the dialog because it is a
            * setting nobody would think to go looking for, and a wrong
            * language or category is invisible until the video quietly fails
            * to reach anyone. */}
          <p className="text-muted-foreground truncate text-xs">
            Publishes in {publishingDefaults.language} ·{" "}
            {categoryTitle(publishingDefaults.categoryId)} ·{" "}
            {/* The audience declaration reads as ordinary text when it is
              * false and as an emphasised one when it is true, because "this
              * channel declares every upload as child-directed" is the state
              * worth spotting from across a list — it strips comments,
              * notifications and personalised ads from everything the channel
              * publishes. */}
            <span
              className={
                publishingDefaults.madeForKids ? "text-foreground font-medium" : undefined
              }
            >
              {audienceLabel(publishingDefaults.madeForKids)}
            </span>{" "}
            · {footageStyleLabel(publishingDefaults.footageStyle)} footage
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Was a "Publishing defaults" dialog, which had grown three
            * settings and was about to grow the logo, the colours, the font,
            * the tone, the niche and the music query. All of it lives on the
            * channel's own screen now — see the note on that page for why a
            * route rather than a bigger dialog. */}
          <Button asChild variant="outline" size="sm">
            <Link href={`/channels/${channel.id}`}>
              <Palette />
              Branding
            </Link>
          </Button>
          <DisconnectChannelButton
            channelId={channel.id}
            channelTitle={channel.title}
          />
        </div>
      </CardContent>
    </Card>
  );
}
