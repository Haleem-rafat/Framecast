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

export class PexelsProvider implements StockFootageProvider {
  async search(query: string, count: number): Promise<StockClip[]> {
    const apiKey = env.PEXELS_API_KEY;

    if (!apiKey) {
      throw new ProviderError("PEXELS", "PEXELS_API_KEY is not configured.", false);
    }

    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(clampPerPage(count, 80)));
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

    const clips: StockClip[] = [];

    for (const video of body.videos) {
      const file = pickPexelsFile(video.video_files);

      if (!file || file.width === null || file.height === null) {
        continue;
      }

      clips.push({
        source: "PEXELS",
        externalId: String(video.id),
        url: file.link,
        width: file.width,
        height: file.height,
        durationSeconds: video.duration,
      });
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
    // Pixabay requires per_page between 3 and 200.
    url.searchParams.set("per_page", String(clampPerPage(count, 200, 3)));

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
      const rendition = hit.videos.medium ?? hit.videos.small;

      if (!rendition?.url) {
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
