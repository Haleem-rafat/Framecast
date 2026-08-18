import "server-only";

import { env } from "@/config/env";
import type { FootageStyle, VideoFormat } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  composeArtStyle,
  composeCinematicShot,
  findArtStyle,
  type ArtStyle,
} from "@/lib/art-styles";
import { beatAssetPath, beatClipPath, beatImagePath, beatPrefix } from "@/lib/beat-storage";
import { anchorCues, type AnchoredCue, type ScriptCue } from "@/lib/script-cues";
import { planStoryBeats, type StoryBeat } from "@/lib/story-beats";
import { getObject, putObject, storagePath } from "@/lib/storage";
import { gatewayImageProvider } from "@/services/providers/image.provider";
import {
  pexelsProvider,
  pixabayCartoonProvider,
  pixabayProvider,
} from "@/services/providers/stock-footage.provider";
import type {
  ImageProvider,
  StockClip,
  StockFootageProvider,
  StockFootageSource,
} from "@/services/providers/types";
import { formatBytes, formatElapsed } from "@/utils/format";

export interface CollectFootageResult {
  clipCount: number;
  bySource: Record<string, number>;
  /** Bytes downloaded and stored by *this* call — zero on an idempotent
   * re-run that found nothing new to fetch. */
  bytesDownloaded: number;
  /**
   * Beats (1-based, as an operator counts them) that finished this call with
   * no picture, because the model failed or refused.
   *
   * Empty on every stock-footage path and on a clean illustrated run. Present
   * rather than merely logged because a refusal is not the same event as a
   * stock search coming back empty: nothing downstream can substitute for it,
   * `render.service.ts` will refuse the video rather than play the pictures
   * out of step with the words, and the operator needs to know *which* beat
   * before they decide whether to re-run or reword. Silently skipping is the
   * one outcome that produces a finished-looking video with a hole in it.
   */
  missingBeats: number[];
  /** What this call spent on generation, from the provider's own token counts.
   * Zero for every stock path — Pexels, Pixabay and Jamendo are free. */
  costUsd: number;
}

/**
 * Reports a human-readable line as each sub-step of a collection run
 * finishes. Never called with anything the caller needs to parse — this is
 * for a human watching output, not a machine. Defaults to a no-op so
 * `footageService` stays silent when called from the web app, where writing
 * to stdout would be the wrong medium entirely; the CLI (`scripts/render.ts`)
 * is what turns these into printed lines.
 */
export type FootageProgress = (message: string) => void;

const noopProgress: FootageProgress = () => {};

/** Times a search call and reports its result count without changing its
 * fulfil/reject behaviour — the caller still sees the original promise
 * settle exactly as it would have, so wrapping this around `provider.search`
 * inside `Promise.allSettled` is transparent. */
function reportSearch(
  label: string,
  search: Promise<StockClip[]>,
  onProgress: FootageProgress,
): Promise<StockClip[]> {
  const startedAt = Date.now();
  return search.then(
    (clips) => {
      onProgress(`searching ${label} … ${clips.length} results (${formatElapsed(Date.now() - startedAt)})`);
      return clips;
    },
    (error: unknown) => {
      onProgress(`searching ${label} … failed (${formatElapsed(Date.now() - startedAt)})`);
      throw error;
    },
  );
}

/** Runs a per-cue search and treats a failure as "no results" for that cue
 * rather than aborting the whole video: with one search per section instead
 * of one per video (see `collectPerCue`), a single transient error from one
 * provider on one section must not cost every other section its clip. This
 * does not hide a genuine outage — if a provider is truly unreachable or
 * unconfigured, every cue's search fails the same way, and the first cue
 * that has to fall all the way through to `getTopicPool` surfaces it there,
 * because that fallback still throws when both sources fail (see its own
 * comment). It just takes one extra tier to come up. */
async function searchOrEmpty(
  label: string,
  search: Promise<StockClip[]>,
  onProgress: FootageProgress,
): Promise<StockClip[]> {
  try {
    return await reportSearch(label, search, onProgress);
  } catch {
    return [];
  }
}

/** The first candidate not already spent on an earlier section of this same
 * video — walking the list rather than only ever looking at index 0 is what
 * stops two cues whose searches both surface the same top result from
 * silently repeating a picture (see the "never uses the same stock clip for
 * two different cues" test). */
function firstUnused(
  clips: StockClip[],
  usedExternalIds: ReadonlySet<string>,
): StockClip | undefined {
  return clips.find((clip) => !usedExternalIds.has(clip.externalId));
}

/** Round-robins every provider's results into one list, first plan entry
 * first each round — the same alternation `collect()`'s topic-level path
 * already uses, and for the same reason (see this class's own doc comment:
 * "so one provider's stock look never dominates a video").
 * `collectPerCue`'s topic fallback pool draws from the same sources and
 * should look the same way rather than favouring whichever source happened
 * to come first in a plain concatenation.
 *
 * Takes a list of pools rather than the two named ones it used to, because
 * how many pools there are is now the channel's decision: a CARTOON channel
 * has exactly one (see `FOOTAGE_SEARCH_PLAN`), and with one pool this
 * degenerates to "the pool, in order", which is the right answer. */
function interleave(pools: readonly StockClip[][]): StockClip[] {
  const merged: StockClip[] = [];
  const length = Math.max(0, ...pools.map((pool) => pool.length));

  for (let i = 0; i < length; i++) {
    for (const pool of pools) {
      if (i < pool.length) merged.push(pool[i]);
    }
  }

  return merged;
}

/** The index, among everything already assigned a clip for this video (this
 * call's own picks so far, plus every earlier call's), that sits closest to
 * `index` — ties broken toward the lower index, just so the choice is
 * deterministic rather than dependent on `Map` iteration order. Used once a
 * section can't get its own footage — the unique-download cap has been
 * spent, or nothing turned up anywhere for its own cue — so it can reuse
 * whatever's nearest and stay roughly on-topic instead of leaving a gap. */
function nearestAssignedIndex(
  index: number,
  assignedByIndex: ReadonlyMap<number, unknown>,
): number | undefined {
  let nearest: number | undefined;
  let bestDistance = Infinity;

  for (const candidate of assignedByIndex.keys()) {
    const distance = Math.abs(candidate - index);
    if (
      distance < bestDistance ||
      (distance === bestDistance && (nearest === undefined || candidate < nearest))
    ) {
      nearest = candidate;
      bestDistance = distance;
    }
  }

  return nearest;
}

/**
 * One searchable provider slot. Deliberately not the same thing as
 * `StockFootageSource`, which is what gets written to `Asset.provider` and
 * has to stay a value of the `AiProviderType` enum: `PIXABAY_CARTOON` is the
 * *same Pixabay account, key and licence* asked a different question, so the
 * clips it returns are still tagged `PIXABAY`. Two slots, one source.
 */
export type FootageProviderKey = "PEXELS" | "PIXABAY" | "PIXABAY_CARTOON";

export type FootageProviders = Record<FootageProviderKey, StockFootageProvider>;

/** For progress lines only — never parsed. */
const PROVIDER_LABEL: Record<FootageProviderKey, string> = {
  PEXELS: "Pexels",
  PIXABAY: "Pixabay",
  PIXABAY_CARTOON: "Pixabay (cartoon)",
};

