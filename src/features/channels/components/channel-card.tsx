import { MonitorPlay } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/shared/relative-time";
import { DisconnectChannelButton } from "@/features/channels/components/disconnect-channel-button";
import { PublishingDefaultsDialog } from "@/features/channels/components/publishing-defaults-dialog";
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
              * sits under the page h1 and the section that holds the list. */}
            <h3 className="truncate font-medium">{channel.title}</h3>
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
            {categoryTitle(publishingDefaults.categoryId)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PublishingDefaultsDialog
            channelId={channel.id}
            channelTitle={channel.title}
            defaults={publishingDefaults}
          />
          <DisconnectChannelButton
            channelId={channel.id}
            channelTitle={channel.title}
          />
        </div>
      </CardContent>
    </Card>
  );
}
