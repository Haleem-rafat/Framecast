import { MonitorPlay } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ChannelCard } from "@/features/channels/components/channel-card";
import { ConnectChannelButton } from "@/features/channels/components/connect-channel-button";
import {
  PUBLISHING_DEFAULTS,
  type PublishingDefaults,
} from "@/lib/youtube-categories";
import type { ChannelSummary } from "@/services/channel.service";

export function ChannelList({
  channels,
  publishingDefaults,
}: {
  channels: ChannelSummary[];
  /**
   * Keyed by channel id, and sparse: only channels with a `ChannelBrand` row
   * appear. A channel without one falls back to the same values
   * `BrandService.resolve` would use for it at publish time, so what a card
   * shows and what an upload sends can never disagree.
   */
  publishingDefaults: Record<string, PublishingDefaults>;
}) {
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
        <ChannelCard
          key={channel.id}
          channel={channel}
          publishingDefaults={publishingDefaults[channel.id] ?? PUBLISHING_DEFAULTS}
        />
      ))}
    </div>
  );
}