/**
 * Where a channel's pictures come from, and in what order.
 *
 * This is the whole of the per-channel footage feature: everything below
 * iterates a plan rather than naming Pexels and Pixabay, so choosing a style
 * on a channel changes which searches happen and nothing else.
 *
 * ILLUSTRATED is the third entry and it is a different *kind* of plan rather
 * than a shorter list of providers, which is why this is a tagged union now.
 * It exists because CARTOON does not work for children's content and cannot be
 * made to. Pixabay's `video_type=animation` filter means "rendered rather than
 * filmed", not "drawn for children": a 64-second kids video generated with it
 * came back with abstract 3D hexagon motion graphics at twenty seconds and a
 * live-action lavender field at forty-eight. Query tuning cannot fix that,
 * because the real defect is structural — **stock cannot give you the same
 * character in scene 1 and scene 40**, and a recurring character is the entire
 * basis of the genre. The only way to get one is to generate the pictures, so
 * that is what this plan does.
 *
 * CARTOON lists exactly one provider, and the omission is the point. A
 * children's channel that could not find a cartoon must end up with *no
 * clip* for that section, not a live-action one — see `collectPerCue`'s last
 * `if (!picked)`, which already skips rather than substituting. Making that
 * guarantee structural (there is no live-action provider in the plan to fall
 * through to) rather than a conditional somewhere is what stops a later edit
 * quietly reintroducing it. Pexels is absent because it has nothing to offer
 * here: its video API exposes no content-type filter at all, so there is no
 * way to ask it for animation, and its library is live-action first.
 */
export type FootagePlan =
  /** Search these providers, in this order. */
  | { readonly kind: "STOCK"; readonly providers: readonly FootageProviderKey[] }
  /** Search nobody. Generate one illustration per story beat, every one of
   *  them conditioned on the channel's character sheet. */
  | { readonly kind: "ILLUSTRATED" }
  /**
   * Search nobody either, and condition on nothing.
   *
   * The same generation machinery as `ILLUSTRATED` — same beats, same
   * idempotency, same per-beat failure reporting — with the character sheet
   * removed rather than made optional. The single-insight format wants a
   * different unnamed person in every shot with only the grade and the lens
   * held constant, so there is no sheet to pass and no brief to write; see
   * `CINEMATIC_STYLE_BIBLE`.
   */
  | { readonly kind: "CINEMATIC" }
  /**
   * Generate most of the shots and search for the rest, inside one video.
   *
   * The first plan whose sources are not a property of the channel at all: the
   * split is per beat and it comes from the script, because the writer of the
   * long-form list format tags every section `still` or `motion` (see
   * `CueMeta.shot`). That is why this arm carries no provider list of its own
   * to sit beside `STOCK`'s — there is no per-channel choice here to record.
   * Which providers a motion shot searches is `MIXED_STOCK_PROVIDERS` below,
   * and it is a constant for the reason stated there.
   */
  | { readonly kind: "MIXED" };

export const FOOTAGE_SEARCH_PLAN: Record<FootageStyle, FootagePlan> = {
  LIVE_ACTION: { kind: "STOCK", providers: ["PEXELS", "PIXABAY"] },
  CARTOON: { kind: "STOCK", providers: ["PIXABAY_CARTOON"] },
  ILLUSTRATED: { kind: "ILLUSTRATED" },
  CINEMATIC: { kind: "CINEMATIC" },
  MIXED: { kind: "MIXED" },
};

/**
 * Where a MIXED video's `motion` shots are searched for.
 *
 * The live-action pair, and a constant rather than a field on the plan because
 * there is nothing here for an operator to decide. A motion shot exists because
 * the writer judged that these particular words are about something *moving* —
 * a wave breaking, a crowd crossing, a machine running — and filmed footage is
 * the only kind of stock that answers that. Pixabay's animation library is
 * absent for the same reason it is absent from LIVE_ACTION's plan: it means
 * "rendered rather than filmed", and a motion-graphics loop dropped between two
 * generated stills is the one substitution this style must never make.
 */
const MIXED_STOCK_PROVIDERS: readonly FootageProviderKey[] = ["PEXELS", "PIXABAY"];

/** How each generating style names itself in a refusal an operator reads. A
 *  map rather than a ternary because there are three of them now, and the
 *  third one's word is neither of the other two's. */
const GENERATED_STYLE_NOUN: Record<"ILLUSTRATED" | "CINEMATIC" | "MIXED", string> = {
  ILLUSTRATED: "Illustrated",
  CINEMATIC: "Cinematic",
  MIXED: "Mixed",
};

/**
 * Pixels asked of the model for each format.
 *
 * `gpt-image-2` offers 1024x1024, 1024x1536 and 1536x1024 — nothing matches a
 * 1080x1920 or 1920x1080 frame exactly, and nothing needs to. The renderer
 * scales with `force_original_aspect_ratio=increase` and then pans across the
 * margin, so what matters is the *shape*: 1024x1536 is 2:3 against the frame's
 * 9:16, close enough that the centre crop keeps almost the whole picture, and
 * the upscale to 1242x2208 (frame x the 1.15 motion scale) is 1.21x — well
 * inside what a watercolour illustration survives without visible softening.
 */
const ILLUSTRATION_SIZE: Record<VideoFormat, `${number}x${number}`> = {
  LANDSCAPE: "1536x1024",
  VERTICAL: "1024x1536",
};

/** How much of a beat's narration goes into its prompt. Enough to describe a
 *  scene, short enough that the character sheet and the art direction are not
 *  drowned out by a paragraph of plot. */
const BEAT_CUE_MAX_LENGTH = 400;

/**
 * What one beat's picture should show.
 *
 * Built from the beat's own cues — the same b-roll cues a stock search would
 * have used, which are already one-line descriptions of what to show while
 * those words are read. Joined rather than reduced to the first, because a
 * beat covers two or three sections and the picture has to hold the screen
 * across all of them.
 *
 * The last paragraph is doing real work. Handed a reference sheet, the model's
 * most natural reading of "draw this character" is to draw another reference
 * sheet — three poses on a plain background — which is exactly what a video
 * must not cut to. Saying so explicitly is the difference between a scene and
 * a turnaround.
 */
