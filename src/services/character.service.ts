import "server-only";

import { randomUUID } from "node:crypto";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { brandService } from "@/services/brand.service";
import { gatewayImageProvider } from "@/services/providers/image.provider";
import type { ImageProvider } from "@/services/providers/types";
import { env } from "@/config/env";

/**
 * How long a character brief may be.
 *
 * Generous rather than tight: the whole finding behind this feature is that a
 * one-line description is not enough to hold a character across a dozen
 * generations. Max Woolf's write-up used a ~2,600-token JSON character sheet
 * and still saw details shift. An operator who wants to name the exact shade
 * of a scarf should be able to.
 */
export const CHARACTER_BRIEF_MAX = 2000;

export interface CharacterSheet {
  /** Storage path of the generated reference image. */
  path: string;
  /** What this generation actually cost, from the provider's own token
   *  counts — the branding screen states it after the fact, having stated an
   *  estimate before. */
  costUsd: number;
}

/**
 * The one image every scene illustration is conditioned on.
 *
 * A children's story video is not a sequence of pretty pictures; it is one
 * character doing things in order. Stock cannot do that at all — the same
 * search run forty times returns forty different bears — and neither can
 * generation from a prompt alone: ask twice for "a small brown bear in a red
 * scarf" and you get two different bears, because nothing carries between the
 * calls. Without this the illustrated path reproduces the exact defect it
 * exists to fix, one tier prettier.
 *
 * So the sheet is generated once per channel, stored, and then passed *as an
 * input image* to every scene generation for every video that channel ever
 * makes (see `FootageService.collectIllustrated`). It is a real reference, not
 * a description of one: the AI SDK's `generateImage` accepts image inputs, and
 * conditioning on pixels is what the one method with published practitioner
 * evidence behind it actually does.
 *
 * Three views in one image rather than three images, because that is what a
 * character sheet is in the trade and because a single reference gives the
 * model the character from more than one angle for the price of one
 * generation.
 */
export class CharacterService {
  constructor(private readonly images: ImageProvider = gatewayImageProvider) {}

  /**
   * Generates a new sheet for this channel and makes it the channel's.
   *
   * Persisted immediately rather than offered as a choice between options, and
   * that is the difference from `LogoService.generateOptions`. A logo is a
   * taste decision between three equally valid marks; a character sheet is the
   * channel's protagonist, there is only ever one of it, and the operator's
   * real question is "is this right — yes, or generate another". Every
   * generation writes a new filename (`putObject` upserts, so reusing one
   * would swap the bytes behind a path the branding screen has already cached
   * — the failure `LogoService`'s batch token exists to prevent), so the
   * previous sheet stays intact in storage and the URL the browser holds keeps
   * resolving to the picture it was showing.
   *
   * Ownership is proven before a single image is generated — these cost money.
   */
  async generateSheet(userId: string, channelId: string): Promise<CharacterSheet> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { title: true, brand: { select: { characterBrief: true } } },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    const brief = channel.brand?.characterBrief?.trim();

    // Refused rather than defaulted, and deliberately. There is no sensible
    // stand-in protagonist: inventing one would put an arbitrary character
    // into somebody's channel and then hold it there for every video, which is
    // worse than not generating. The message names the field because that is
    // the action.
    if (!brief) {
      throw new ConflictError(
        "Describe the recurring character on this channel's branding screen first — " +
          "who they are, what they look like, what they wear. That description is the " +
          "only thing that keeps the same character in every scene.",
      );
    }

    const brand = await brandService.resolve(channelId);

    const prompt = characterSheetPrompt({ brief, tone: brand.tone, niche: brand.niche });

    const image = await this.images.generate({
      prompt,
      // Square, and not the frame's shape. This picture is never composed into
      // a video — it is only ever an input to other generations — and three
      // views side by side want width without the vertical letterboxing a 9:16
      // sheet would give them.
      aspectRatio: "1:1",
      model: env.AI_ILLUSTRATION_MODEL,
    });

    const objectPath = storagePath(
      channelId,
      "characters",
      `sheet-${randomUUID().slice(0, 8)}.png`,
    );
    await putObject(objectPath, image.data, "image/png");

    // Upsert for the same reason `LogoService.choose` does: setting up the
    // character is often among the first branding actions taken on a channel,
    // so the brand row frequently does not exist yet. It does here in practice
    // — the brief has to have been saved for us to have got this far — but the
    // shape stays the same as its neighbour rather than depending on that.
    await prisma.channelBrand.upsert({
      where: { channelId },
      create: { channelId, characterSheetPath: objectPath },
      update: { characterSheetPath: objectPath },
    });

    return { path: objectPath, costUsd: image.costUsd };
  }
}

/**
 * The sheet's prompt, exported so the illustration prompts in
 * `footage.service.ts` can be read beside it — the two have to describe the
 * same art direction in the same words or the scenes will not intercut with
 * each other, let alone with the sheet.
 */
export function characterSheetPrompt(input: {
  brief: string;
  tone: string | null;
  niche: string | null;
}): string {
  return [
    "Character reference sheet for a children's picture book.",
    "",
    "The character:",
    input.brief,
    "",
    // Three views, because a single frontal reference is what practitioner
    // reports found insufficient — the model has nothing to go on the moment a
    // scene turns the character sideways.
    "Show the SAME character three times across one image: full body facing front,",
    "full body in three-quarter view, and a head-and-shoulders close-up. Identical",
    "in every detail between the three — same colours, same markings, same clothing.",
    "",
    ILLUSTRATION_STYLE,
    input.niche ? `The channel is about ${input.niche}.` : "",
    input.tone ? `Tone: ${input.tone}.` : "",
    "",
    "Plain, uncluttered background. No text, no words, no letters, no captions,",
    "no labels, no watermark.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The art direction, in one block shared by the sheet and every scene.
 *
 * Repeated verbatim rather than paraphrased at each site: whole-image colour
 * drift between generations is the documented artifact that stops a dozen
 * stills reading as one film (it is why Seedream and FLUX were ruled out), and
 * the cheapest defence against it is that every prompt asks for the same
 * palette in the same words.
 */
export const ILLUSTRATION_STYLE = [
  "Soft watercolour storybook illustration with gentle rounded shapes and thick",
  "soft outlines. Warm, muted, low-contrast palette. Hand-painted paper texture.",
  "Nothing frightening, nothing sharp, nothing photoreal.",
].join(" ");

export const characterService = new CharacterService();
