"use server";

import { revalidatePath } from "next/cache";

import { toSerializedError, type SerializedError } from "@/lib/errors";
import { channelService } from "@/services/channel.service";
import { requireSession } from "@/server/session";

export async function disconnectChannelAction(
  channelId: string,
): Promise<{ error: SerializedError } | { error?: undefined }> {
  try {
    const session = await requireSession();
    await channelService.disconnect(session.user.id, channelId);
  } catch (error) {
    return { error: toSerializedError(error) };
  }

  // Disconnecting removes the row outright, so the list the page already
  // rendered is now stale.
  revalidatePath("/channels");
  return {};
}
