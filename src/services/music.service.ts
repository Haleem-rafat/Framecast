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
   * Never throws. Music is an enhancement to a video that is already
   * publishable, and nothing here may turn a renderable video into a failed
   * one — see the failure table in the video quality spec.
   */
  async collect(videoId: string, query: string): Promise<string | null> {
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

      return path;
    }

    return null;
  }
}

export const musicService = new MusicService();
