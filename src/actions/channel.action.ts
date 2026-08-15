"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { toSerializedError, type SerializedError } from "@/lib/errors";
import { storagePath } from "@/lib/storage";
import {
  chooseLogoSchema,
  updateBrandingSchema,
} from "@/schemas/channel.schema";
import {
  brandService,
  type ChannelBranding,
  type VideoCategoryList,
  type VoiceList,
} from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
import { logoService } from "@/services/logo.service";
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
 * Everything the branding screen edits, in one write.
 *
 * Scoped to the signed-in operator inside the service (a foreign channel id is
 * `NotFoundError`, not a silent default), which is what makes it safe for the
 * form to pass a `channelId` straight from the URL it was rendered for.
 *
 * Both paths are revalidated because both display these values: the branding
 * screen is what the operator is looking at, and the channels list carries the
 * same publishing summary on every card.
 */
export async function updateBrandingAction(
  input: unknown,
): Promise<ActionResult<ChannelBranding>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = updateBrandingSchema.parse(input);
    const branding = await brandService.updateBranding(session.user.id, parsed);

    revalidatePath("/channels");
    revalidatePath(`/channels/${parsed.channelId}`);

    return branding;
  });
}

/**
 * Generates one logo option, and is called once per option by the screen.
 *
 * `LogoService.generateOptions` takes a count and would happily produce all
 * three in a single call, which is how this started. One at a time is worth
 * the two extra round trips for one reason: an image generation takes tens of
 * seconds, and a batch of three can only report "still working" until the last
 * one lands. Called per option, the screen knows exactly how many are done,
 * shows each as it arrives, and — because a failed call comes back as an empty
 * list rather than an exception — carries on to the next one when the gateway
 * drops a single generation. That is the documented partial case, and this is
 * what makes it visible instead of a silently short batch.
 *
 * Each call is separately ownership-checked before a single image is
 * generated, inside the service, because each one spends money.
 *
 * Deliberately no `revalidatePath`: an option is not the channel's logo until
 * `chooseLogoAction` says so, and nothing rendered from the database has
 * changed. Refreshing the route here would throw away the options already on
 * screen, which exist nowhere else.
 */
export async function generateLogoOptionAction(
  channelId: string,
): Promise<ActionResult<string | null>> {
  return run(async () => {
    const session = await requireSession();
    const [path] = await logoService.generateOptions(
      session.user.id,
      channelId,
      1,
    );

    // Null, not a throw: the service already treats a failed generation as a
    // shorter list rather than an error, and the screen counts this option as
    // failed and moves to the next.
    return path ?? null;
  });
}

/**
 * Makes one of the generated options this channel's logo.
 *
 * Takes a filename and rebuilds the storage path here rather than accepting
 * one from the browser. `ChannelBrand.logoPath` is handed straight to
 * `getObject` when a thumbnail is composited, so a caller able to set it to an
 * arbitrary string could point a channel's logo at any object in the bucket;
 * `storagePath(channelId, "logos", …)` pins it under this channel's own prefix
 * and refuses `/` and `..` itself. The channel is then proven to be the
 * operator's inside `LogoService.choose`, which is what makes the `channelId`
 * in that path safe to trust.
 */
export async function chooseLogoAction(
  input: unknown,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    const { channelId, filename } = chooseLogoSchema.parse(input);

    await logoService.choose(
      session.user.id,
      channelId,
      storagePath(channelId, "logos", filename),
    );

    revalidatePath(`/channels/${channelId}`);

    return null;
  });
}

/**
 * Fetched when the branding screen mounts rather than with the page, because
 * it costs two YouTube round trips and the rest of the screen needs none.
 * `listCategories` never throws — an unreachable API comes back as the curated
 * list with `live: false` — so this action's error branch exists only for the
 * session check above it.
 */
export async function listVideoCategoriesAction(
  channelId: string,
): Promise<ActionResult<VideoCategoryList>> {
  return run(async () => {
    const session = await requireSession();
    return brandService.listCategories(session.user.id, channelId);
  });
}

/**
 * The voices the branding screen's narration picker offers.
 *
 * Takes no arguments at all, which is the point: the answer depends on the
 * signed-in operator's own ElevenLabs credential and on nothing the browser
 * sends. There is no id to tamper with, no channel to confuse for someone
 * else's, and two operators calling this get two different lists because
 * `resolveKey` reads only their own row.
 *
 * The key itself never comes back. `VoiceList` is names, labels and public
 * preview URLs — the service resolves the credential, hands it to the
 * provider as a request header, and returns none of it.
 *
 * Like `listVideoCategoriesAction`, the service below never throws for a
 * reachability reason: a missing credential and an unreachable API are both
 * reported as a `status` the picker explains in words, so this action's error
 * branch exists only for the session check.
 */
export async function listVoicesAction(): Promise<ActionResult<VoiceList>> {
  return run(async () => {
    const session = await requireSession();
    return brandService.listVoices(session.user.id);
  });
}
