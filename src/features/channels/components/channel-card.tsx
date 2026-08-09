import { MonitorPlay } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelativeTime } from "@/components/shared/relative-time";
import { DisconnectChannelButton } from "@/features/channels/components/disconnect-channel-button";
import type { ChannelSummary } from "@/services/channel.service";

export function ChannelCard({ channel }: { channel: ChannelSummary }) {
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
            <p className="truncate font-medium">{channel.title}</p>
            {!channel.isActive && <Badge variant="outline">Inactive</Badge>}
          </div>
          <p className="text-muted-foreground truncate text-xs">
            {channel.handle ? `${channel.handle} · ` : ""}
            Connected <RelativeTime date={channel.connectedAt} />
          </p>
        </div>

        <DisconnectChannelButton
          channelId={channel.id}
          channelTitle={channel.title}
        />
      </CardContent>
    </Card>
  );
}
