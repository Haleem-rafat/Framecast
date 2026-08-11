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

/**
 * A ShareAlike licence, read off the track's own `license_ccurl`.
 *
 * The CC url is the authoritative statement of what a track is licensed
 * under — `.../licenses/by-sa/3.0/`, `.../licenses/by-nc-sa/4.0/` — so `sa`
 * appearing as a component of that path is the check. Hyphens are not word
 * characters, so `\bsa\b` matches `by-sa` and `by-nc-sa` and never `salsa`.
 */
const SHARE_ALIKE_LICENCE = /creativecommons\.org\/licenses\/[a-z-]*\bsa\b/i;

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
    // No-derivatives is excluded for a subtler reason than non-commercial.
    // The bed is trimmed to length, gain-staged and ducked under narration,
    // and synchronising audio to picture that way is plausibly an adaptation —
    // exactly the ambiguity this provider exists to stay out of. Real BY-ND
    // tracks do come back from this search, so this is not hypothetical.
    url.searchParams.set("ccnd", "false");
    // ShareAlike goes for the same reason as no-derivatives, taken one step
    // further. If ducking and trimming a bed under narration is plausibly an
    // adaptation — the argument directly above — then under BY-SA that
    // adaptation is the *whole video*, and ShareAlike would ask for the whole
    // video to be licensed alike. On a channel intended for monetisation that
    // is not a licence to be ambiguous about. Real BY-SA tracks come back
    // from this query, so this is not hypothetical either.
    //
    // Asked for at the query level and checked again on the way out. The
    // parameter costs nothing if Jamendo honours it and nothing if it ignores
    // it, but a licence this consequential is not something to leave to an
    // undocumented flag: `license_ccurl` is the track's own statement of what
    // it is, and that is what the filter below actually trusts.
    url.searchParams.set("ccsa", "false");
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

      // The backstop for `ccsa=false` above. A track that says ShareAlike on
      // its own licence url is dropped here however it came back — a filter
      // the API ignored, a filter that was renamed, a licence Jamendo
      // classifies differently than the url reads.
      if (SHARE_ALIKE_LICENCE.test(result.license_ccurl ?? "")) {
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
