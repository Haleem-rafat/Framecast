import "server-only";

import { prisma } from "@/lib/prisma";
import {
  clampDescription,
  clampTags,
  clampTitle,
  DESCRIPTION_MAX,
  TAGS_MAX,
  TITLE_MAX,
  withinLimits,
} from "@/lib/youtube-limits";
import { brandService } from "@/services/brand.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider, VideoMetadata } from "@/services/providers/types";

const LIMITS_REMINDER =
  `The previous attempt broke a limit. Title must be at most ${TITLE_MAX} ` +
  `characters, description at most ${DESCRIPTION_MAX}, and all tags together ` +
  `at most ${TAGS_MAX} characters.`;

export class MetadataService {
  constructor(
    private readonly provider: Pick<TextGenerationProvider, "generateMetadata"> =
      gatewayProvider,
  ) {}

  /**
   * Writes the video's generated title, description and tags.
   *
   * Returns `null` rather than throwing on any failure. Metadata is an
   * enhancement to a video that is already renderable and publishable: with
   * none, `publish()` falls back to the operator's own title and today's
   * description. Nothing here may block a video.
   */
  async generate(userId: string, videoId: string): Promise<VideoMetadata | null> {
    try {
      const video = await prisma.video.findFirst({
        where: { id: videoId, userId, deletedAt: null },
        select: {
          script: { select: { activeVersion: { select: { content: true } } } },
          project: { select: { channelId: true } },
        },
      });

      const script = video?.script?.activeVersion?.content;
      if (!script) {
        return null;
      }

      const brand = await brandService.resolve(video.project?.channelId ?? null);

      // The same per-user Anthropic credential script generation resolves
      // (see ScriptService.generate) rather than the bare gateway default:
      // an operator who has entered their own key must have it used, not
      // silently ignored in favour of a platform-wide fallback that may not
      // even be configured.
      const apiKey =
        (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ??
        undefined;

      // One retry with the limits restated, because a model that overran once
      // usually complies when told exactly what it broke — and a retry is far
      // cheaper than a clamped title that reads as truncated.
      const generated = await this.provider.generateMetadata({
        script,
        tone: brand.tone,
        niche: brand.niche,
        apiKey,
      });

      // The first response is already usable — over-limit is exactly what
      // clampTitle/clampDescription/clampTags exist to fix — so a failure on
      // the retry must fall back to clamping it rather than propagate to the
      // top-level catch below. Only the *first* call failing may produce
      // `null`: a retry that never improves on an already-clampable result
      // must never turn that result into nothing, which is precisely the
      // moment a flaky provider (a network blip, a rate limit) would do the
      // most damage.
      let best = generated;
      if (!withinLimits(generated)) {
        try {
          best = await this.provider.generateMetadata({
            script,
            tone: brand.tone,
            niche: brand.niche,
            apiKey,
            limitsReminder: LIMITS_REMINDER,
          });
        } catch (retryError) {
          console.error(
            `Metadata retry failed for video ${videoId}, falling back to the ` +
              `clamped first response: ` +
              (retryError instanceof Error ? retryError.message : String(retryError)),
          );
        }
      }

      const metadata: VideoMetadata = {
        title: clampTitle(best.title),
        description: clampDescription(best.description),
        tags: clampTags(best.tags),
      };

      await prisma.video.update({
        where: { id: videoId },
        data: {
          generatedTitle: metadata.title,
          generatedDescription: metadata.description,
          tags: metadata.tags,
        },
      });

      return metadata;
    } catch (error) {
      console.error(
        `Could not generate metadata for video ${videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }
}

export const metadataService = new MetadataService();
