import "server-only";

import { createGateway, generateImage as aiGenerateImage } from "ai";

import { env } from "@/config/env";
import { estimateCostUsd } from "@/lib/cost";
import { ProviderError } from "@/lib/errors";
import type {
  GeneratedImage,
  ImageGenerationInput,
  ImageProvider,
} from "@/services/providers/types";

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
 * Generates thumbnails, channel logos and story illustrations through the same
 * Vercel AI Gateway that GatewayProvider (gateway.provider.ts) routes scripts
 * and metadata through — adding or swapping an image model is a config change
 * (AI_IMAGE_MODEL, AI_ILLUSTRATION_MODEL) rather than a new dependency.
 *
 * The AI SDK's `generateImage` is injected rather than called directly so
 * tests can supply a fake — a real call costs money and this constructor is
 * the one seam that lets a test avoid making one.
 */
export class GatewayImageProvider implements ImageProvider {
  constructor(
    private readonly generateImage: typeof aiGenerateImage = aiGenerateImage,
  ) {}

  async generate(input: ImageGenerationInput): Promise<GeneratedImage> {
    const requested = input.model ?? env.AI_IMAGE_MODEL;

    try {
      const model = createGateway({ apiKey: env.AI_GATEWAY_API_KEY }).imageModel(requested);

      const references = input.referenceImages ?? [];

      const result = await this.generateImage({
        model,
        // A bare string when there is nothing to condition on, which is
        // byte-for-byte the call logos and thumbnails have always made. The
        // object form is how the AI SDK carries reference images, and it is
        // the whole character-consistency mechanism — see
        // `ImageGenerationInput.referenceImages`.
        prompt:
          references.length > 0
            ? { images: references.map((image) => new Uint8Array(image)), text: input.prompt }
            : input.prompt,
        // Exactly one of these. The SDK treats them as alternative ways to say
        // the same thing and warns when both arrive, so a caller that named
        // pixels gets pixels and everything else keeps the ratio it always
        // passed.
        ...(input.size ? { size: input.size } : { aspectRatio: input.aspectRatio }),
      });

      const reported = result.responses?.[0]?.modelId ?? requested;

      return {
        data: Buffer.from(result.image.uint8Array),
        // The model that actually answered, not the one asked for.
        // ThumbnailVersion.model (Task 7) exists so a good thumbnail can be
        // reproduced, and a record naming the requested model rather than
        // the one that ran would misdescribe any request the gateway
        // silently routed to a fallback. `responses[0].modelId` is the
        // provider's own account of what ran; the requested id is only a
        // fallback for the case where the SDK returns no response metadata
        // at all.
        model: reported,
        // Priced from the tokens the provider itself reported, against the
        // model it says ran. An unlisted model or a provider that reports no
        // usage prices at 0 — see `estimateCostUsd`, which prefers a
        // suspiciously free number to a plausible wrong one.
        costUsd: estimateCostUsd(
          reported,
          result.usage?.inputTokens ?? 0,
          result.usage?.outputTokens ?? 0,
        ),
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
