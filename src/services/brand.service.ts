import "server-only";

import { z } from "zod";

import { env } from "@/config/env";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { VideoStyle } from "@/lib/video-style";
import { DEFAULT_STYLE } from "@/lib/video-style";
import {
  CURATED_CATEGORIES,
  PUBLISHING_DEFAULTS,
  type PublishingDefaults,
  type VideoCategory,
} from "@/lib/youtube-categories";
import type { UpdateBrandingInput } from "@/schemas/channel.schema";
import { channelService } from "@/services/channel.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { elevenLabsProvider } from "@/services/providers/elevenlabs.provider";
import type { SpeechProvider, SpeechVoice } from "@/services/providers/types";

/** Injectable so tests never make a real call to YouTube. Same seam, and the
 *  same reason, as `PublishService` and `ChannelService` have one. */
export type FetchLike = typeof fetch;

export interface ResolvedBrand {
  videoStyle: VideoStyle;
  logoPath: string | null;
  primaryColour: string;
  secondaryColour: string;
  headlineFont: string;
  tone: string;
  niche: string;
  musicQuery: string;
  /** BCP-47. Sent as both `snippet.defaultLanguage` and
   *  `snippet.defaultAudioLanguage` — see the column's comment in
   *  schema.prisma for why one value covers both. */
  language: string;
  /** YouTube's numeric category id as a string, e.g. `"27"`. */
  categoryId: string;
  /**
   * The channel's audience declaration, sent as
   * `status.selfDeclaredMadeForKids` on every upload it makes — the video and
   * every short cut from it. See the column's comment in schema.prisma: this
   * is a COPPA declaration, so it is read from the channel rather than
   * decided anywhere in the publish path.
   */
  madeForKids: boolean;
  /**
   * The ElevenLabs voice this channel narrates in — always a usable id, never
   * null. A channel that has never chosen one resolves to
   * `env.ELEVENLABS_VOICE_ID`, which is the single voice every video in this
   * app used before the column existed, so `voiceover.service.ts` has one
   * value to pass to the provider and no fallback of its own to get wrong.
   */
  voiceId: string;
  /**
   * The name that voice had when it was chosen, or null when the channel is on
   * the deployment default (whose name is not this table's to know — see
   * `KNOWN_VOICE_NAMES` in voiceover.service.ts) or when the picker had no
   * name to record. Display only.
   */
  voiceName: string | null;
}

/**
 * What a channel with no brand row gets, and — for the two publishing columns
 * — what a brand row created before those columns existed already got from
 * the migration's own `DEFAULT`. The two must agree: a channel that has never
 * been branded and a channel branded before this feature shipped publish
 * identically, and neither needs the operator to do anything.
 *
 * The branding half is chosen to be unremarkable rather than distinctive: a
 * default that looks like a deliberate design would be worn by every channel
 * that never set one.
 */
const FALLBACK = {
  primaryColour: "#FFFFFF",
  secondaryColour: "#000000",
  headlineFont: "DejaVu Sans",
  tone: "clear and factual",
  niche: "general interest",
  musicQuery: "calm ambient instrumental",
  // The publishing pair lives in youtube-categories.ts, because the dialog
  // that edits it is a client component and this module is `server-only`.
  ...PUBLISHING_DEFAULTS,
  /**
   * The one fallback here that is read from the environment rather than
   * written down, and it has to be: this is the voice every video this app has
   * ever narrated used, so the value that keeps an untouched channel sounding
   * unchanged is whatever that deployment is configured with — not a voice id
   * hardcoded in this file, which would be an assertion about somebody's
   * ElevenLabs account.
   */
  voiceId: env.ELEVENLABS_VOICE_ID,
} as const;

/**
 * A channel's brand as the screen that edits it needs to see it, which is not
 * the same shape a render needs (`ResolvedBrand` above).
 *
 * Two differences, both deliberate. `tone`, `niche` and `musicQuery` are
 * nullable here: a form has to distinguish "the operator chose this" from
 * "nobody has ever chosen, so the fallback applies", and a render never does.
 * And `videoStyle` is absent, because this screen does not edit it — the
 * colours, font, tone, niche and music query are the brand; `videoStyle` is
 * the render's own dials, has no editor yet, and would be silently blanked by
 * any write that pretended to include it.
 */
