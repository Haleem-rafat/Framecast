import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type { MusicProvider, MusicTrack } from "@/services/providers/types";

/** 429 and 5xx are transient; everything else means the request itself is
 *  wrong. Same rule the stock footage providers apply. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Jamendo caps `limit` at 200. */
const MAX_LIMIT = 200;

interface JamendoTrack {
  id?: string | number;
  name?: string;
  artist_name?: string;
  license_ccurl?: string;
  duration?: number;
  audiodownload?: string;
  /** Artists can block downloads independently of the licence — added by
   *  Jamendo in 2021, and false for a real share of the catalogue. */
  audiodownload_allowed?: boolean;
}

interface JamendoSearchResponse {
  results?: JamendoTrack[];
}

/**
 * Background music from Jamendo.
 *
 * Pixabay is not an option despite already being a configured provider: its
 * documented API covers images and videos only, with no music endpoint at all.
 *
 * Only commercially usable Creative Commons tracks are requested. `ccnc=false`
 * excludes non-commercial licences at the query rather than filtering them
 * afterwards, because a non-commercial track is unusable on a channel intended
 * for monetisation and there is no reason to carry one this far.
 */
export class JamendoProvider implements MusicProvider {
  constructor(private readonly clientId: string | undefined = env.JAMENDO_CLIENT_ID) {}

  async search(query: string, count: number): Promise<MusicTrack[]> {
    if (!this.clientId) {
      throw new ProviderError("JAMENDO", "JAMENDO_CLIENT_ID is not configured.", false);
    }

    const url = new URL("https://api.jamendo.com/v3.0/tracks");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(count), 1), MAX_LIMIT)));
    url.searchParams.set("search", query);
    url.searchParams.set("audioformat", "mp32");
    url.searchParams.set("ccnc", "false");
    // Instrumental beds only — a track with vocals competes with the narration
    // rather than sitting under it.
    url.searchParams.set("vocalinstrumental", "instrumental");

    let response: Response;

    try {
      response = await fetch(url);
    } catch (cause) {
      throw new ProviderError("JAMENDO", "Could not reach Jamendo.", true, { cause });
    }

    if (!response.ok) {
      throw new ProviderError(
        "JAMENDO",
        `Jamendo request failed with status ${response.status} ${response.statusText}.`,
        isRetryable(response.status),
      );
    }

    let body: JamendoSearchResponse;

    try {
      body = await response.json();
    } catch (cause) {
      throw new ProviderError(
        "JAMENDO",
        "Jamendo returned a response that could not be parsed.",
        false,
        { cause },
      );
    }

    const tracks: MusicTrack[] = [];

    for (const result of body.results ?? []) {
      // Both checks matter: the flag can be false on a track that still
      // carries a url, and the url can be empty on one where the flag is true.
      if (result.audiodownload_allowed !== true || !result.audiodownload) {
        continue;
      }

      tracks.push({
        externalId: String(result.id ?? ""),
        url: result.audiodownload,
        title: result.name ?? "Untitled",
        artistName: result.artist_name ?? "Unknown artist",
        licenseUrl: result.license_ccurl ?? "",
        durationSeconds: result.duration ?? 0,
      });
    }

    return tracks;
  }
}

export const jamendoProvider: MusicProvider = new JamendoProvider();
