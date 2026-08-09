import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { channelErrorMessage } from "@/features/channels/channel-error";
import { ChannelList } from "@/features/channels/components/channel-list";
import { ConnectChannelButton } from "@/features/channels/components/connect-channel-button";
import { channelService } from "@/services/channel.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Channels" };

interface ChannelsPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function ChannelsPage({
  searchParams,
}: ChannelsPageProps) {
  const user = await requireUser();
  const { error } = await searchParams;
  const errorMessage = channelErrorMessage(error);

  const channels = await channelService.list(user.id);

  return (
    <>
      <PageHeader
        title="Channels"
        description="YouTube channels this studio can publish to."
        actions={channels.length > 0 ? <ConnectChannelButton /> : undefined}
      />

      {errorMessage && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <ChannelList channels={channels} />
    </>
  );
}
