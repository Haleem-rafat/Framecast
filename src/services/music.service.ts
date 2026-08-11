import "server-only";

import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { jamendoProvider } from "@/services/providers/music.provider";
import type { MusicProvider, MusicTrack } from "@/services/providers/types";

/** Overfetch so one track whose download 404s does not end the attempt. */
const SEARCH_COUNT = 5;

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

export class MusicService {
  constructor(private readonly provider: MusicProvider = jamendoProvider) {}

  /**
   * Returns the storage path of this video's music bed, or `null` when it will
   * render without one.
   *
   * Never throws — and that is a hard contract, not a description of the happy
   * path. Music is an enhancement to a video that is already publishable, and
   * nothing here may turn a renderable video into a failed one (see the
   * failure table in the video quality spec).
   *
   * What makes it worth a wrapper rather than a promise in a comment: the one
   * caller, `RenderService.render`, calls this *after* every segment and
   * transition has already been encoded — roughly fifty FFmpeg runs and
   * fifteen-odd minutes of work on a real video. A transient Supabase error
   * while storing the bed used to escape from here, land in render's catch,
   * and mark the whole video FAILED, discarding all of it for the sake of
   * background music. Every step below is individually guarded, and this
   * wrapper is the backstop for the ones that are not obviously fallible: the
   * lookup query, the storage write, the Asset insert.
   */
  async collect(videoId: string, query: string): Promise<string | null> {
    try {
      return await this.collectTrack(videoId, query);
    } catch (error) {
      // Deliberately not rethrown and not logged to the operator's
      // ActivityLog: a video that renders without music is not a failure the
      // operator has to act on, and the console line is enough to explain a
      // silent bed if anyone goes looking.
      console.error(
        `Could not collect music for video ${videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  private async collectTrack(videoId: string, query: string): Promise<string | null> {
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
      return existing.storagePath;
    }

    let tracks: MusicTrack[];

    try {
      tracks = await this.provider.search(query, SEARCH_COUNT);
    } catch {
      return null;
    }

    for (const track of tracks) {
      let audio: Buffer;

      try {
        const response = await fetch(track.url);
        if (!response.ok) {
          continue;
        }
        audio = Buffer.from(await response.arrayBuffer());
      } catch {
        continue;
      }

      const path = storagePath(videoId, "music", "bed.mp3");

      // Storing the bed is as fallible as fetching it — a Supabase blip, a
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
      } catch {
        continue;
      }

      return path;
    }

    return null;
  }
}

export const musicService = new MusicService();
