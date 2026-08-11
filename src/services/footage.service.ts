import "server-only";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { anchorCues, type AnchoredCue, type ScriptCue } from "@/lib/script-cues";
import { putObject, storagePath } from "@/lib/storage";
import {
  pexelsProvider,
  pixabayProvider,
} from "@/services/providers/stock-footage.provider";
import type {
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

export interface FootageProviders {
  PEXELS: StockFootageProvider;
  PIXABAY: StockFootageProvider;
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

const SOURCE_ORDER: readonly StockFootageSource[] = ["PEXELS", "PIXABAY"];

/** Roughly one clip's worth of screen time before the footage starts feeling static. */
const SECONDS_PER_CLIP = 12;
/** Padding beyond exact coverage so the render's last clip isn't cut short — see Task 6. */
const EXTRA_CLIPS = 2;

// Uncapped, `ceil(duration / SECONDS_PER_CLIP) + EXTRA_CLIPS` grows without
// limit — a real ~7-minute video needed 38 *unique* clips, which took 11m51s
// and 218MB to fetch (see render-oom-report.md). render.service.ts's
// `ensureCoverage` already repeats the clip list to cover any narration
// length once the unique set runs out, so there's no need to fetch a fresh
// clip per slot: capping the unique pool at MAX_UNIQUE_CLIPS and letting
// render-time repetition fill the rest cuts download time and storage by
// roughly two thirds. At the cap, a clip repeats about every
// MAX_UNIQUE_CLIPS * SECONDS_PER_CLIP = 144s (2-3 minutes) of narration —
// noticeable, but this is a walking skeleton whose stock clips don't match
// the narration's content anyway, so a viewer isn't losing anything a
// higher cap would have given them. Do not raise this back up to "unique
// clip per slot" without also solving the unbounded fetch time/memory it
// reintroduces.
const MAX_UNIQUE_CLIPS = 12;

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
 * Pulls stock video clips from Pexels and Pixabay, alternating between the
 * two so one provider's stock look never dominates a video, and stores each
 * clip in our own bucket — Pixabay's terms forbid permanent hotlinking, and
 * an expiring CDN URL would fail mid-render.
 */
export class FootageService {
  constructor(
    private readonly providers: FootageProviders = {
      PEXELS: pexelsProvider,
      PIXABAY: pixabayProvider,
    },
    private readonly downloadClip: ClipDownloader = fetchClip,
  ) {}

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
        voiceOver: { select: { durationSeconds: true } },
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

    // Assets carry no direct videoId column — every object (and therefore
    // every Asset that references one) lives under `videos/{videoId}/...`,
    // so the storage prefix is the scoping key. Matches render.service.ts's
    // (Task 6) own clip lookup, the one convention for scoping an Asset to
    // its video.
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
    const existingPaths = new Set(existing.map((asset) => asset.storagePath));

    const bySource: Record<string, number> = {};
    for (const asset of existing) {
      if (asset.provider) {
        bySource[asset.provider] = (bySource[asset.provider] ?? 0) + 1;
      }
    }

    const query = (video.topic ?? video.title).trim().slice(0, QUERY_MAX_LENGTH);

    // A script with sections (Tasks 1-3) gets one clip per section instead
    // of a shared topic pool, so the picture can later be cut to match the
    // words it plays under (Task 5/6). Anchoring re-derives each cue's
    // position from the *current* content on every call rather than trusting
    // stored offsets, so an edit made since the cues were written can't
    // silently point a clip at the wrong sentence. A video with no script,
    // no cues (predates this feature), or whose anchors no longer resolve
    // falls straight through to the original topic-level behaviour below —
    // that is what makes the nullable `cues` column safe to ship without a
    // backfill.
    const activeVersion = video.script?.activeVersion ?? null;
    const rawCues = activeVersion?.cues;
    const scriptCues = Array.isArray(rawCues) ? (rawCues as unknown as ScriptCue[]) : [];
    const anchored =
      activeVersion && scriptCues.length > 0
        ? anchorCues(scriptCues, activeVersion.content).anchored
        : [];

    if (anchored.length > 0) {
      return this.collectPerCue({
        videoId,
        anchored,
        query,
        existingCount: existing.length,
        existingPaths,
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
      return { clipCount: total, bySource, bytesDownloaded: 0 };
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
    const [pexelsResult, pixabayResult] = await Promise.allSettled([
      reportSearch(`Pexels "${query}"`, this.providers.PEXELS.search(query, clipCount), onProgress),
      reportSearch("Pixabay", this.providers.PIXABAY.search(query, clipCount), onProgress),
    ]);

    if (pexelsResult.status === "rejected" && pixabayResult.status === "rejected") {
      throw pexelsResult.reason;
    }

    const pools: Record<StockFootageSource, StockClip[]> = {
      PEXELS: pexelsResult.status === "fulfilled" ? pexelsResult.value : [],
      PIXABAY: pixabayResult.status === "fulfilled" ? pixabayResult.value : [],
    };

    let sourceIndex = 0;
    let picked = 0;
    let bytesDownloaded = 0;

    while (picked < need) {
      if (pools.PEXELS.length === 0 && pools.PIXABAY.length === 0) {
        break;
      }

      const source = SOURCE_ORDER[sourceIndex % SOURCE_ORDER.length];
      sourceIndex++;

      const clip = pools[source].shift();

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

    return { clipCount: total, bySource, bytesDownloaded };
  }

  /**
   * One clip per anchored cue, stored at `clips/section-{NNN}.mp4` so play
   * order is lexicographic and render.service.ts (Task 6) can sort by path
   * instead of relying on `createdAt`, which is only an accident of
   * insertion timing.
   *
   * Each section searches independently — Pexels first, then, only if
   * Pexels found nothing usable, Pixabay for that section alone — because
   * Pexels' 200-searches-an-hour quota means querying both sources for
   * every section would exhaust it in two videos. A section that still has
   * nothing after both tiers draws from a topic-level pool shared by every
   * section that reaches it, searched at most once per `collect()` call
   * (see `getTopicPool`), rather than nothing at all: a loosely-related
   * clip beats a black screen.
   */
  private async collectPerCue(args: {
    videoId: string;
    anchored: AnchoredCue[];
    query: string;
    existingCount: number;
    existingPaths: ReadonlySet<string>;
    usedExternalIds: Set<string>;
    bySource: Record<string, number>;
    onProgress: FootageProgress;
  }): Promise<CollectFootageResult> {
    const { videoId, anchored, query, existingPaths, usedExternalIds, bySource, onProgress } = args;

    let total = args.existingCount;
    let bytesDownloaded = 0;

    // Lazy and memoised: only fetched the first time some section actually
    // needs it, and shared by every section after that, so a video whose
    // cues all resolve cleanly against Pexels never pays for this search at
    // all (see the "searches Pixabay only when Pexels returns nothing"
    // test). Unlike the per-section tiers above, a total outage here is not
    // swallowed — if both sources fail, there is genuinely nothing left to
    // offer the section that asked for it, and that failure is the first
    // real signal (e.g. a missing API key) that per-section `searchOrEmpty`
    // was deliberately absorbing until now.
    let topicPool: StockClip[] | null = null;
    const getTopicPool = async (): Promise<StockClip[]> => {
      if (topicPool) {
        return topicPool;
      }

      const [pexelsResult, pixabayResult] = await Promise.allSettled([
        reportSearch(
          `Pexels "${query}" (topic fallback)`,
          this.providers.PEXELS.search(query, anchored.length),
          onProgress,
        ),
        reportSearch(
          `Pixabay "${query}" (topic fallback)`,
          this.providers.PIXABAY.search(query, anchored.length),
          onProgress,
        ),
      ]);

      if (pexelsResult.status === "rejected" && pixabayResult.status === "rejected") {
        throw pexelsResult.reason;
      }

      topicPool = [
        ...(pexelsResult.status === "fulfilled" ? pexelsResult.value : []),
        ...(pixabayResult.status === "fulfilled" ? pixabayResult.value : []),
      ];
      return topicPool;
    };

    for (let index = 0; index < anchored.length; index++) {
      const path = storagePath(videoId, "clips", `section-${String(index).padStart(3, "0")}.mp4`);

      // Idempotent per section, not just per video: a re-run must not
      // re-download a clip a previous run already stored at this exact
      // path, even though this call's cues may cover a different total
      // count than that previous run's did.
      if (existingPaths.has(path)) {
        continue;
      }

      const { cue } = anchored[index];
      const label = `section ${index}`;

      const pexelsClips = await searchOrEmpty(
        `Pexels "${cue}" (${label})`,
        this.providers.PEXELS.search(cue, CUE_CANDIDATE_COUNT),
        onProgress,
      );
      let clip = firstUnused(pexelsClips, usedExternalIds);

      if (!clip) {
        const pixabayClips = await searchOrEmpty(
          `Pixabay "${cue}" (${label})`,
          this.providers.PIXABAY.search(cue, CUE_CANDIDATE_COUNT),
          onProgress,
        );
        clip = firstUnused(pixabayClips, usedExternalIds);
      }

      if (!clip) {
        clip = firstUnused(await getTopicPool(), usedExternalIds);
      }

      if (!clip) {
        // Nothing usable anywhere for this section. A gap in the footage is
        // worse than nothing to fill it with here, but there is nothing
        // left to try — render.service.ts (Task 6) has to cope with a
        // missing section rather than this call failing the whole video
        // over one cue.
        onProgress(`[${label}] no usable clip found for "${cue}" — skipped`);
        continue;
      }

      const stepStartedAt = Date.now();
      const buffer = await this.downloadClip(clip);
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
      bytesDownloaded += buffer.byteLength;

      onProgress(
        `[${label}] ${clip.source.toLowerCase()}-${clip.externalId}  ` +
          `${clip.width}x${clip.height}  ${Math.round(clip.durationSeconds)}s  ` +
          `${formatBytes(buffer.byteLength)} … stored (${formatElapsed(Date.now() - stepStartedAt)})`,
      );
    }

    return { clipCount: total, bySource, bytesDownloaded };
  }
}

export const footageService = new FootageService();
