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

/** How far down a cause chain to look. The gateway wraps twice — a named
 *  error over the SDK's `AI_APICallError` over the provider's JSON body — and
 *  a bound stops a cyclic `cause` from spinning. */
const MAX_CAUSE_DEPTH = 5;

/**
 * What actually went wrong, in the words the provider used.
 *
 * The catch below used to throw one sentence — "The model provider failed to
 * generate an image." — for every failure it could have. That sentence is true
 * of a rate limit, a content refusal and an exhausted billing account alike,
 * and only one of those is worth retrying. An operator read it as a glitch and
 * retried a hard `402 Team budget exceeded` two hours later, against a cap no
 * retry could clear, and the reason was sitting one level down the cause chain
 * the whole time.
 *
 * The *human sentence* is preferred over the JSON body it wraps. Both carry the
 * same fact, but one of them puts a brace and a schema in front of the person
 * reading it — so a message that starts with `{` is skipped in favour of the
 * next one down, and only used if nothing better exists.
 */
function describeFailure(cause: unknown): string {
  let status: number | undefined;
  let sentence: string | undefined;
  let fallback: string | undefined;
  let current: unknown = cause;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const error = current as { message?: unknown; statusCode?: unknown; cause?: unknown };

    if (status === undefined && typeof error.statusCode === "number") {
      status = error.statusCode;
    }

    const message = typeof error.message === "string" ? error.message.trim() : "";

    if (message) {
      if (message.startsWith("{")) {
        fallback ??= message;
      } else {
        sentence ??= message;
      }
    }

    current = error.cause;
  }

  const detail = sentence ?? fallback;

  if (!detail) {
    return "The model provider failed to generate an image.";
  }

  // Said out loud only when it is true. A rate limit clears on its own and a
  // 5xx may never recur, so telling an operator to stop retrying those would
  // send them looking for a problem that is not theirs.
  const permanent = status !== undefined && !isRetryable(cause);
  const prefix = permanent
    ? "The image model refused the request, and a retry will not help"
    : "The model provider failed to generate an image";

  return `${prefix}: ${detail}`;
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
        // Spread rather than always-present, so a provider that reports no
        // usage at all produces an object without the keys instead of two
        // zeroes that read as a measurement.
        //
        // These exist because the `?? 0` above is lossy in a way that cannot be
        // detected after the fact: a response missing `outputTokens` prices a
        // 1,150-in/1,372-out picture at $0.00575 rather than $0.047, and
        // `.toFixed(3)` renders that as "$0.006" — a number indistinguishable
        // from a genuinely cheap model. Recording the raw counts is what lets
        // anybody tell the two apart.
        ...(result.usage?.inputTokens !== undefined
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(result.usage?.outputTokens !== undefined
          ? { outputTokens: result.usage.outputTokens }
          : {}),
      };
    } catch (cause) {
      throw new ProviderError("GATEWAY", describeFailure(cause), isRetryable(cause), {
        cause,
      });
    }
  }
}

export const gatewayImageProvider: ImageProvider = new GatewayImageProvider();
