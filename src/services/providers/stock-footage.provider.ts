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
// any clip it downloads — the rest is decoded to disk, written to storage,
// and then never used. That one clip took 2m38s to download and was then
// refused by storage outright: the per-object limit was, and still is, 50MB
// (storage.ts's OBJECT_SIZE_LIMIT_BYTES), and there was no ceiling here
// stopping a candidate that size from being picked in the first place.
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

/** Comfortably under storage.ts's 50MB `OBJECT_SIZE_LIMIT_BYTES` — leaves
 * headroom for the estimate below to be slightly off before it becomes a
 * write failure instead of a skip. */
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

/** The render's frame width. A source narrower than this must be upscaled to
 * fill the frame, which is what makes stock footage look soft. */
const OUTPUT_WIDTH = 1920;

/**
 * Prefers the smallest rendition that is at least 1920 wide, and only falls
 * back to the largest one below that when nothing bigger exists.
 *
 * The output is 1080p, so a 1280-wide source has to be scaled *up* to fill the
 * frame, and upscaled stock footage reads as soft and cheap under sharp burnt
 * in captions. Coming down from 2560 instead is a genuine resample and stays
 * crisp. Picking the *smallest* qualifying rendition rather than the largest
 * keeps 4K out — that really would be wasted bandwidth and render time — while
 * still never upscaling when the source has something better to offer.
 */
function pickPexelsFile(files: PexelsVideoFile[]): PexelsVideoFile | undefined {
  const mp4s = files.filter(
    (file): file is PexelsVideoFile & { width: number } =>
      file.file_type === "video/mp4" && file.width !== null,
  );

  const atLeastOutputWidth = mp4s
    .filter((file) => file.width >= OUTPUT_WIDTH)
    .sort((a, b) => a.width - b.width);

  if (atLeastOutputWidth.length > 0) {
    return atLeastOutputWidth[0];
  }

  return mp4s.sort((a, b) => b.width - a.width)[0];
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

/**
 * The smallest rendition that still fills a 1080p frame — the same rule
 * `pickPexelsFile` applies, and for the same two reasons plus a third.
 *
 * Too small and the render upscales it, which is the softness `4f7a697` set
 * out to fix. Too large and it is wasted bytes, because nothing above
 * `OUTPUT_WIDTH` survives the scale in pass one.
 *
 * The third reason is memory, and it is why this stopped simply preferring
 * `large`. Pixabay's `large` is often 3840x2160, and a 4K h264 decoder on the
 * worker's 1GB container — alongside the pan filter and the encoder — is
 * enough to get FFmpeg OOM-killed mid-render. Pexels never caused this
 * because it has always picked the smallest rendition at or above the output
 * width; Pixabay now matches it.
 *
 * A hit with nothing both wide enough and under the size cap is skipped
 * entirely rather than falling back to a 640-wide clip that would only be
 * blown up to fill the frame.
 */
function pickPixabayRendition(videos: PixabayHit["videos"]): PixabayRendition | null {
  return (
    [videos.large, videos.medium, videos.small, videos.tiny]
      .filter(
        (candidate): candidate is PixabayRendition =>
          Boolean(candidate?.url) &&
          typeof candidate?.size === "number" &&
          candidate.size <= MAX_CLIP_SIZE_BYTES &&
          typeof candidate?.width === "number" &&
          candidate.width >= OUTPUT_WIDTH,
      )
      .sort((a, b) => a.width - b.width)[0] ?? null
  );
}

/**
 * What separates the cartoon provider below from the default one. Three query
 * parameters and a prefix — deliberately not a second copy of this class,
 * because everything that actually decides whether a clip is usable (the
 * duration band, the size cap, `pickPixabayRendition`) is identical for
 * animation and live action, and a copy would let the two drift.
 */
interface PixabayVariant {
  /**
   * Pixabay's own `video_type`. Documented as: "Filter results by video type.
   * Accepted values: 'all', 'film', 'animation'".
   * https://pixabay.com/api/docs/
   */
  videoType: "all" | "animation";
  /**
   * Prepended to every query, space-separated, before the 100-character clamp.
   *
   * `video_type=animation` on its own is *not* enough to get cartoons, which
   * is the whole reason this exists. Pixabay's "animation" means "rendered
   * rather than filmed", and that bucket is full of photoreal 3D creatures,
   * HUD overlays and abstract particle loops — a live search for "friendly
   * dinosaur teaching numbers" with `video_type=animation` returns a
   * photorealistic T-rex tagged `realistic` as its third hit. Measured over
   * ten representative cues, the share of top-20 results carrying a cartoon-ish
   * tag went 9% on a plain search, 25% with `video_type=animation` alone, and
   * 56% with `video_type=animation` plus this prefix. The prefix is doing most
   * of the work; the filter is what stops live action getting back in.
   */
  queryPrefix: string;
  /**
   * Pixabay's `safesearch`. Documented as: "A flag indicating that only videos
   * suitable for all ages should be returned."
   *
   * On for the cartoon variant because its whole reason to exist is a
   * children's channel, and off for the default one only because turning it on
   * there would silently change what every existing channel already collects.
   */
  safesearch: boolean;
}

const LIVE_ACTION_VARIANT: PixabayVariant = {
  videoType: "all",
  queryPrefix: "",
  safesearch: false,
};

const CARTOON_VARIANT: PixabayVariant = {
  videoType: "animation",
  queryPrefix: "cartoon",
  safesearch: true,
};

export class PixabayProvider implements StockFootageProvider {
  constructor(private readonly variant: PixabayVariant = LIVE_ACTION_VARIANT) {}

  async search(query: string, count: number): Promise<StockClip[]> {
    const apiKey = env.PIXABAY_API_KEY;

    if (!apiKey) {
      throw new ProviderError("PIXABAY", "PIXABAY_API_KEY is not configured.", false);
    }

    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", apiKey);
    // Clamped *after* the prefix, not before: Pixabay 400s on a `q` over 100
    // characters, and the prefix is part of what gets sent.
    url.searchParams.set(
      "q",
      `${this.variant.queryPrefix} ${query}`.trim().slice(0, PIXABAY_QUERY_MAX_LENGTH),
    );
    url.searchParams.set("video_type", this.variant.videoType);
    if (this.variant.safesearch) {
      url.searchParams.set("safesearch", "true");
    }
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

      const rendition = pickPixabayRendition(hit.videos);

      // No rendition is both wide enough and small enough. Pixabay reports
      // size directly, so unlike Pexels this needs no HEAD request, and a
      // missing or non-numeric value is treated as "known to be too big"
      // rather than gambling on it.
      if (!rendition) {
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

/**
 * The same Pixabay account, key, licence and credit as `pixabayProvider` —
 * only the search is different. Clips it returns are still tagged
 * `source: "PIXABAY"`, which is not a shortcut: they *are* Pixabay clips, so
 * the credit `publish.service.ts` already writes into every description is
 * already the right one, and `Asset.provider` needs no new enum value.
 *
 * Pexels has no counterpart and deliberately gets none. Its video API exposes
 * only `query`, `orientation`, `size` and `locale` — there is no content-type
 * filter to set (https://www.pexels.com/api/documentation/) — and its library
 * is live-action photography first, so the only thing a cartoon channel could
 * get from it is live action. See `FOOTAGE_SEARCH_PLAN` in footage.service.ts,
 * which is why a cartoon channel never asks it.
 */
export const pixabayCartoonProvider: StockFootageProvider = new PixabayProvider(
  CARTOON_VARIANT,
);