export interface ChannelBranding extends PublishingDefaults {
  /** The storage path of the chosen logo, or null. Written by
   *  `LogoService.choose`, never by `updateBranding`. */
  logoPath: string | null;
  /** Who the recurring character is, in the operator's own words. Null means
   *  never written — which for an ILLUSTRATED channel is a state that has to
   *  be fixed before any video can collect footage, so the screen says so
   *  rather than showing an empty box. */
  characterBrief: string | null;
  /** The storage path of the generated character sheet, or null. Written by
   *  `CharacterService.generateSheet`, never by `updateBranding` — the same
   *  arrangement as `logoPath`, for the same reason. */
  characterSheetPath: string | null;
  primaryColour: string;
  secondaryColour: string;
  headlineFont: string;
  /** Null means "never set" — the screen shows the fallback as a placeholder. */
  tone: string | null;
  niche: string | null;
  musicQuery: string | null;
  /**
   * Null where `ResolvedBrand.voiceId` is never null, and for the same reason
   * the three prompt fields differ between the two shapes: the picker has a
   * "use the default voice" option, and it can only be shown as *chosen*
   * rather than as a voice the operator appears to have picked from the list
   * if the screen can tell "nobody has chosen" from "this id was chosen".
   */
  voiceId: string | null;
  /** The name recorded beside `voiceId`, so a saved voice can be named on the
   *  screen even when ElevenLabs cannot be reached to list it. */
  voiceName: string | null;
  /** Null for a channel with no brand row, which the screen reports as
   *  "never saved" rather than inventing a date. */
  updatedAt: Date | null;
}

/** Which of the three honest answers the picker is being given. `ok` with an
 *  empty list is a real answer — an account with no voices — and is not the
 *  same as either failure. */
export type VoiceListStatus =
  /** Fetched. `voices` is what the account actually has, empty or not. */
  | "ok"
  /** No ElevenLabs credential is stored, so there was nothing to ask with. */
  | "no-credential"
  /** A credential exists and ElevenLabs did not answer usefully. */
  | "unavailable";

export interface VoiceList {
  voices: SpeechVoice[];
  status: VoiceListStatus;
}

export interface VideoCategoryList {
  categories: VideoCategory[];
  /**
   * False when YouTube could not be reached and `CURATED_CATEGORIES` is what
   * is being shown instead. The dialog says so rather than presenting a
   * stale list as authoritative — the assignable set is region-dependent, and
   * an unassignable id costs the operator the video (videos.insert answers
   * 400 after the upload, and the failed Publication row blocks the retry).
   */
  live: boolean;
  /** The region the list was resolved for, so the dialog can name it. */
  regionCode: string;
}

/**
 * Where the category list is resolved for when the channel's own country is
 * unknown — either YouTube did not answer the `channels.list` call, or the
 * channel has no country set, which is common.
 *
 * US rather than a guess from the operator's browser: it is the region whose
 * assignable set is the broadest of the ones YouTube publishes, so falling
 * back to it never *hides* a category the channel could have used. A category
 * assignable in US but not in the channel's real region is the residual risk,
 * and it is the reason the default is 27 — Education is assignable
 * everywhere.
 */
const FALLBACK_REGION = "US";

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
/**
 * The columns the branding screen reads, exactly as selected from the row, or
 * `null` for a channel that has no row at all.
 */
type StoredBranding = {
  logoPath: string | null;
  primaryColour: string | null;
  secondaryColour: string | null;
  headlineFont: string | null;
  tone: string | null;
  niche: string | null;
  musicQuery: string | null;
  language: string;
  categoryId: string;
  madeForKids: boolean;
  footageStyle: PublishingDefaults["footageStyle"];
  characterBrief: string | null;
  characterSheetPath: string | null;
  voiceId: string | null;
  voiceName: string | null;
  updatedAt: Date;
} | null;

/** The columns `getBranding` and `updateBranding` both read back, named once so
 *  the two cannot select different sets and hand `toBranding` different rows. */
const BRANDING_SELECT = {
  logoPath: true,
  primaryColour: true,
  secondaryColour: true,
  headlineFont: true,
  tone: true,
  niche: true,
  musicQuery: true,
  language: true,
  categoryId: true,
  madeForKids: true,
  footageStyle: true,
  characterBrief: true,
  characterSheetPath: true,
  voiceId: true,
  voiceName: true,
  updatedAt: true,
} as const;

