import { MonitorPlay } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ChannelCard } from "@/features/channels/components/channel-card";
import { ConnectChannelButton } from "@/features/channels/components/connect-channel-button";
import type { ChannelSummary } from "@/services/channel.service";

export function ChannelList({ channels }: { channels: ChannelSummary[] }) {
  if (channels.length === 0) {
    return (
      <EmptyState
        icon={MonitorPlay}
        title="No channels connected"
        description="Connect a YouTube channel to unlock publishing. Framecast requests upload and read-only access, nothing more."
        action={<ConnectChannelButton size="sm" />}
      />
    );
  }

  return (
    <div className="space-y-3">
      {channels.map((channel) => (
        <ChannelCard key={channel.id} channel={channel} />
      ))}
    </div>
  );
}
