import "server-only";

import { randomUUID } from "node:crypto";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { brandService } from "@/services/brand.service";
import { gatewayImageProvider } from "@/services/providers/image.provider";
import type { ImageProvider } from "@/services/providers/types";

const DEFAULT_OPTION_COUNT = 3;

/**
 * A channel's logo, generated once rather than per video.
 *
 * The channel avatar cannot be set from here — the YouTube Data API has no
 * endpoint for it, only for the banner. The logo is stored so thumbnails can
 * be watermarked with it and so the operator can download it and set the
 * avatar by hand, once.
 */
export class LogoService {
  constructor(private readonly images: ImageProvider = gatewayImageProvider) {}

  /**
   * Generates several options for the operator to choose between.
   *
   * Returns the options it managed rather than failing on the first error: two
   * usable logos to pick from beats an exception because the third generation
   * timed out. An empty list means every attempt failed, which the caller
   * reports rather than treating as a crash.
   *
   * Ownership is checked before a single image is generated — these cost money.
   */
  async generateOptions(
    userId: string,
    channelId: string,
    count = DEFAULT_OPTION_COUNT,
  ): Promise<string[]> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { title: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    const brand = await brandService.resolve(channelId);
    const prompt =
      `A simple, bold logo mark for a channel called "${channel.title}" about ` +
      `${brand.niche}. Tone: ${brand.tone}. Flat vector style, one strong ` +
      `shape, high contrast, centred, plain background. No text, no letters.`;

    const paths: string[] = [];

    // One token per call, shared across this batch's `count` logos rather
    // than one per logo: distinguishing option 0 of this call from option 0
    // of the next is the whole point (see below), but the three options
    // within a single call already have no reason to collide with each
    // other — `index` alone already does that job for them.
    //
    // Without this, a second `generateOptions` call for the same channel
    // would write back to the exact same `logo-0.png`/`logo-1.png`/
    // `logo-2.png` paths as the first — `putObject` uploads with
    // `upsert: true` — silently swapping the bytes behind whichever of
    // those paths the operator had already chosen via `choose()`.
    // `ChannelBrand.logoPath` would still read the same string, so nothing
    // in the database would show that the image it now resolves to is a
    // different generation entirely. Same failure mode `thumbnail.service.ts`
    // documents on its own randomised version keys, for the same reason.
    const batchToken = randomUUID().slice(0, 8);

    for (let index = 0; index < count; index += 1) {
      try {
        const image = await this.images.generate({ prompt, aspectRatio: "1:1" });
        const objectPath = storagePath(channelId, "logos", `logo-${batchToken}-${index}.png`);
        await putObject(objectPath, image.data, "image/png");
        paths.push(objectPath);
      } catch (error) {
        console.error(
          `Could not generate logo option ${index} for channel ${channelId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return paths;
  }

  /** Upserts rather than updates: choosing a logo is often the first branding
   *  action an operator takes, so the brand row frequently does not exist yet. */
  async choose(userId: string, channelId: string, logoPath: string): Promise<void> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    await prisma.channelBrand.upsert({
      where: { channelId },
      create: { channelId, logoPath },
      update: { logoPath },
    });
  }
}

export const logoService = new LogoService();
