import "server-only";

import { z } from "zod";

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
 * Mirrors `VideoStyle`. Every section is optional — a stored value may set
 * only one — and every leaf carries both its real type and the bound that
 * keeps it safe to reach FFmpeg or ElevenLabs. This is not defensive
 * decoration: `render.service.ts` computes things like
 * `transitions.durationSeconds * 2`, and a string there produces `NaN`, a
 * negative or zero duration is exactly as unrenderable as a string, and a
 * `voice.stability` outside `[0, 1]` is a value ElevenLabs itself would
 * reject. `z.object()` strips keys it does not recognise by default, so an
 * unknown key nested inside an otherwise-valid section never survives the
 * merge either.
 */
const motionStyleSchema = z.object({
  enabled: z.boolean().optional(),
  // (scale - 1) is the pannable margin (see VideoStyle's own doc comment);
  // below 1 that margin is negative.
  scale: z.number().min(1).optional(),
});

const captionStyleSchema = z.object({
  fontName: z.string().min(1).optional(),
  fontSize: z.number().positive().optional(),
  primaryColour: z.string().min(1).optional(),
  outlineColour: z.string().min(1).optional(),
  outline: z.number().nonnegative().optional(),
  shadow: z.number().nonnegative().optional(),
  marginV: z.number().nonnegative().optional(),
});

const audioStyleSchema = z.object({
  musicGainDb: z.number().finite().optional(),
  sfxGainDb: z.number().finite().optional(),
  duckThreshold: z.number().min(0).max(1).optional(),
  duckRatio: z.number().positive().optional(),
  duckAttackMs: z.number().nonnegative().optional(),
  duckReleaseMs: z.number().nonnegative().optional(),
});

const transitionStyleSchema = z.object({
  enabled: z.boolean().optional(),
  durationSeconds: z.number().positive().optional(),
});

const voiceStyleSchema = z.object({
  stability: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().positive().optional(),
  seed: z.number().int().optional(),
});

const videoStyleSchema = z.object({
  motion: motionStyleSchema.optional(),
  captions: captionStyleSchema.optional(),
  audio: audioStyleSchema.optional(),
  transitions: transitionStyleSchema.optional(),
  voice: voiceStyleSchema.optional(),
});

type ParsedVideoStyle = z.infer<typeof videoStyleSchema>;

/**
 * Parses a stored style against `videoStyleSchema` and merges what parsed
 * over the defaults, one section at a time.
 *
 * Parsing is whole-or-nothing: if any part of the stored value fails
 * validation — a wrong-typed leaf, a section that is `null` instead of
 * absent, anything Zod rejects — the entire column is discarded and
 * `DEFAULT_STYLE` is returned untouched, rather than trying to salvage the
 * sections that happened to parse. A column that is partly garbage most
 * likely became garbage by accident (a bad manual edit, a future migration
 * bug), and guessing which half is still trustworthy is exactly the kind of
 * guess that lets a stray `NaN` reach FFmpeg.
 *
 * What *does* parse is still merged section by section rather than
 * replacing `VideoStyle` outright: a brand that sets only
 * `transitions.durationSeconds` must keep every other transition field and
 * every other section, which a full replacement would silently blank.
 *
 * Always returns a fresh, deep copy — including on the all-defaults path —
 * so a caller that mutates a resolved style in place can never corrupt
 * `DEFAULT_STYLE` for every other channel for the rest of the process.
 *
 * Discarding is loud, though the policy stays all-or-nothing. Everything an
 * operator would notice about a rejected column — the render, the voice, the
 * captions — comes out looking exactly like a channel that was never styled
 * at all, and `resolve()` is by design incapable of throwing, so a bad
 * `videoStyle` has no other way to announce itself. "My style isn't
 * applying" would otherwise be a report with nothing behind it: no error, no
 * status, no row that looks wrong. Zod's issues name the offending path and
 * value, which is the difference between a thread to pull and a shrug.
 * `channelId` is carried in for the log line alone.
 */
function mergeVideoStyle(stored: unknown, channelId: string | null): VideoStyle {
  const result = videoStyleSchema.safeParse(stored);

  // Absent is not malformed. A channel with no brand row at all, or a brand
  // row whose `videoStyle` column was never written, arrives here as
  // `undefined`/`null` — which `videoStyleSchema` rejects the same way it
  // rejects genuine garbage, and which describes most channels. Logging those
  // would bury the one case worth reading in a line per unbranded channel per
  // render.
  if (!result.success && stored != null) {
    console.error(
      `brandService.resolve: discarding the stored videoStyle for channel ` +
        `${channelId ?? "(none)"} and using defaults — ` +
        result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
    );
  }

  const parsed: ParsedVideoStyle = result.success ? result.data : {};

  const merged = structuredClone(DEFAULT_STYLE);

  for (const key of Object.keys(DEFAULT_STYLE) as (keyof VideoStyle)[]) {
    const section = parsed[key];
    if (section) {
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
   * project has no channel, a malformed `videoStyle` column, a `channelId`
   * that turns out not to be a valid UUID, and a database call that fails
   * outright all resolve to defaults instead of escaping. Generation is an
   * enhancement, and a channel that has not been branded yet — or whose
   * brand lookup breaks — must still render and publish.
   */
  async resolve(channelId: string | null): Promise<ResolvedBrand> {
    const brand = channelId ? await this.findBrand(channelId) : null;

    return {
      videoStyle: mergeVideoStyle(brand?.videoStyle, channelId),
      logoPath: brand?.logoPath ?? null,
      primaryColour: brand?.primaryColour ?? FALLBACK.primaryColour,
      secondaryColour: brand?.secondaryColour ?? FALLBACK.secondaryColour,
      headlineFont: brand?.headlineFont ?? FALLBACK.headlineFont,
      tone: brand?.tone ?? FALLBACK.tone,
      niche: brand?.niche ?? FALLBACK.niche,
      musicQuery: brand?.musicQuery ?? FALLBACK.musicQuery,
    };
  }

  /**
   * Isolates the one call in `resolve()` that can fail for reasons that have
   * nothing to do with branding. The column backing `channelId` is
   * `@db.Uuid`, but the parameter here is an unconstrained `string` — a
   * caller building a video for a project with no channel could pass
   * anything — so a non-UUID value throws a Postgres error straight out of
   * `findUnique`, and so does an ordinary transient connection failure.
   * `resolve()`'s whole contract is that it never throws; once this is wired
   * into rendering, an error escaping here would not be a missing brand, it
   * would be a failed video over what should have been a cosmetic lookup.
   * Caught, logged for whoever is debugging a channel that looks unbranded,
   * never rethrown.
   */
  private async findBrand(channelId: string) {
    try {
      return await prisma.channelBrand.findUnique({ where: { channelId } });
    } catch (error) {
      console.error(
        `brandService.resolve: could not load brand for channel ${channelId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }
}

export const brandService = new BrandService();
