import "server-only";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
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

export interface CollectFootageResult {
  clipCount: number;
  bySource: Record<string, number>;
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

/** Pixabay's hard cap on search terms. Applied to the one query both sources
 * share, so Pexels' (uncapped) search stays consistent with Pixabay's. */
const QUERY_MAX_LENGTH = 100;

function computeClipCount(durationSeconds: number): number {
  return Math.ceil(durationSeconds / SECONDS_PER_CLIP) + EXTRA_CLIPS;
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

  async collect(userId: string, videoId: string): Promise<CollectFootageResult> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        topic: true,
        title: true,
        voiceOver: { select: { durationSeconds: true } },
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

    const clipCount = computeClipCount(video.voiceOver.durationSeconds);

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
      select: { provider: true, externalId: true },
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

    let total = existing.length;

    // Idempotent: a prior run already reached the target, so re-running
    // collects nothing new rather than re-downloading anything.
    if (total >= clipCount) {
      return { clipCount: total, bySource };
    }

    const query = (video.topic ?? video.title).trim().slice(0, QUERY_MAX_LENGTH);
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
      this.providers.PEXELS.search(query, clipCount),
      this.providers.PIXABAY.search(query, clipCount),
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
    }

    return { clipCount: total, bySource };
  }
}

export const footageService = new FootageService();
