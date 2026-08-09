import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type { StockClip, StockFootageProvider } from "@/services/providers/types";

/** 429 and 5xx are transient; everything else means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Pexels caps `per_page` at 80 regardless of what's asked for. */
function clampPerPage(count: number, max: number, min = 1): number {
  return Math.min(Math.max(Math.trunc(count), min), max);
}

// ---------------------------------------------------------------------------
// Duration and file-size filtering
//
// Discovered live: a real search returned a clip 111s long and 70.9MB at
// 1920x1080. footage.service.ts only ever plays SECONDS_PER_CLIP (12s) of
// any clip it downloads — the rest is decoded to disk, uploaded to Supabase,
// and then never used. That one clip took 2m38s to download and then failed
// the upload outright: Supabase's per-object limit on this plan is 50MB, and
// there was no ceiling here stopping a candidate that size from being picked
// in the first place.
//
// The fix is a duration band, not a size cap alone, because size and
// duration both point the same direction and duration is free (both APIs
// return it right in the search response, no extra request needed):
//   - Below SECONDS_PER_CLIP the clip is shorter than the slot it fills, so
//     ffmpeg has to loop it (-stream_loop -1) — a visible seam if it's much
//     shorter.
//   - Far above SECONDS_PER_CLIP the clip is mostly waste: a 111s clip
//     filling a 12s slot downloads ~90% more than will ever be shown.
// Do not widen this band back toward "pick the biggest/highest-res file" —
// that is the exact bug this fixes. If SECONDS_PER_CLIP in
// footage.service.ts ever changes, this band should move with it.
// ---------------------------------------------------------------------------

const MIN_CLIP_DURATION_SECONDS = 6;
const MAX_CLIP_DURATION_SECONDS = 30;

/** Comfortably under Supabase's 50MB per-object limit (see storage.ts's
 * `ensureBucket`) — leaves headroom for the estimate below to be slightly
 * off before it becomes an upload failure instead of a skip. */
const MAX_CLIP_SIZE_BYTES = 40 * 1024 * 1024;

/** Ask each API for more candidates than the caller actually needs, so that
 * filtering by duration/size still leaves enough clips — widening the pool
 * instead of falling back to an oversized one when few pass. Both APIs'
 * `per_page` is still clamped to their own hard max below, so this can't
 * over-request. */
const OVERFETCH_FACTOR = 3;

function inDurationBand(durationSeconds: number): boolean {
  return (
    durationSeconds >= MIN_CLIP_DURATION_SECONDS &&
    durationSeconds <= MAX_CLIP_DURATION_SECONDS
  );
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------

interface PexelsVideoFile {
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
}

interface PexelsVideo {
  id: number;
  duration: number;
  video_files: PexelsVideoFile[];
}

interface PexelsSearchResponse {
  videos: PexelsVideo[];
}

const MAX_RENDITION_WIDTH = 1920;

/** The largest mp4 rendition at or below 1920px wide — 4K wastes bandwidth
 * and render time for a 1080p output with no visible gain. */
function pickPexelsFile(files: PexelsVideoFile[]): PexelsVideoFile | undefined {
  return files
    .filter(
      (file): file is PexelsVideoFile & { width: number } =>
        file.file_type === "video/mp4" &&
        file.width !== null &&
        file.width <= MAX_RENDITION_WIDTH,
    )
    .sort((a, b) => b.width - a.width)[0];
}

/** Pexels' search response carries no file size, unlike Pixabay's — the only
 * way to learn it ahead of the actual download is a `HEAD` request against
 * the rendition's own URL. */
async function fetchContentLength(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      return undefined;
    }
    const header = response.headers.get("content-length");
    if (!header) {
      return undefined;
    }
    const bytes = Number(header);
    return Number.isFinite(bytes) ? bytes : undefined;
  } catch {
    // Treated as "unknown" by the caller, not rethrown: a HEAD failure on one
    // candidate shouldn't fail the whole search when other candidates are
    // still fine.
    return undefined;
  }
}

