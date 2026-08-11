import "server-only";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { anchorCues, type AnchoredCue, type ScriptCue } from "@/lib/script-cues";
import { getObject, putObject, storagePath } from "@/lib/storage";
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

/** Round-robins two providers' results into one list, Pexels first each
 * round — the same alternation `collect()`'s topic-level path already uses,
 * and for the same reason (see this class's own doc comment: "so one
 * provider's stock look never dominates a video"). `collectPerCue`'s topic
 * fallback pool draws from the same two sources and should look the same
 * way rather than favouring whichever source happened to come first in a
 * plain concatenation. */
function alternate(pexels: StockClip[], pixabay: StockClip[]): StockClip[] {
  const merged: StockClip[] = [];
  const length = Math.max(pexels.length, pixabay.length);

  for (let i = 0; i < length; i++) {
    if (i < pexels.length) merged.push(pexels[i]);
    if (i < pixabay.length) merged.push(pixabay[i]);
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
    // Trimmed for the same reason script.service.ts and voiceover.service.ts
    // trim: the offsets these anchors produce are only meaningful against
    // the string ElevenLabs is actually sent, which is `content.trim()`.
    // Collection and render must agree on where a section starts, so this
    // has to match render.service.ts's anchoring exactly — a clip fetched
    // for one set of offsets and played against another is a picture that
    // does not match its words.
    const anchored =
      activeVersion && scriptCues.length > 0
        ? anchorCues(scriptCues, activeVersion.content.trim()).anchored
        : [];

    if (anchored.length > 0) {
      return this.collectPerCue({
        videoId,
        anchored,
        query,
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
   * (see `getTopicPool`).
   *
   * Once `MAX_UNIQUE_SECTION_CLIPS` distinct clips have been downloaded for
   * this video — across every tier, and across every call to `collect()`,
   * see `uniqueClipCount`'s seed value — no further section triggers a
   * search or a download at all. It reuses whichever already-assigned
   * section sits closest to it by index (`nearestAssignedIndex`), so a
   * section that can't get its own footage still gets something roughly
   * on-topic instead of a gap. Only a video with *no* assigned section
   * anywhere yet to borrow from — every cue's own search, Pixabay, and the
   * shared topic pool all came back empty — ends up with a genuine gap at
   * that index; see the last `if (!picked)` below.
   */
  private async collectPerCue(args: {
    videoId: string;
    anchored: AnchoredCue[];
    query: string;
    existing: { provider: string | null; externalId: string | null; storagePath: string }[];
    usedExternalIds: Set<string>;
    bySource: Record<string, number>;
    onProgress: FootageProgress;
  }): Promise<CollectFootageResult> {
    const { videoId, anchored, query, existing, usedExternalIds, bySource, onProgress } = args;

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
    // cues all resolve cleanly against Pexels never pays for this search at
    // all (see the "searches Pixabay only when Pexels returns nothing"
    // test). Unlike the per-section tiers below, a total outage here is not
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

      topicPool = alternate(
        pexelsResult.status === "fulfilled" ? pexelsResult.value : [],
        pixabayResult.status === "fulfilled" ? pixabayResult.value : [],
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

      // Tier 1-3: this section's own search, only while there's still
      // budget left in the unique-download cap. Once the cap is spent,
      // skip straight to reuse below — searching just to throw the result
      // away would still cost a Pexels/Pixabay call for nothing.
      if (uniqueClipCount < MAX_UNIQUE_SECTION_CLIPS) {
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

    return { clipCount: total, bySource, bytesDownloaded };
  }
}

export const footageService = new FootageService();
