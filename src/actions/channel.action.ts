"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { toSerializedError, type SerializedError } from "@/lib/errors";
import type { PublishingDefaults } from "@/lib/youtube-categories";
import { updatePublishingDefaultsSchema } from "@/schemas/channel.schema";
import { brandService, type VideoCategoryList } from "@/services/brand.service";
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

/**
 * The language and category every upload from this channel carries.
 *
 * Both are scoped to the signed-in operator inside the service (a foreign
 * channel id is `NotFoundError`, not a silent default), which is what makes it
 * safe for the dialog to pass a `channelId` straight from the rendered list.
 */
export async function updatePublishingDefaultsAction(
  input: unknown,
): Promise<ActionResult<PublishingDefaults>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updatePublishingDefaultsSchema.parse(input);
    const defaults = await brandService.updatePublishingDefaults(
      session.user.id,
      parsed,
    );

    revalidatePath("/channels");

    return defaults;
  });
}

/**
 * Fetched when the dialog opens rather than with the page, because it costs
 * two YouTube round trips and most visits to /channels are not about
 * categories. `listCategories` never throws — an unreachable API comes back as
 * the curated list with `live: false` — so this action's error branch exists
 * only for the session check above it.
 */
export async function listVideoCategoriesAction(
  channelId: string,
): Promise<ActionResult<VideoCategoryList>> {
  return run(async () => {
    const session = await requireSession();
    return brandService.listCategories(session.user.id, channelId);
  });
}
