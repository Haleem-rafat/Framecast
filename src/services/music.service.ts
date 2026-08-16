import "server-only";

import { ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { jamendoProvider } from "@/services/providers/music.provider";
import type { MusicProvider, MusicTrack } from "@/services/providers/types";

/** Overfetch so one track whose download 404s does not end the attempt. */
const SEARCH_COUNT = 5;

/**
 * How many times one query is asked before "no music" is believed.
 *
 * Not defensive padding — it is the fix for a measured defect. Jamendo answers
 * an identical `/v3.0/tracks?search=…` request with
 * `{"status":"success","code":0,"results_count":0}` on roughly every other
 * call, with no error, no warning and HTTP 200. Measured from the worker on
 * 2026-08-16 at twenty-second spacing, ten calls for `lullaby`:
 * 0,5,0,5,0,5,5,0,5,5. Over ten trials per query, one attempt found a track
 * 6/10, 7/10 and 3/10 times for "lullaby", "calm ambient instrumental" and
 * "soft piano"; three attempts found one 10/10, 10/10 and 9/10, at an average
 * of 1.3-1.8 calls. That is the whole difference between a channel that has
 * music and a channel that intermittently does not — and, because a bed is
 * reused once stored (see `collectTrack`), between a channel that has music
 * and one that never gets a first bed to reuse.
 *
 * The cost is bounded and paid only on the failing path: at most two extra
 * searches and 0.8s, once per video, on a pipeline that spends minutes in
 * FFmpeg.
 */
const SEARCH_ATTEMPTS = 3;

/** Long enough for the next request to be answered by a different one of
 *  Jamendo's backends, short enough to be invisible next to the encode. */
const SEARCH_RETRY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recorded on the Asset at collection time so publish.service.ts can credit the
 * track from stored state. Same reasoning as PIXABAY_CREDIT over there:
 * attribution that depends on the operator remembering is not attribution.
 */
export function musicCredit(
  track: Pick<MusicTrack, "title" | "artistName" | "licenseUrl">,
): string {
  const licence = track.licenseUrl ? ` (${track.licenseUrl})` : "";
  return `Music: "${track.title}" by ${track.artistName}${licence}`;
}

/**
 * What a collection attempt produced.
 *
 * `reason` is set on exactly the runs where `storagePath` is null, and it is
 * the whole point of this being a record rather than `string | null`. Music
 * was silent in both senses for as long as this returned a bare null: every
 * failure mode below — an unconfigured client id, an empty search, a download
 * that 404d, a storage write that was refused — arrived at the render as the
 * same `null`, which the render turned into a video with no bed and no line
 * anywhere saying so. Nobody can act on a null. The caller writes this
 * sentence where the operator will find it (see `RenderService.render`).
 */
export interface MusicOutcome {
  /** The bed's storage path, or null when this video renders without one. */
  storagePath: string | null;
  /** One operator-readable sentence, non-null exactly when `storagePath` is
   *  null. */
  reason: string | null;
}

export class MusicService {
  constructor(private readonly provider: MusicProvider = jamendoProvider) {}

  /**
   * Returns the storage path of this video's music bed, or a reason there
   * isn't one.
   *
   * Never throws — and that is a hard contract, not a description of the happy
   * path. Music is an enhancement to a video that is already publishable, and
   * nothing here may turn a renderable video into a failed one (see the
   * failure table in the video quality spec).
   *
   * What makes it worth a wrapper rather than a promise in a comment: the one
   * caller, `RenderService.render`, calls this *after* every segment and
   * transition has already been encoded — roughly fifty FFmpeg runs and
   * fifteen-odd minutes of work on a real video. A transient storage error
   * while storing the bed used to escape from here, land in render's catch,
   * and mark the whole video FAILED, discarding all of it for the sake of
   * background music. Every step below is individually guarded, and this
   * wrapper is the backstop for the ones that are not obviously fallible: the
   * lookup query, the storage write, the Asset insert.
   *
   * What it may no longer do is fail *quietly*. Resilience and silence were
   * shipped as one thing and they are not one thing: the render still
   * succeeds without a bed, but it now says which of these guards caught
   * something and what it was.
   */
  async collect(videoId: string, query: string): Promise<MusicOutcome> {
    try {
      return await this.collectTrack(videoId, query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Still not rethrown and still not an ActivityLog entry the operator has
      // to clear: a video that renders without music is not a failure they
      // have to act on. The difference from before is that the reason travels
      // back to the caller instead of only to this console line, which nobody
      // was ever going to go looking for.
      console.error(`Could not collect music for video ${videoId}: ${message}`);

      return { storagePath: null, reason: `music collection failed — ${message}` };
    }
  }

  private async collectTrack(videoId: string, query: string): Promise<MusicOutcome> {
    // Assets carry no videoId column; the storage prefix is the scoping key,
    // the same convention render.service.ts already queries by.
    const existing = await prisma.asset.findFirst({
      where: {
        kind: "MUSIC",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    // Reused rather than re-fetched, so a re-render never silently swaps the
    // music under a video the operator has already watched.
    if (existing) {
      return { storagePath: existing.storagePath, reason: null };
    }

    const { tracks, failure } = await this.search(query);

    if (tracks.length === 0) {
      return { storagePath: null, reason: failure };
    }

    // Kept so a bed that could not be *stored* is not reported as a search
    // that found nothing — those call for opposite responses from whoever
    // reads the line.
    let lastFailure: string | null = null;

    for (const track of tracks) {
      let audio: Buffer;

      try {
        const response = await fetch(track.url);
        if (!response.ok) {
          lastFailure = `downloading "${track.title}" returned HTTP ${response.status}`;
          continue;
        }
        audio = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastFailure = `downloading "${track.title}" failed — ${
          error instanceof Error ? error.message : String(error)
        }`;
        continue;
      }

      const path = storagePath(videoId, "music", "bed.mp3");

      // Storing the bed is as fallible as fetching it — a failed write, a
      // rejected insert — and it sits inside the same loop for the same
      // reason: whatever went wrong here, the answer is to try the next
      // candidate and, failing that, render without music. Nothing about a
      // bed that could not be stored is worth the fifty encodes the caller
      // has already paid for.
      try {
        await putObject(path, audio, "audio/mpeg");

        await prisma.asset.create({
          data: {
            kind: "MUSIC",
            storagePath: path,
            mimeType: "audio/mpeg",
            provider: "JAMENDO",
            externalId: track.externalId,
            prompt: musicCredit(track),
          },
        });
      } catch (error) {
        lastFailure = `storing "${track.title}" failed — ${
          error instanceof Error ? error.message : String(error)
        }`;
        continue;
      }

      return { storagePath: path, reason: null };
    }

    return {
      storagePath: null,
      reason:
        `none of the ${tracks.length} track(s) Jamendo returned for "${query}" ` +
        `could be used${lastFailure ? ` — last was: ${lastFailure}` : ""}`,
    };
  }

  /**
   * One query, asked up to `SEARCH_ATTEMPTS` times, and the reason it came
   * back empty if it did.
   *
   * An empty result set is retried because on this API it is not an answer —
   * see `SEARCH_ATTEMPTS`. A `ProviderError` that is not retryable is not:
   * "JAMENDO_CLIENT_ID is not configured" and "Jamendo rejected the request"
   * say exactly the same thing however many times they are asked, and asking
   * twice more only delays the render and the message.
   */
  private async search(
    query: string,
  ): Promise<{ tracks: MusicTrack[]; failure: string }> {
    let failure = `Jamendo returned no instrumental track for "${query}"`;

    for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt += 1) {
      try {
        const tracks = await this.provider.search(query, SEARCH_COUNT);

        if (tracks.length > 0) {
          return { tracks, failure: "" };
        }

        failure =
          `Jamendo returned no instrumental track for "${query}" ` +
          `(${SEARCH_ATTEMPTS} attempts)`;
      } catch (error) {
        failure = `Jamendo could not be searched for "${query}" — ${
          error instanceof Error ? error.message : String(error)
        }`;

        if (error instanceof ProviderError && !error.retryable) {
          return { tracks: [], failure };
        }
      }

      if (attempt < SEARCH_ATTEMPTS) {
        await sleep(SEARCH_RETRY_MS);
      }
    }

    return { tracks: [], failure };
  }
}

export const musicService = new MusicService();