export function beatIllustrationPrompt(input: {
  cues: readonly string[];
  brief: string;
  style: ArtStyle;
  tone: string | null;
  hasSheet: boolean;
}): string {
  const scene = input.cues.join(". ").slice(0, BEAT_CUE_MAX_LENGTH);

  return [
    input.hasSheet
      ? "Using the attached character reference sheet, draw ONE new scene illustration " +
        "featuring exactly the same character, identical in every detail — same colours, " +
        "same markings, same clothing, same face."
      : "Draw one scene illustration for a children's picture book.",
    "",
    `The character: ${input.brief}`,
    "",
    `The scene: ${scene}`,
    "",
    composeArtStyle(input.style),
    input.tone ? `Tone: ${input.tone}.` : "",
    "",
    "A single full-bleed scene filling the whole frame, as one page of a picture book.",
    "Do NOT draw a reference sheet, a turnaround, multiple poses, panels, borders or a",
    "plain background. No text, no words, no letters, no captions, no watermark.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Separate from `StockFootageProvider.search` so tests can inject a
 * network-free downloader without needing a fetchable clip URL, matching
 * the "providers are injected so tests never hit the network" rule. */
export type ClipDownloader = (clip: StockClip) => Promise<Buffer>;

async function fetchClip(clip: StockClip): Promise<Buffer> {
  let response: Response;

  try {
    response = await fetch(clip.url);
  } catch (cause) {
    // No status code to classify by — the request never reached the CDN.
    throw new ProviderError(
      clip.source,
      `Could not download clip ${clip.externalId} from ${clip.source}.`,
      true,
      { cause },
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      clip.source,
      `Downloading clip ${clip.externalId} from ${clip.source} failed with status ${response.status} ${response.statusText}.`,
      response.status === 429 || response.status >= 500,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Roughly one clip's worth of screen time before the footage starts feeling static. */
const SECONDS_PER_CLIP = 12;
/** Padding beyond exact coverage so the render's last clip isn't cut short — see Task 6. */
const EXTRA_CLIPS = 2;

// Uncapped, `ceil(duration / SECONDS_PER_CLIP) + EXTRA_CLIPS` grows without
// limit — a real ~7-minute video needed 38 *unique* clips, which took 11m51s
// and 218MB to fetch (see render-oom-report.md). A video with no cues is
// rendered by dividing the narration equally between whatever clips it has
// (render.service.ts), so a shorter pool means each clip simply holds the
// screen longer rather than the render coming up short: capping the unique
// pool at MAX_UNIQUE_CLIPS cuts download time and storage by roughly two
// thirds and costs only screen time per clip. At the cap, a ~7-minute
// narration gives each of the twelve about 35s — noticeably static, but this
// path only serves scripts written before b-roll cues existed, whose clips
// don't match the narration's content anyway. Do not raise this back up to
// "unique clip per slot" without also solving the unbounded fetch
// time/memory it reintroduces.
const MAX_UNIQUE_CLIPS = 12;

// Same incident, reached through a different door. `collectPerCue` searches
// once per section instead of once per video, and a section runs 20-25
// words — so a ~7-minute script (the same one that needed 38 unique clips
// above) produces on the order of 50 sections. Fetching a unique clip for
// every one of them would reproduce the exact unbounded-fetch failure
// MAX_UNIQUE_CLIPS exists to prevent (11m51s, 218MB, see
// render-oom-report.md), just via the per-cue path instead of the
// topic-level one. Once this many distinct clips have been downloaded for a
// video, every further section reuses an already-collected one instead of
// searching or downloading again (see `collectPerCue` and
// `nearestAssignedIndex`) — most sections still get footage matched to
// their own cue, and the run stays bounded no matter how long the script
// gets. Kept in the same spirit and rough size as MAX_UNIQUE_CLIPS rather
// than derived from it: the two caps bound different things (one shared
// pool covering an arbitrary number of render slots, vs. one clip per
// section), and there's no reason they need to move together.
const MAX_UNIQUE_SECTION_CLIPS = 20;

/** Pixabay's hard cap on search terms. Applied to the one query both sources
 * share, so Pexels' (uncapped) search stays consistent with Pixabay's. */
const QUERY_MAX_LENGTH = 100;

/** Candidates requested per cue search, not per-video like `MAX_UNIQUE_CLIPS`
 * — one section only ever needs one clip. This just has to be wide enough
 * that a top result already claimed by an earlier section still leaves
 * something for `firstUnused` to fall through to. */
const CUE_CANDIDATE_COUNT = 8;

function computeClipCount(durationSeconds: number): number {
  const target = Math.ceil(durationSeconds / SECONDS_PER_CLIP) + EXTRA_CLIPS;
  return Math.min(target, MAX_UNIQUE_CLIPS);
}

function extensionFromUrl(url: string): string {
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(new URL(url).pathname);
  return match ? match[1].toLowerCase() : "mp4";
}

/**
 * Gets this video its pictures, by whichever means its channel has asked for
 * (see `FOOTAGE_SEARCH_PLAN`).
 *
 * Two of the three are stock: Pexels and Pixabay alternating for a live-action
 * channel, Pixabay's animation library alone for a cartoon one — alternating so
 * one provider's stock look never dominates a video, and each clip stored in
 * our own bucket, because Pixabay's terms forbid permanent hotlinking and an
 * expiring CDN URL would fail mid-render.
 *
 * The third searches nobody. An ILLUSTRATED channel's pictures are generated,
 * one per story beat, every one of them conditioned on the channel's character
 * sheet — see `collectGenerated`.
 *
 * The fifth is the only one that does both inside a single video. A MIXED
 * channel generates every beat except the ones its script tagged `motion`, and
 * searches stock for those — filing both under one prefix, because the
 * renderer's only question about a picture is what its file extension is.
 */
export class FootageService {
  private readonly providers: FootageProviders;

  constructor(
    /**
     * Partial so a test can override only the slots it exercises, which is
     * every existing caller: they inject PEXELS and PIXABAY and never reach
     * the cartoon slot, because a video whose channel has no brand row is
     * LIVE_ACTION and LIVE_ACTION's plan does not contain it. A test that
     * *does* exercise a cartoon channel has to inject PIXABAY_CARTOON, or it
     * would reach the real Pixabay — which is the same "providers are
     * injected so tests never hit the network" rule the rest of this file
     * follows, just stated rather than enforced by the type.
     */
    providers: Partial<FootageProviders> = {},
    private readonly downloadClip: ClipDownloader = fetchClip,
    /**
     * Generates a channel's story illustrations. Injected for exactly the
     * reason the stock providers above are, and with more at stake: a real
     * call here is real money, and `logo.service.ts`'s tests already
     * established the pattern of handing in a fake `ImageProvider` rather
     * than mocking the module.
     */
    private readonly images: ImageProvider = gatewayImageProvider,
  ) {
    this.providers = {
      PEXELS: pexelsProvider,
      PIXABAY: pixabayProvider,
      PIXABAY_CARTOON: pixabayCartoonProvider,
      ...providers,
    };
  }

  async collect(
    userId: string,
    videoId: string,
    onProgress: FootageProgress = noopProgress,
  ): Promise<CollectFootageResult> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        topic: true,
        title: true,
        // Which shape the illustrations are generated in. Irrelevant to the
        // stock paths — a downloaded clip is whatever shape it is and the
        // renderer crops it — but a generated picture is asked for at a size,
        // and asking for a landscape one for a vertical video would throw away
        // most of it to the centre crop.
        format: true,
        voiceOver: { select: { durationSeconds: true } },
        // What the pictures should look like, and therefore which providers
        // get searched at all. Read through the video's own operator-scoped
        // row rather than via `brandService.resolve`, so it costs no second
        // query and cannot resolve a channel this operator does not own.
        // A video with no project, a project with no channel, or a channel
        // with no brand row all arrive here as null and fall back to
        // LIVE_ACTION — the same value the column defaults to, so an
        // unbranded channel collects exactly what it always has.
        //
        // The two character columns come along for the ride on the same query
        // for the same reason: they are only meaningful for ILLUSTRATED, and
        // reading them here rather than through `brandService.resolve` keeps
        // the whole decision inside one operator-scoped row.
        project: {
          select: {
            channel: {
              select: {
                brand: {
                  select: {
                    footageStyle: true,
                    characterBrief: true,
                    characterSheetPath: true,
                    artStyle: true,
                    tone: true,
                  },
                },
              },
            },
          },
        },
        // Only the active version matters: an edit that changes the section
        // boundaries makes the previous version's cues meaningless, and
        // script.service.ts already keeps the surviving ones (re-anchored)
        // on whichever version is active. See anchorCues' own doc comment
        // for why a cue that no longer matches is orphaned rather than
        // guessed at.
        script: { select: { activeVersion: { select: { content: true, cues: true } } } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // Clip count is derived from the narration's actual length, so there's
    // nothing to compute against until it exists.
    if (!video.voiceOver || video.voiceOver.durationSeconds === null) {
      throw new ConflictError(
        "Footage can only be collected once narration exists — clip count depends on its duration.",
      );
    }

    const style: FootageStyle =
      video.project?.channel?.brand?.footageStyle ?? "LIVE_ACTION";
    const plan = FOOTAGE_SEARCH_PLAN[style];

    // A script with sections gets its footage cut to the words; a script
    // without them (one written before cues existed) does not. Anchoring
    // re-derives each cue's position from the *current* content on every call
    // rather than trusting stored offsets, so an edit made since the cues were
    // written can't silently point a picture at the wrong sentence.
    //
    // Hoisted above the two branches because the illustrated path needs it
    // before it does anything at all: beats are groups of anchored cues, and
    // there is no beat to draw without them.
    const activeVersion = video.script?.activeVersion ?? null;
    const rawCues = activeVersion?.cues;
    const scriptCues = Array.isArray(rawCues) ? (rawCues as unknown as ScriptCue[]) : [];
    // Trimmed for the same reason script.service.ts and voiceover.service.ts
    // trim: the offsets these anchors produce are only meaningful against
    // the string ElevenLabs is actually sent, which is `content.trim()`.
    // Collection and render must agree on where a section starts, so this
    // has to match render.service.ts's anchoring exactly — a picture fetched
    // for one set of offsets and played against another is a picture that
    // does not match its words.
    const anchored =
      activeVersion && scriptCues.length > 0
        ? anchorCues(scriptCues, activeVersion.content.trim()).anchored
        : [];

    if (plan.kind === "ILLUSTRATED" || plan.kind === "CINEMATIC" || plan.kind === "MIXED") {
      return this.collectGenerated({
        // Passed rather than re-derived: `collectGenerated` branches on it for
        // the character sheet and for the prompt, and re-reading the brand row
        // inside it would be a second chance to disagree with the plan chosen
        // here.
        kind: plan.kind,
        videoId,
        anchored,
        durationSeconds: video.voiceOver.durationSeconds,
        format: video.format,
        brand: video.project?.channel?.brand ?? null,
        onProgress,
      });
    }

    // Assets carry no direct videoId column — every object (and therefore
    // every Asset that references one) lives under `videos/{videoId}/...`,
    // so the storage prefix is the scoping key. Matches render.service.ts's
    // (Task 6) own clip lookup, the one convention for scoping an Asset to
    // its video.
    //
    // Since MIXED, this prefix can also match a beat's stock clip under
    // `beats/` — reachable only by collecting a mixed video and then switching
    // its channel to a stock style and collecting again. Deliberately not
    // filtered out: the two or three clips it over-counts only make this run
    // download that many fewer, and the render would play the beats anyway
    // (see render.service.ts, which asks what collection produced rather than
    // what the channel is set to). A `NOT: { startsWith: beatPrefix }` here
    // would be a second place that has to know how beats are filed, for a
    // state nothing downstream is harmed by.
    const existing = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      select: { provider: true, externalId: true, storagePath: true },
    });

    const usedExternalIds = new Set(
      existing
        .map((asset) => asset.externalId)
        .filter((externalId): externalId is string => externalId !== null),
    );
    const bySource: Record<string, number> = {};
    for (const asset of existing) {
      if (asset.provider) {
        bySource[asset.provider] = (bySource[asset.provider] ?? 0) + 1;
      }
    }

    const query = (video.topic ?? video.title).trim().slice(0, QUERY_MAX_LENGTH);

    // Said once per run, before any search, because it is the one thing about
    // this stage an operator cannot infer from the clip names that follow: a
    // cartoon channel that comes back with three clips needs to be readable
    // as "Pixabay's animation library only had three" rather than "something
    // is broken".
    onProgress(
      `footage style ${style} — searching ` +
        plan.providers.map((key) => PROVIDER_LABEL[key]).join(", "),
    );

    // A video with no script, no cues (predates this feature), or whose
    // anchors no longer resolve falls straight through to the original
    // topic-level behaviour below — that is what makes the nullable `cues`
    // column safe to ship without a backfill.
    if (anchored.length > 0) {
      return this.collectPerCue({
        videoId,
        anchored,
        query,
        plan: plan.providers,
        existing,
        usedExternalIds,
        bySource,
        onProgress,
      });
    }

    const clipCount = computeClipCount(video.voiceOver.durationSeconds);
    let total = existing.length;

    // Idempotent: a prior run already reached the target, so re-running
    // collects nothing new rather than re-downloading anything.
    if (total >= clipCount) {
      return { clipCount: total, bySource, bytesDownloaded: 0, missingBeats: [], costUsd: 0 };
    }

    const need = clipCount - total;

    // Ask each source for the full target count as a candidate pool, not
    // just `need` — some candidates will be skipped as duplicates of clips a
    // previous run already stored, and alternation needs both pools stocked
    // regardless of how many of those skips land on either side.
    //
    // allSettled, not all: a transient failure on one source (observed live
    // against Pixabay while verifying this service — a plain 503) shouldn't
    // block collection when the other source alone has enough candidates.
    // That source's pool is just empty this run; the idempotent top-up path
    // above picks up the slack on a later call once it recovers. Only if
    // every source fails does this rethrow — there's nothing left to collect
    // from.
    const results = await Promise.allSettled(
      plan.providers.map((key) =>
        reportSearch(
          `${PROVIDER_LABEL[key]} "${query}"`,
          this.providers[key].search(query, clipCount),
          onProgress,
        ),
      ),
    );

    const firstRejection = results.find((result) => result.status === "rejected");
    if (firstRejection && results.every((result) => result.status === "rejected")) {
      throw firstRejection.reason;
    }

    const pools: StockClip[][] = results.map((result) =>
      result.status === "fulfilled" ? result.value : [],
    );

    let poolIndex = 0;
    let picked = 0;
    let bytesDownloaded = 0;

    while (picked < need) {
      if (pools.every((pool) => pool.length === 0)) {
        break;
      }

      const clip = pools[poolIndex % pools.length].shift();
      poolIndex++;

      if (!clip || usedExternalIds.has(clip.externalId)) {
        continue;
      }

      const stepStartedAt = Date.now();
      const buffer = await this.downloadClip(clip);
      const filename = `${clip.source.toLowerCase()}-${clip.externalId}.${extensionFromUrl(clip.url)}`;
      const path = storagePath(videoId, "clips", filename);
      await putObject(path, buffer, "video/mp4");

      await prisma.asset.create({
        data: {
          kind: "VIDEO",
          storagePath: path,
          mimeType: "video/mp4",
          sizeBytes: BigInt(buffer.byteLength),
          provider: clip.source,
          externalId: clip.externalId,
        },
      });

      usedExternalIds.add(clip.externalId);
      bySource[clip.source] = (bySource[clip.source] ?? 0) + 1;
      total++;
      picked++;
      bytesDownloaded += buffer.byteLength;

      onProgress(
        `[${picked}/${need}] ${filename.replace(/\.[^.]+$/, "")}  ` +
          `${clip.width}x${clip.height}  ${Math.round(clip.durationSeconds)}s  ` +
          `${formatBytes(buffer.byteLength)} … stored (${formatElapsed(Date.now() - stepStartedAt)})`,
      );
    }

    return { clipCount: total, bySource, bytesDownloaded, missingBeats: [], costUsd: 0 };
  }

  /**
   * One generated picture per STORY BEAT — not per section.
   *
   * Serves all three generating styles. `ILLUSTRATED` draws a children's-book
   * scene conditioned on the channel's character sheet; `CINEMATIC` generates a
   * photographic still conditioned on nothing but the format's own style bible;
   * `MIXED` generates the same still for every beat except the ones the script
   * tagged `motion`, which it downloads instead. Everything else — the beats,
   * the idempotency, the per-beat failure reporting, the sizes, the cost
   * accounting — is identical, which is why they share a method rather than a
   * copy of one.
   *
   * The mixed path is one branch at the top of each beat and nothing more, and
   * that is the measure of how little the feature costs: both kinds are filed
   * under `beats/` and differ only by extension, so no caller and no later
   * stage has to be told which slot got which. `render.service.ts` reads the
   * prefix and `planRender` reads the extension, exactly as they already did.
   *
   * The pre-flight refusals are where they differ, and they differ completely:
   * an illustrated channel is refused without a character brief, an art style
   * and a generated sheet, because a picture drawn without them shows a
   * different protagonist every beat. A cinematic channel is refused for none
   * of those, because a different person every beat is what the format asks
   * for — see `CINEMATIC_STYLE_BIBLE`.
   *
   * That distinction is the feature. A four-minute script has about
   * twenty-seven sections, and one picture per section would be twenty-seven
   * generations at real money each, cut every nine seconds. It would also be
   * the wrong film: the measured high-performing channels in this genre hold a
   * still for 13-70 seconds with slow camera motion, and a 32-page picture book
   * — the same story at the same read-aloud length — has twelve to fourteen
   * spreads. `planStoryBeats` groups the sections into that many; see its own
   * doc comment for the arithmetic and the evidence.
   *
   * Every picture is conditioned on the channel's character sheet, passed as a
   * real input image rather than described. Without that this path produces
   * pretty pictures with a different protagonist each time, which is precisely
   * the failure the whole feature exists to avoid — so a channel with no sheet
   * is refused here rather than served a worse version of the thing it asked
   * for.
   *
   * Idempotent per beat, at the same granularity `collectPerCue` is per
   * section: a re-run generates only the beats whose image is not already on
   * disk. That is what makes a partial failure recoverable for the price of the
   * beats that actually failed, and it is why `planStoryBeats` has to be
   * deterministic.
   *
   * A beat whose generation fails or is refused is *reported*, never skipped
   * silently. Nothing can stand in for it — there is no neighbouring picture to
   * borrow, because borrowing would put the wrong scene under the words — so
   * the beat is named in the progress output and returned in `missingBeats`,
   * and `render.service.ts` refuses the video until it exists. The alternative
   * is a finished-looking render with a hole in it, which is the failure mode
   * nobody notices until it is published.
   */
  private async collectGenerated(args: {
    kind: "ILLUSTRATED" | "CINEMATIC" | "MIXED";
    videoId: string;
    anchored: AnchoredCue[];
    durationSeconds: number;
    format: VideoFormat;
    brand: {
      characterBrief: string | null;
      characterSheetPath: string | null;
      artStyle: string | null;
      tone: string | null;
    } | null;
    onProgress: FootageProgress;
  }): Promise<CollectFootageResult> {
    const { kind, videoId, anchored, durationSeconds, format, brand, onProgress } = args;
    const illustrated = kind === "ILLUSTRATED";
    // Whether any beat of this video may end up as a downloaded clip rather
    // than a drawn still. Only MIXED, and it gates every stock query below —
    // an illustrated or cinematic run must go on searching nobody at all.
    const mixed = kind === "MIXED";

    // Everything an illustrated channel is refused for, and none of which a
    // cinematic one has: the brief, the art style and the sheet all exist to
    // hold ONE character across every picture. A format that wants a different
    // person in every shot has nothing to refuse — it needs no setup on the
    // branding screen at all, which is the whole operator-facing difference.
    const brief = brand?.characterBrief?.trim();
    const style = findArtStyle(brand?.artStyle);
    let sheet: Buffer | undefined;

    if (illustrated) {
      // Refused before anything is spent, and the three refusals are separate
      // because the actions are separate: write down who the character is, pick
      // the look, then press the button that draws them.
      if (!brief) {
        throw new ConflictError(
          "This channel is set to illustrated footage but has no character described. " +
            "Describe the recurring character on the channel's branding screen — that " +
            "description is the only thing that keeps the same character in every scene.",
        );
      }

      // Never defaulted: a fallback look would give every channel that skipped
      // this the same one.
      if (!style) {
        throw new ConflictError(
          brand?.artStyle
            ? "This channel's art style is no longer one this app offers. Pick another on " +
              "the channel's branding screen, then generate a new character sheet in it."
            : "This channel is set to illustrated footage but has no art style. Pick one on " +
              "the channel's branding screen — it is what every picture is drawn in.",
        );
      }

      if (!brand?.characterSheetPath) {
        throw new ConflictError(
          "This channel is set to illustrated footage but has no character sheet. " +
            "Generate one on the channel's branding screen first — every scene is drawn " +
            "from it, and without it each picture would show a different character.",
        );
      }
    }

    // A script with no cues has no beats to group, and unlike the stock paths
    // there is no topic-level pool to fall back to: "a picture of the whole
    // video" is not a thing that exists. Named as a script problem because
    // that is what it is.
    if (anchored.length === 0) {
      throw new ConflictError(
        `${GENERATED_STYLE_NOUN[kind]} footage needs a script with ` +
          "section cues to draw from, and this video's script has none. Regenerate " +
          "the script, then collect again.",
      );
    }

    const beats: StoryBeat[] = planStoryBeats(anchored, durationSeconds);

    // Read once and reused for every beat in this run rather than fetched per
    // generation: it is the same object each time, and a dozen storage round
    // trips for one buffer is a dozen chances for a transient read to cost a
    // beat its character. Never read at all for a cinematic channel, which
    // conditions on nothing.
    if (brand?.characterSheetPath && illustrated) {
      sheet = await getObject(brand.characterSheetPath);
    }

    // Both kinds, because a MIXED run's slots are stills and clips under one
    // prefix (see `beatClipPath`). Widened for every style rather than only for
    // MIXED: nothing but a mixed collection has ever written a VIDEO asset
    // under `beats/`, so an illustrated or cinematic run's result set is
    // byte-for-byte what it was — and a style-dependent query here would be a
    // second place for the two to disagree about what a beat already has.
    const existing = await prisma.asset.findMany({
      where: {
        kind: { in: ["IMAGE", "VIDEO"] },
        deletedAt: null,
        storagePath: { startsWith: beatPrefix(videoId) },
      },
      // `provider` and `externalId` come along for the mixed path's sake: the
      // first is what a re-run's `bySource` is rebuilt from, and the second is
      // how a clip a previous run already spent on this video is kept from
      // being downloaded again into a second beat.
      select: { storagePath: true, provider: true, externalId: true },
    });
    const existingPaths = new Set(existing.map((asset) => asset.storagePath));

    /**
     * Whether this beat is one the script asked for real movement in.
     *
     * A beat covers exactly one cue on this path (see `isShotScripted`), so
     * "what did the writer ask for" has a single answer per beat. A beat
     * covering several cues cannot, which is why the mixed plan is only
     * reachable from a shot-scripted script — and why this returns false for a
     * multi-cue beat rather than picking one of its cues' answers. A MIXED
     * channel whose script predates the shot tags therefore collects exactly
     * what a CINEMATIC one would: every beat drawn, nothing searched for.
     */
    const wantsMotion = (index: number): boolean =>
      mixed &&
      beats[index].sectionIndices.length === 1 &&
      anchored[beats[index].sectionIndices[0]].shot === "motion";

    // Rebuilt from what is already on disk rather than started at zero, so a
    // re-run's totals describe the video rather than the run — the same thing
    // `clipCount` has always meant here. An illustrated or cinematic video's
    // beat assets are all `provider: "OPENAI"`, so this reproduces the old
    // `{ OPENAI: existingPaths.size }` exactly; a mixed one's motion slots
    // land under PEXELS or PIXABAY instead.
    const bySource: Record<string, number> = { OPENAI: 0 };
    for (const asset of existing) {
      const source = asset.provider ?? "OPENAI";
      bySource[source] = (bySource[source] ?? 0) + 1;
    }

    // Every stock clip this video has already spent a slot on, so two motion
    // shots whose searches both surface the same top result do not play the
    // same footage twice — the same guarantee `firstUnused` gives the
    // per-section collector, held across re-runs by seeding it from disk.
    // A drawn beat's `externalId` is its image model rather than a clip id and
    // is swept in here too; harmless, because no stock clip's id can collide
    // with `openai/gpt-image-2`, and filtering it out would mean teaching this
    // set which kind each asset is for no gain.
    const usedExternalIds = new Set(
      existing
        .map((asset) => asset.externalId)
        .filter((externalId): externalId is string => externalId !== null),
    );

    onProgress(
      `footage style ${kind}${style && illustrated ? ` (${style.name})` : ""} — ` +
        `${beats.length} story beat(s) from ${anchored.length} section(s), ` +
        `${Math.round(durationSeconds / beats.length)}s of picture each, drawn with ` +
        `${env.AI_ILLUSTRATION_MODEL} ` +
        (illustrated
          ? "from this channel's character sheet"
          : "in one fixed grade and lens, a different subject each time") +
        (mixed
          ? `, and stock footage for the ${
              beats.filter((_beat, index) => wantsMotion(index)).length
            } shot(s) the script tagged motion`
          : ""),
    );

    const missingBeats: number[] = [];
    /** The first beat failure's message, kept so a run that drew nothing can
     *  name why rather than leaving the render to guess. */
    let firstFailure: string | undefined;
    let bytesDownloaded = 0;
    let costUsd = 0;
    let generated = 0;
    let downloaded = 0;

    for (const [index, beat] of beats.entries()) {
      const label = `beat ${index + 1}/${beats.length}`;

      // Whichever kind this beat already got, if it got one. Both are checked
      // rather than only the still, so a re-run does not re-download a motion
      // shot the last one stored — the same per-beat idempotency the drawn
      // path has always had, extended to cover the other file extension.
      if (beatAssetPath(existingPaths, videoId, index) !== null) {
        continue;
      }

      const stepStartedAt = Date.now();

      // A motion shot: search for real footage before drawing anything.
      //
      // Falls through to the generation below when the search comes back with
      // nothing, and that direction is deliberate — see `collectMotionBeat`.
      if (wantsMotion(index)) {
        const clip = await this.collectMotionBeat({
          videoId,
          index,
          label,
          cue: beat.cues.join(". "),
          usedExternalIds,
          onProgress,
        });

        if (clip) {
          bySource[clip.source] = (bySource[clip.source] ?? 0) + 1;
          bytesDownloaded += clip.bytes;
          downloaded += 1;
          continue;
        }

        // A motion shot with no clip becomes a drawn one rather than a gap.
        //
        // Same stance `collectPerCue` already takes when a section's own search
        // comes back empty: a thinner stock library should make the video
        // slightly more expensive, never leave a hole in it. The opposite
        // fallback — a still shot filled with stock — is deliberately NOT
        // offered: the stills carry the video's look, and substituting stock
        // into one is how a channel starts looking like every other channel.
        onProgress(
          `[${label}] no stock clip for a motion shot — drawing it instead, ` +
            "which costs a picture but never leaves a gap.",
        );
      }

      const path = beatImagePath(videoId, index);

      let image;
      try {
        image = await this.images.generate({
          prompt:
            illustrated && brief && style
              ? beatIllustrationPrompt({
                  cues: beat.cues,
                  brief,
                  style,
                  tone: brand?.tone ?? null,
                  hasSheet: sheet !== undefined,
                })
              : composeCinematicShot({
                  // Joined and capped exactly as the illustrated prompt joins
                  // its own: a beat covers more than one section and the
                  // picture holds the screen across all of them.
                  shot: beat.cues.join(". ").slice(0, BEAT_CUE_MAX_LENGTH),
                  tone: brand?.tone ?? null,
                }),
          // Only read when `size` is absent, which it never is here — stated
          // anyway because the field is required and because it says what the
          // size below means.
          aspectRatio: format === "VERTICAL" ? "9:16" : "16:9",
          size: ILLUSTRATION_SIZE[format],
          // Spread rather than passed as a possibly-undefined array, so a
          // cinematic generation's request is a plain text-to-image call with
          // no `referenceImages` key at all — byte-for-byte what logos and
          // thumbnails have always sent.
          ...(sheet ? { referenceImages: [sheet] } : {}),
          model: env.AI_ILLUSTRATION_MODEL,
        });
      } catch (error) {
        // Caught per beat rather than allowed to abort the run, so one refusal
        // does not throw away the eleven pictures already paid for. Named
        // loudly, and counted — see `missingBeats`.
        missingBeats.push(index + 1);
        // Kept, because the guard after this loop needs a cause to name. The
        // first failure is the useful one: when a run fails on every beat it
        // is one external condition failing repeatedly (a 402 on the gateway's
        // budget, an expired key), not forty unrelated refusals.
        firstFailure ??= error instanceof Error ? error.message : String(error);
        onProgress(
          `[${label}] NO PICTURE — the model failed or refused: ` +
            (error instanceof Error ? error.message : String(error)) +
            `. This beat covers section(s) ${beat.sectionIndices
              .map((section) => section + 1)
              .join(", ")}; the render will refuse until it exists.`,
        );
        continue;
      }

      await putObject(path, image.data, "image/png");

      await prisma.asset.create({
        data: {
          kind: "IMAGE",
          storagePath: path,
          mimeType: "image/png",
          sizeBytes: BigInt(image.data.byteLength),
          // The account the spend lands on, which is what `Asset.provider`
          // records everywhere else. `GATEWAY` is not an `AiProviderType`
          // member and the gateway bills OpenAI's list price with no markup,
          // so OPENAI is the honest answer for `openai/gpt-image-2`.
          provider: "OPENAI",
          // The model that actually drew it, so a beat that came out wrong can
          // be traced to the generation that produced it — the same reason
          // `ThumbnailVersion.model` exists.
          externalId: image.model,
        },
      });

      // The one table the spend dashboards read. Until now the money spent on
      // pictures — the largest line in a render by an order of magnitude — was
      // computed here, summed into a progress line and discarded, so
      // /providers and the daily cost chart have never shown it. Best-effort
      // and never awaited into the collection's failure path: a usage row that
      // could not be written must not lose the operator a picture they have
      // already paid for.
      await prisma.providerUsage
        .create({
          data: {
            provider: "OPENAI",
            operation: "footage.collect",
            model: image.model,
            inputTokens: image.inputTokens ?? 0,
            outputTokens: image.outputTokens ?? 0,
            costUsd: image.costUsd,
            succeeded: true,
            latencyMs: Date.now() - stepStartedAt,
          },
        })
        .catch(() => {});

      generated += 1;
      bytesDownloaded += image.data.byteLength;
      costUsd += image.costUsd;

      onProgress(
        `[${label}] ${beat.sectionIndices.length} section(s), ` +
          `${formatBytes(image.data.byteLength)}, ` +
          // The raw counts beside the price, because the price alone cannot be
          // audited: "$0.006" is what a 1,150-in picture costs when the
          // provider reported no output tokens, and it is not distinguishable
          // from a cheap model without seeing "1150 in / ? out" next to it.
          `${image.inputTokens ?? "?"} in / ${image.outputTokens ?? "?"} out, ` +
          `$${image.costUsd.toFixed(3)} … ` +
          `drawn (${formatElapsed(Date.now() - stepStartedAt)})`,
      );
    }

    if (missingBeats.length > 0) {
      onProgress(
        `${missingBeats.length} of ${beats.length} beat(s) have no picture: ` +
          `${missingBeats.join(", ")}. Collect again to retry only those.`,
      );
    }

    bySource.OPENAI += generated;

    // A run that drew nothing at all is a failure, and it has to say so HERE.
    //
    // Without this, `collect` resolves with `clipCount: 0`, the pipeline marks
    // the footage stage done, and the first thing to notice is `render()` —
    // which refuses with "Stock footage must be collected before rendering."
    // on a channel that searches no stock provider at all. The operator is
    // told the wrong stage failed, in the vocabulary of the wrong footage
    // style, with no mention of the model error that actually caused it; the
    // reasonable response is to press Retry, which spends the pipeline again
    // and fails identically.
    //
    // Partial runs deliberately still resolve: `missingBeats` already carries
    // them, collecting again redraws only the beats that have none, and the
    // pictures already paid for are worth keeping.
    if (
      beats.length > 0 &&
      missingBeats.length === beats.length &&
      existingPaths.size === 0
    ) {
      throw new ConflictError(
        `No picture could be generated for any of the ${beats.length} beats in ` +
          `this video, so there is no footage to render. The image model failed ` +
          `every time: ${firstFailure ?? "no reason was reported"}. ` +
          `Fix that and collect footage again — nothing was kept, so nothing is wasted.`,
      );
    }

    return {
      clipCount: existingPaths.size + generated + downloaded,
      bySource,
      bytesDownloaded,
      missingBeats,
      costUsd,
    };
  }

  /**
   * One beat's stock clip, downloaded and filed beside the stills.
   *
   * Returns undefined when nothing usable came back, and the caller draws the
   * shot instead. That direction — search first, draw on failure — is the one
   * that can be got wrong cheaply and only in one place: drawing first and
   * searching on failure would spend real money on every motion shot before
   * discovering that the free option was there all along.
   *
   * Searches in plan order and stops at the first provider with something
   * unused, exactly as `collectPerCue` does per section, and for the same
   * reason: Pexels' 200-searches-an-hour quota is spent by querying every
   * source for every shot whether or not the first one answered. A failure from
   * a provider is treated as "no results" rather than aborting the run — one
   * transient 503 must not cost a video the eight pictures it has already paid
   * for.
   */
  private async collectMotionBeat(args: {
    videoId: string;
    index: number;
    label: string;
    cue: string;
    usedExternalIds: Set<string>;
    onProgress: FootageProgress;
  }): Promise<{ path: string; source: StockFootageSource; bytes: number } | undefined> {
    const { videoId, index, label, cue, usedExternalIds, onProgress } = args;
    const stepStartedAt = Date.now();

    let clip: StockClip | undefined;
    for (const key of MIXED_STOCK_PROVIDERS) {
      const clips = await searchOrEmpty(
        `${PROVIDER_LABEL[key]} "${cue}" (${label}, motion)`,
        this.providers[key].search(cue, CUE_CANDIDATE_COUNT),
        onProgress,
      );
      clip = firstUnused(clips, usedExternalIds);
      if (clip) {
        break;
      }
    }

    if (!clip) {
      return undefined;
    }

    const buffer = await this.downloadClip(clip);
    // `.mp4` under the same prefix as the stills, which is the whole mixed
    // design — see `beatClipPath`. Nothing downstream is told which slots are
    // which; the renderer asks the extension.
    const path = beatClipPath(videoId, index);
    await putObject(path, buffer, "video/mp4");

    await prisma.asset.create({
      data: {
        kind: "VIDEO",
        storagePath: path,
        mimeType: "video/mp4",
        sizeBytes: BigInt(buffer.byteLength),
        provider: clip.source,
        externalId: clip.externalId,
      },
    });

    usedExternalIds.add(clip.externalId);

    onProgress(
      `[${label}] motion — ${clip.source.toLowerCase()}-${clip.externalId}  ` +
        `${clip.width}x${clip.height}  ${Math.round(clip.durationSeconds)}s  ` +
        `${formatBytes(buffer.byteLength)} … stored (${formatElapsed(Date.now() - stepStartedAt)})`,
    );

    return { path, source: clip.source, bytes: buffer.byteLength };
  }

  /**
   * One clip per anchored cue, stored at `clips/section-{NNN}.mp4` so play
   * order is lexicographic and render.service.ts (Task 6) can sort by path
   * instead of relying on `createdAt`, which is only an accident of
   * insertion timing.
   *
   * Each section searches its channel's providers in `plan` order, stopping
   * at the first that returns something unused — for a live-action channel
   * that is Pexels, then Pixabay only if Pexels found nothing, because
   * Pexels' 200-searches-an-hour quota means querying both sources for
   * every section would exhaust it in two videos. A cartoon channel's plan
   * has one entry, so it makes one search. A section that still has nothing
   * after its plan draws from a topic-level pool shared by every section
   * that reaches it, searched at most once per `collect()` call (see
   * `getTopicPool`) and built from that same plan.
   *
   * Nothing here can substitute a live-action clip into a cartoon channel's
   * video, and it is worth being precise about why: not a guard, but the
   * absence of any live-action provider to reach. Every tier below — the
   * per-section searches, the topic pool, and the reuse — draws only from
   * `plan`, and CARTOON's plan is Pixabay's animation library alone.
   *
   * Once `MAX_UNIQUE_SECTION_CLIPS` distinct clips have been downloaded for
   * this video — across every tier, and across every call to `collect()`,
   * see `uniqueClipCount`'s seed value — no further section triggers a
   * search or a download at all. It reuses whichever already-assigned
   * section sits closest to it by index (`nearestAssignedIndex`), so a
   * section that can't get its own footage still gets something roughly
   * on-topic instead of a gap. Only a video with *no* assigned section
   * anywhere yet to borrow from — every cue's own search and the shared
   * topic pool all came back empty — ends up with a genuine gap at that
   * index; see the last `if (!picked)` below.
   */
  private async collectPerCue(args: {
    videoId: string;
    anchored: AnchoredCue[];
    query: string;
    plan: readonly FootageProviderKey[];
    existing: { provider: string | null; externalId: string | null; storagePath: string }[];
    usedExternalIds: Set<string>;
    bySource: Record<string, number>;
    onProgress: FootageProgress;
  }): Promise<CollectFootageResult> {
    const { videoId, anchored, query, plan, existing, usedExternalIds, bySource, onProgress } =
      args;

    const pathForIndex = (index: number) =>
      storagePath(videoId, "clips", `section-${String(index).padStart(3, "0")}.mp4`);

    const existingPaths = new Set(existing.map((asset) => asset.storagePath));

    // Every section already on disk for this video (from this call's own
    // earlier iterations, or from any prior call), keyed by index. This is
    // both the idempotency check (a path already in here needs no work) and
    // the reuse source once a section can't get its own clip. `buffer` is
    // filled in lazily — only the first time some *later* section actually
    // reuses a given entry — so a re-run that touches none of a video's
    // existing sections never pays for a storage round trip it doesn't
    // need.
    //
    // Reading `section-{NNN}.mp4`'s index back out of a path like this only
    // stays correct as long as index `N` keeps meaning the same cue on
    // every call. That holds because script.service.ts refuses every script
    // edit (generate, edit, regenerate — see its own `status !== "DRAFT"`
    // guards) once a video leaves DRAFT, and pipeline-runner.ts never calls
    // `collect()` until a video has already moved past DRAFT into
    // QUEUED/GENERATING. So by the time section 3 can exist here, the cue
    // that produced it is frozen for the rest of the video's life — it can
    // never later get silently paired with a different cue at the same
    // index. If that guard is ever relaxed to allow editing a queued
    // video's script, this map needs to become cue-aware (e.g. keyed by a
    // hash of the cue text, not just the index) rather than trusting index
    // stability.
    const assignedByIndex = new Map<
      number,
      { provider: StockFootageSource; externalId: string; buffer?: Buffer }
    >();
    for (const asset of existing) {
      const match = /\/clips\/section-(\d+)\.mp4$/.exec(asset.storagePath);
      if (match && asset.provider && asset.externalId) {
        assignedByIndex.set(Number(match[1]), {
          // Always PEXELS or PIXABAY in practice — nothing else ever writes
          // an Asset under clips/section-*.mp4 — but Asset.provider's
          // column type is the broader AiProviderType, so this narrows it.
          provider: asset.provider as StockFootageSource,
          externalId: asset.externalId,
        });
      }
    }

    const bufferForReuse = async (index: number): Promise<Buffer> => {
      const entry = assignedByIndex.get(index)!;
      if (entry.buffer === undefined) {
        entry.buffer = await getObject(pathForIndex(index));
      }
      return entry.buffer;
    };

    let total = existing.length;
    let bytesDownloaded = 0;

    // See MAX_UNIQUE_SECTION_CLIPS' own comment for what this bounds and
    // why. Seeded from every externalId this video has ever used, not reset
    // to zero each call, so the cap holds across an interrupted-and-resumed
    // collection too — a second run continues the same budget instead of
    // starting a fresh one.
    let uniqueClipCount = usedExternalIds.size;

    // Lazy and memoised: only fetched the first time some section actually
    // needs it, and shared by every section after that, so a video whose
    // cues all resolve cleanly against the first provider in the plan never
    // pays for this search at all (see the "searches Pixabay only when
    // Pexels returns nothing" test). Unlike the per-section tiers below, a
    // total outage here is not swallowed — if every provider in the plan
    // fails, there is genuinely nothing left to offer the section that asked
    // for it, and that failure is the first real signal (e.g. a missing API
    // key) that per-section `searchOrEmpty` was deliberately absorbing until
    // now.
    let topicPool: StockClip[] | null = null;
    const getTopicPool = async (): Promise<StockClip[]> => {
      if (topicPool) {
        return topicPool;
      }

      const results = await Promise.allSettled(
        plan.map((key) =>
          reportSearch(
            `${PROVIDER_LABEL[key]} "${query}" (topic fallback)`,
            this.providers[key].search(query, anchored.length),
            onProgress,
          ),
        ),
      );

      const firstRejection = results.find((result) => result.status === "rejected");
      if (firstRejection && results.every((result) => result.status === "rejected")) {
        throw firstRejection.reason;
      }

      topicPool = interleave(
        results.map((result) => (result.status === "fulfilled" ? result.value : [])),
      );
      return topicPool;
    };

    for (let index = 0; index < anchored.length; index++) {
      const path = pathForIndex(index);

      // Idempotent per section, not just per video: a re-run must not
      // re-download a clip a previous run already stored at this exact
      // path, even though this call's cues may cover a different total
      // count than that previous run's did.
      if (existingPaths.has(path)) {
        continue;
      }

      const { cue } = anchored[index];
      const label = `section ${index}`;
      const stepStartedAt = Date.now();

      let picked:
        | { provider: StockFootageSource; externalId: string; buffer: Buffer; reused: boolean }
        | undefined;

      // This section's own search, one provider at a time in plan order and
      // stopping at the first that yields something unused, then the shared
      // topic pool — and only while there's still budget left in the
      // unique-download cap. Once the cap is spent, skip straight to reuse
      // below: searching just to throw the result away would still cost a
      // provider call for nothing.
      if (uniqueClipCount < MAX_UNIQUE_SECTION_CLIPS) {
        let clip: StockClip | undefined;

        for (const key of plan) {
          const clips = await searchOrEmpty(
            `${PROVIDER_LABEL[key]} "${cue}" (${label})`,
            this.providers[key].search(cue, CUE_CANDIDATE_COUNT),
            onProgress,
          );
          clip = firstUnused(clips, usedExternalIds);
          if (clip) {
            break;
          }
        }

        if (!clip) {
          clip = firstUnused(await getTopicPool(), usedExternalIds);
        }

        if (clip) {
          const buffer = await this.downloadClip(clip);
          picked = { provider: clip.source, externalId: clip.externalId, buffer, reused: false };
          usedExternalIds.add(clip.externalId);
          uniqueClipCount++;
          bytesDownloaded += buffer.byteLength;
        }
      }

      // Tier 4: reuse. Reached either because the cap was already spent, or
      // because this cue's own search (all the way through the topic pool)
      // came up with nothing new — either way, no further search or
      // download happens for this section.
      if (!picked) {
        const nearest = nearestAssignedIndex(index, assignedByIndex);
        if (nearest !== undefined) {
          const entry = assignedByIndex.get(nearest)!;
          picked = {
            provider: entry.provider,
            externalId: entry.externalId,
            buffer: await bufferForReuse(nearest),
            reused: true,
          };
        }
      }

      if (!picked) {
        // No section of this video has been assigned a clip yet at all, so
        // there was nothing to reuse either. A gap here is a
        // render.service.ts (Task 6) problem, not one this call can solve —
        // skip rather than fail the whole video over one cue.
        onProgress(`[${label}] no usable clip found for "${cue}" — skipped`);
        continue;
      }

      await putObject(path, picked.buffer, "video/mp4");

      await prisma.asset.create({
        data: {
          kind: "VIDEO",
          storagePath: path,
          mimeType: "video/mp4",
          sizeBytes: BigInt(picked.buffer.byteLength),
          provider: picked.provider,
          externalId: picked.externalId,
        },
      });

      assignedByIndex.set(index, {
        provider: picked.provider,
        externalId: picked.externalId,
        buffer: picked.buffer,
      });
      bySource[picked.provider] = (bySource[picked.provider] ?? 0) + 1;
      total++;

      onProgress(
        `[${label}] ${picked.provider.toLowerCase()}-${picked.externalId}  ` +
          `${formatBytes(picked.buffer.byteLength)}  ` +
          `${picked.reused ? "reused" : "downloaded"} … stored (${formatElapsed(Date.now() - stepStartedAt)})`,
      );
    }

    return { clipCount: total, bySource, bytesDownloaded, missingBeats: [], costUsd: 0 };
  }
}

export const footageService = new FootageService();