/**
 * One mapping from stored columns to `ChannelBranding`, shared by the read and
 * the write so the values an operator sees after saving are the same ones a
 * reload would show them. Two copies of this drifted apart is precisely how a
 * settings screen ends up displaying something the database does not hold.
 *
 * The colours and the font resolve to their fallbacks; the three prompt fields
 * stay null. See `getBranding` for why the two halves are treated differently.
 */
function toBranding(brand: StoredBranding): ChannelBranding {
  return {
    logoPath: brand?.logoPath ?? null,
    primaryColour: brand?.primaryColour ?? FALLBACK.primaryColour,
    secondaryColour: brand?.secondaryColour ?? FALLBACK.secondaryColour,
    headlineFont: brand?.headlineFont ?? FALLBACK.headlineFont,
    tone: brand?.tone ?? null,
    niche: brand?.niche ?? null,
    musicQuery: brand?.musicQuery ?? null,
    language: brand?.language ?? PUBLISHING_DEFAULTS.language,
    categoryId: brand?.categoryId ?? PUBLISHING_DEFAULTS.categoryId,
    madeForKids: brand?.madeForKids ?? PUBLISHING_DEFAULTS.madeForKids,
    footageStyle: brand?.footageStyle ?? PUBLISHING_DEFAULTS.footageStyle,
    characterBrief: brand?.characterBrief ?? null,
    // Read-only on this shape, like `logoPath`: written by
    // `CharacterService.generateSheet`, never by `updateBranding`, because it
    // names an object in storage rather than something an operator types.
    characterSheetPath: brand?.characterSheetPath ?? null,
    voiceId: brand?.voiceId ?? null,
    // Never a name without an id. The column pair is written together and
    // cleared together, but a row edited by hand could hold one without the
    // other, and a picker showing a name against no selection is worse than
    // showing nothing.
    voiceName: brand?.voiceId ? (brand.voiceName ?? null) : null,
    updatedAt: brand?.updatedAt ?? null,
  };
}

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
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    /** The speech provider the voice picker is populated from. Injectable for
     *  the same reason `fetchImpl` is, and with one extra edge: the real
     *  provider's other method spends the operator's ElevenLabs allowance, so
     *  no test may ever be one mistake away from calling it. */
    private readonly speechProvider: SpeechProvider = elevenLabsProvider,
  ) {}

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
      // `?.` and `??` for three NOT NULL columns is not belt-and-braces:
      // `brand` is null for a channel with no row at all, and `findBrand` also
      // returns null when the lookup itself failed. Both land here, and both
      // have to publish rather than send YouTube `undefined`.
      language: brand?.language ?? FALLBACK.language,
      categoryId: brand?.categoryId ?? FALLBACK.categoryId,
      // Falls back to false, which is what every upload declared before this
      // column existed — never to true. A lookup that failed is not evidence
      // a channel is child-directed, and this fallback is reached by the
      // *error* path as well as the no-row path.
      madeForKids: brand?.madeForKids ?? FALLBACK.madeForKids,
      // Where narration stops being one voice for the whole deployment. The
      // fallback is reached by three routes that must all sound the same as
      // they did before this column existed: a channel with no brand row, a
      // brand row whose `voiceId` was never set, and a lookup that failed.
      voiceId: brand?.voiceId ?? FALLBACK.voiceId,
      // Only ever the name of a *chosen* voice. A channel on the fallback has
      // no name here — see `KNOWN_VOICE_NAMES` in voiceover.service.ts, which
      // is the one place that knows what the deployment default is called.
      voiceName: brand?.voiceId ? (brand.voiceName ?? null) : null,
    };
  }

  /**
   * Everything the branding screen edits, for one channel.
   *
   * Scoped to the operator — every other read in this service takes a
   * `channelId` that a *caller* has already proven ownership of (rendering a
   * video it owns), while this one is reached straight from a URL. A channel
   * belonging to somebody else is `NotFoundError`, not defaults: silently
   * showing `en`/`27` for a foreign id would let an operator discover which
   * channel ids exist.
   *
   * Unlike `resolve()`, the three prompt fields come back as `null` when the
   * column is null rather than filled in with the fallback. The distinction is
   * the whole difference between the two callers: a render needs *a* tone and
   * must never be handed nothing, while a form needs to know whether the
   * operator has ever chosen one — so it can show the fallback as a
   * placeholder the operator can clear back to instead of as a value they
   * appear to have typed. The colours and the font are resolved the other way,
   * to their fallbacks, because their controls cannot represent "unset": a
   * colour input has to be *some* colour, and it may as well be the one the
   * thumbnail would actually draw.
   */
  async getBranding(userId: string, channelId: string): Promise<ChannelBranding> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: {
        brand: { select: BRANDING_SELECT },
      },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    return toBranding(channel.brand);
  }

  /**
   * Every channel's publishing pair in one query, keyed by channel id, for the
   * channels list — which would otherwise do one lookup per card.
   *
   * Only channels that *have* a brand row appear. The page fills the rest in
   * from `PUBLISHING_DEFAULTS`, which is the same answer `resolve()` and
   * `getPublishingDefaults()` give for a channel without one, so a card and a
   * publish agree about an unbranded channel.
   */
  async listPublishingDefaults(
    userId: string,
  ): Promise<Record<string, PublishingDefaults>> {
    const brands = await prisma.channelBrand.findMany({
      where: { channel: { userId, deletedAt: null } },
      select: {
        channelId: true,
        language: true,
        categoryId: true,
        madeForKids: true,
        footageStyle: true,
      },
    });

    return Object.fromEntries(
      brands.map(({ channelId, language, categoryId, madeForKids, footageStyle }) => [
        channelId,
        { language, categoryId, madeForKids, footageStyle },
      ]),
    );
  }

  /**
   * The branding screen's one write, for the ten columns it edits.
   *
   * One method and one upsert rather than one per group, because the screen
   * has one Save. Splitting it would mean a channel could come out of a failed
   * save with new colours and an old audience declaration, and no way to see
   * which half landed. `videoStyle` and `logoPath` are deliberately absent:
   * the first is not edited here at all, and the second is written by
   * `LogoService.choose` at the moment an option is picked, so naming it on
   * the `update` branch would let a Save that happened to be in flight put the
   * previous logo back.
   *
   * Upserts rather than updates, exactly as `LogoService.choose` does and for
   * the same reason: most channels have no `ChannelBrand` row at all, and
   * opening this screen and pressing Save is as likely to be the first
   * branding action an operator takes as choosing a logo is. The `create`
   * branch names only these columns, so every other brand field lands on its
   * own schema default.
   *
   * `madeForKids` is written from the input on both branches rather than only
   * when it changed. It is the one field here whose value is a declaration
   * rather than a preference, and "the operator opened this screen, read the
   * question and pressed save" is exactly the event that should record it.
   *
   * `tone`, `niche` and `musicQuery` arrive as `string | null` and null is
   * written through as null, which is how a field is cleared back to the
   * documented fallback — see `promptText` in channel.schema.ts.
   */
  async updateBranding(
    userId: string,
    input: UpdateBrandingInput,
  ): Promise<ChannelBranding> {
    const { channelId, ...fields } = input;

    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    // The name is not independently settable: it describes `voiceId`, and a
    // save that clears the voice back to the deployment default must not leave
    // the previous voice's name behind for the narration library to print
    // against the new one. Normalised here, at the write, rather than trusted
    // from the form — the schema can bound the two strings but it cannot know
    // that one is meaningless without the other.
    const written = {
      ...fields,
      voiceName: fields.voiceId ? fields.voiceName : null,
    };

    const brand = await prisma.channelBrand.upsert({
      where: { channelId },
      create: { channelId, ...written },
      update: written,
      select: BRANDING_SELECT,
    });

    return toBranding(brand);
  }

  /**
   * The voices the operator's own ElevenLabs account can narrate with.
   *
   * Fetched, never hardcoded, and this is the field where that rule matters
   * most. Which voices exist is a fact about one account: a curated list would
   * offer voices this account may not have, and a voice it does not have is
   * not a cosmetic mistake — it is a narration that fails after the operator
   * has already saved the channel and queued a video. So when the list cannot
   * be fetched the answer is "we could not ask", not a shorter list of
   * plausible ids.
   *
   * Takes no `channelId`, unlike `listCategories`, because there is nothing
   * channel-shaped about the answer: the credential is the operator's, the
   * same list serves every channel they own, and adding an id to check would
   * be an ownership check on a value that plays no part in the query. Scoping
   * is `resolveKey(userId, …)` itself — it reads only this operator's row, so
   * two operators with different keys cannot see each other's voices, and an
   * operator with no key sees none.
   *
   * The key is resolved, put in a request header by the provider, and dropped.
   * It is not returned, not logged, and not part of any error: the catch below
   * records only the provider's own key-free message.
   *
   * Never throws. This is a picker on a screen with nine other controls, and
   * an ElevenLabs outage must not be the reason an operator cannot change
   * their channel's colours — or, worse, cannot save at all, which would put
   * the voice they already have at risk.
   */
  async listVoices(userId: string): Promise<VoiceList> {
    const apiKey = await providerCredentialService.resolveKey(userId, "ELEVENLABS");

    if (!apiKey) {
      return { voices: [], status: "no-credential" };
    }

    if (!this.speechProvider.listVoices) {
      return { voices: [], status: "unavailable" };
    }

    try {
      return { voices: await this.speechProvider.listVoices(apiKey), status: "ok" };
    } catch (error) {
      console.error(
        "brandService.listVoices: could not list ElevenLabs voices: " +
          (error instanceof Error ? error.message : String(error)),
      );

      return { voices: [], status: "unavailable" };
    }
  }

  /**
   * The categories YouTube will actually accept for this channel.
   *
   * Fetched, not hardcoded. `videoCategories.list` is the only authority on
   * which ids are `assignable`, that set is region-dependent, and getting it
   * wrong is expensive in a way that is easy to underestimate:
   * `videos.insert` rejects an unassignable id with a 400 *after* the whole
   * file has been uploaded, `publish()` then marks the video FAILED, and the
   * `Publication` row it deliberately keeps blocks every retry. A guessed
   * list would cost the operator the video.
   *
   * The token is the channel's own — the same one the upload itself uses, via
   * the same `resolveAccessToken` — so no new credential, scope or key is
   * involved. Both calls cost 1 quota unit against the 10,000/day the upload
   * spends 1,600 of.
   *
   * Never throws. A failure here must not stop the operator editing the
   * *language*, which is the other half of the same dialog and needs no
   * network at all, so an unreachable API degrades to `CURATED_CATEGORIES`
   * with `live: false` and the dialog says as much.
   */
  async listCategories(
    userId: string,
    channelId: string,
  ): Promise<VideoCategoryList> {
    let regionCode = FALLBACK_REGION;

    try {
      const accessToken = await channelService.resolveAccessToken(userId, channelId);

      regionCode = (await this.resolveRegion(accessToken)) ?? FALLBACK_REGION;

      const response = await this.fetchImpl(
        `https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=${regionCode}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (!response.ok) {
        throw new Error(`videoCategories.list answered ${response.status}`);
      }

      const body = (await response.json()) as {
        items?: {
          id?: string;
          snippet?: { title?: string; assignable?: boolean };
        }[];
      };

      const categories = (body.items ?? [])
        // `assignable: false` categories are returned by the same call and are
        // the ones that produce the 400 above — YouTube lists them so old
        // videos filed under them can still be *read*, not so new ones can be
        // filed there.
        .filter((item) => item.snippet?.assignable === true)
        .flatMap((item) =>
          item.id && item.snippet?.title
            ? [{ id: item.id, title: item.snippet.title }]
            : [],
        )
        .sort((a, b) => a.title.localeCompare(b.title));

      // An empty list is a failure dressed as a success — a picker with no
      // options cannot be used, and the curated list is strictly better than
      // nothing.
      if (categories.length === 0) {
        throw new Error("videoCategories.list returned no assignable categories");
      }

      return { categories, live: true, regionCode };
    } catch (error) {
      console.error(
        `brandService.listCategories: falling back to the curated list for channel ` +
          `${channelId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );

      return {
        categories: [...CURATED_CATEGORIES],
        live: false,
        regionCode,
      };
    }
  }

  /**
   * The channel's own country, which is what makes the category list the
   * right one rather than an approximation. `mine=true` resolves to whichever
   * channel the token belongs to, so no id has to be passed and no other
   * channel can be read.
   *
   * Returns null — not a throw — for every "we simply don't know" case: a
   * channel with no country set is ordinary, not an error, and the caller has
   * a documented region to fall back to. A genuine transport failure does
   * throw, and is caught by the caller together with the list call it was
   * about to make anyway.
   */
  private async resolveRegion(accessToken: string): Promise<string | null> {
    const response = await this.fetchImpl(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as {
      items?: { snippet?: { country?: string } }[];
    };

    return body.items?.[0]?.snippet?.country ?? null;
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