export class PexelsProvider implements StockFootageProvider {
  async search(query: string, count: number): Promise<StockClip[]> {
    const apiKey = env.PEXELS_API_KEY;

    if (!apiKey) {
      throw new ProviderError("PEXELS", "PEXELS_API_KEY is not configured.", false);
    }

    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", query);
    // Overfetch: the duration/size filtering below will drop some of these,
    // so asking for exactly `count` would systematically under-deliver.
    url.searchParams.set("per_page", String(clampPerPage(count * OVERFETCH_FACTOR, 80)));
    url.searchParams.set("orientation", "landscape");

    let response: Response;

    try {
      response = await fetch(url, { headers: { Authorization: apiKey } });
    } catch (cause) {
      // No status code to classify by — the request never reached Pexels.
      throw new ProviderError("PEXELS", "Could not reach Pexels.", true, { cause });
    }

    if (!response.ok) {
      throw new ProviderError(
        "PEXELS",
        `Pexels request failed with status ${response.status} ${response.statusText}.`,
        isRetryable(response.status),
      );
    }

    let body: PexelsSearchResponse;

    try {
      body = await response.json();
    } catch (cause) {
      throw new ProviderError(
        "PEXELS",
        "Pexels returned a response that could not be parsed.",
        false,
        { cause },
      );
    }

    const candidates = body.videos.filter((video) => inDurationBand(video.duration));

    // HEAD every candidate's chosen rendition concurrently — sequentially it
    // would turn one search into `candidates.length` round trips, which is
    // exactly the kind of silent slowness Task 2 is trying to surface, not add
    // more of.
    const checked = await Promise.all(
      candidates.map(async (video) => {
        const file = pickPexelsFile(video.video_files);
        if (!file || file.width === null || file.height === null) {
          return null;
        }

        return {
          externalId: String(video.id),
          url: file.link,
          width: file.width,
          height: file.height,
          durationSeconds: video.duration,
          contentLength: await fetchContentLength(file.link),
        };
      }),
    );

    const clips: StockClip[] = [];

    for (const entry of checked) {
      if (!entry) {
        continue;
      }
      const { contentLength, ...clip } = entry;

      // Unknown size (HEAD failed, or Pexels omitted the header) fails
      // closed: the whole point of this check is to stop a clip that looks
      // fine turning into a 70MB+ upload, so "can't tell" must skip it, not
      // let it through.
      if (contentLength === undefined || contentLength > MAX_CLIP_SIZE_BYTES) {
        continue;
      }

      clips.push({ source: "PEXELS", ...clip });
    }

    return clips;
  }
}

// ---------------------------------------------------------------------------
// Pixabay
// ---------------------------------------------------------------------------

interface PixabayRendition {
  url: string;
  width: number;
  height: number;
  /** Bytes. Unlike Pexels, Pixabay returns this directly — no HEAD needed. */
  size: number;
}

interface PixabayHit {
  id: number;
  duration: number;
  videos: {
    large: PixabayRendition;
    medium: PixabayRendition;
    small: PixabayRendition;
    tiny: PixabayRendition;
  };
}

interface PixabaySearchResponse {
  hits: PixabayHit[];
}

/** Pixabay's search term is capped at 100 characters; longer queries 400. */
const PIXABAY_QUERY_MAX_LENGTH = 100;

export class PixabayProvider implements StockFootageProvider {
  async search(query: string, count: number): Promise<StockClip[]> {
    const apiKey = env.PIXABAY_API_KEY;

    if (!apiKey) {
      throw new ProviderError("PIXABAY", "PIXABAY_API_KEY is not configured.", false);
    }

    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("q", query.slice(0, PIXABAY_QUERY_MAX_LENGTH));
    // Pixabay requires per_page between 3 and 200. Overfetch for the same
    // reason as Pexels: duration/size filtering below will drop some results.
    url.searchParams.set(
      "per_page",
      String(clampPerPage(count * OVERFETCH_FACTOR, 200, 3)),
    );

    let response: Response;

    try {
      response = await fetch(url);
    } catch (cause) {
      throw new ProviderError("PIXABAY", "Could not reach Pixabay.", true, { cause });
    }

    if (!response.ok) {
      throw new ProviderError(
        "PIXABAY",
        `Pixabay request failed with status ${response.status} ${response.statusText}.`,
        isRetryable(response.status),
      );
    }

    let body: PixabaySearchResponse;

    try {
      body = await response.json();
    } catch (cause) {
      throw new ProviderError(
        "PIXABAY",
        "Pixabay returned a response that could not be parsed.",
        false,
        { cause },
      );
    }

    const clips: StockClip[] = [];

    for (const hit of body.hits) {
      if (!inDurationBand(hit.duration)) {
        continue;
      }

      const rendition = hit.videos.medium ?? hit.videos.small;

      if (!rendition?.url) {
        continue;
      }

      // Pixabay returns size directly — no HEAD request needed, unlike
      // Pexels. A missing/non-numeric value is treated the same as "known to
      // be too big": fail closed, same reasoning as Pexels' unknown case.
      if (typeof rendition.size !== "number" || rendition.size > MAX_CLIP_SIZE_BYTES) {
        continue;
      }

      clips.push({
        source: "PIXABAY",
        externalId: String(hit.id),
        url: rendition.url,
        width: rendition.width,
        height: rendition.height,
        durationSeconds: hit.duration,
      });
    }

    return clips;
  }
}

export const pexelsProvider: StockFootageProvider = new PexelsProvider();
export const pixabayProvider: StockFootageProvider = new PixabayProvider();
