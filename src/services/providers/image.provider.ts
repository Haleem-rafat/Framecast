import "server-only";

import { createGateway, generateImage as aiGenerateImage } from "ai";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type { GeneratedImage, ImageProvider } from "@/services/providers/types";

/**
 * Generates thumbnails and channel logos through the same Vercel AI Gateway
 * that GatewayProvider (gateway.provider.ts) routes scripts and metadata
 * through — adding or swapping an image model is a config change
 * (AI_IMAGE_MODEL) rather than a new dependency.
 *
 * The AI SDK's `generateImage` is injected rather than called directly so
 * tests can supply a fake — a real call costs money and this constructor is
 * the one seam that lets a test avoid making one.
 */
export class GatewayImageProvider implements ImageProvider {
  constructor(
    private readonly generateImage: typeof aiGenerateImage = aiGenerateImage,
  ) {}

  async generate(input: {
    prompt: string;
    aspectRatio: "16:9" | "1:1";
  }): Promise<GeneratedImage> {
    try {
      const model = createGateway({ apiKey: env.AI_GATEWAY_API_KEY }).imageModel(
        env.AI_IMAGE_MODEL,
      );

      const result = await this.generateImage({
        model,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
      });

      return {
        data: Buffer.from(result.image.uint8Array),
        model: env.AI_IMAGE_MODEL,
      };
    } catch (cause) {
      // Unlike GatewayProvider's isRetryable, this doesn't try to classify
      // the failure by status code: a thumbnail or logo generation that
      // fails is always worth a retry, not a wrong request in need of a
      // fix — there's no user-editable prompt shape here to get wrong the
      // way a script prompt can be.
      throw new ProviderError(
        "GATEWAY",
        "The model provider failed to generate an image.",
        true,
        { cause },
      );
    }
  }
}

export const gatewayImageProvider: ImageProvider = new GatewayImageProvider();
