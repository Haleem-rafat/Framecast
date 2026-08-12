import "server-only";

import { createGateway, generateImage as aiGenerateImage } from "ai";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type { GeneratedImage, ImageProvider } from "@/services/providers/types";

/** 429 and 5xx are transient; everything else means the request itself is
 *  wrong. Same rule gateway.provider.ts, music.provider.ts and
 *  elevenlabs.provider.ts apply. An HTTP failure the AI SDK surfaces (e.g.
 *  `APICallError` from `@ai-sdk/provider`) carries `statusCode`; a failure
 *  with no HTTP status behind it — a malformed-but-200 response, a thrown
 *  value that isn't an SDK error at all — falls through to "not retryable",
 *  which is the correct default: there is no rate limit or outage to wait
 *  out if there was never a status code to read. */
function isRetryable(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;

  return status === 429 || (status !== undefined && status >= 500);
}

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
        // The model that actually answered, not the one asked for.
        // ThumbnailVersion.model (Task 7) exists so a good thumbnail can be
        // reproduced, and a record naming the requested model rather than
        // the one that ran would misdescribe any request the gateway
        // silently routed to a fallback. `responses[0].modelId` is the
        // provider's own account of what ran; env.AI_IMAGE_MODEL is only a
        // fallback for the case where the SDK returns no response metadata
        // at all.
        model: result.responses?.[0]?.modelId ?? env.AI_IMAGE_MODEL,
      };
    } catch (cause) {
      throw new ProviderError(
        "GATEWAY",
        "The model provider failed to generate an image.",
        isRetryable(cause),
        { cause },
      );
    }
  }
}

export const gatewayImageProvider: ImageProvider = new GatewayImageProvider();
