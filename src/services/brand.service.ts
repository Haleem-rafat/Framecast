import "server-only";

import { prisma } from "@/lib/prisma";
import type { VideoStyle } from "@/lib/video-style";
import { DEFAULT_STYLE } from "@/lib/video-style";

export interface ResolvedBrand {
  videoStyle: VideoStyle;
  logoPath: string | null;
  primaryColour: string;
  secondaryColour: string;
  headlineFont: string;
  tone: string;
  niche: string;
  musicQuery: string;
}

/** What a channel with no brand row gets. Chosen to be unremarkable rather
 *  than distinctive: a default that looks like a deliberate design would be
 *  worn by every channel that never set one. */
const FALLBACK = {
  primaryColour: "#FFFFFF",
  secondaryColour: "#000000",
  headlineFont: "DejaVu Sans",
  tone: "clear and factual",
  niche: "general interest",
  musicQuery: "calm ambient instrumental",
} as const;

/**
 * Merges a stored style over the defaults one section at a time.
 *
 * Not a deep merge and not a replacement. A brand that sets only
 * `transitions.durationSeconds` must keep every other transition field and
 * every other section — a replacement would silently blank them, and a fully
 * general deep merge would let a malformed column reach FFmpeg. Section by
 * section is exactly as much merging as `VideoStyle`'s shape needs.
 */
function mergeVideoStyle(stored: unknown): VideoStyle {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return DEFAULT_STYLE;
  }

  const partial = stored as Partial<Record<keyof VideoStyle, unknown>>;
  const merged = { ...DEFAULT_STYLE };

  for (const key of Object.keys(DEFAULT_STYLE) as (keyof VideoStyle)[]) {
    const section = partial[key];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      merged[key] = { ...DEFAULT_STYLE[key], ...section } as never;
    }
  }

  return merged;
}

export class BrandService {
  /**
   * The one way anything reads a channel's identity.
   *
   * Never throws and never returns null: a missing brand row, a video whose
   * project has no channel, and a malformed `videoStyle` column all resolve to
   * defaults. Generation is an enhancement, and a channel that has not been
   * branded yet must still render and publish.
   */
  async resolve(channelId: string | null): Promise<ResolvedBrand> {
    const brand = channelId
      ? await prisma.channelBrand.findUnique({ where: { channelId } })
      : null;

    return {
      videoStyle: mergeVideoStyle(brand?.videoStyle),
      logoPath: brand?.logoPath ?? null,
      primaryColour: brand?.primaryColour ?? FALLBACK.primaryColour,
      secondaryColour: brand?.secondaryColour ?? FALLBACK.secondaryColour,
      headlineFont: brand?.headlineFont ?? FALLBACK.headlineFont,
      tone: brand?.tone ?? FALLBACK.tone,
      niche: brand?.niche ?? FALLBACK.niche,
      musicQuery: brand?.musicQuery ?? FALLBACK.musicQuery,
    };
  }
}

export const brandService = new BrandService();
