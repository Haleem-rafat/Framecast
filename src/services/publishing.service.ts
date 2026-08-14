import "server-only";

import type { PublishStatus, PublishVisibility } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * The read model behind `/publishing`: every video that has been handed to
 * YouTube, and every video that could be next.
 *
 * Read-only by design. Publishing itself lives in `publish.service.ts` and is
 * reached from one place — the confirmation dialog on a video's own page —
 * because it uploads ~170MB, cannot be undone from this app, and permanently
 * blocks a retry once a `Publication` row exists (see that service's own doc
 * comment on retries). A second button somewhere else would be a second way
 * to make that irreversible mistake, so this page links to the video instead
 * of racing it.
 *
 * `Publication` carries a `channelId` but no `userId`, so ownership is
 * established through the video it belongs to. Filtering on the channel would
 * work today and break the moment a channel is shared or reassigned; the
 * video is the row that actually names an owner.
 */

export interface PublicationEntry {
  id: string;
  videoId: string;
  /** The operator's own video title. Kept beside `title` below because
   *  `Publication.title` is what was *sent* to YouTube — a generated title,
   *  clamped to 100 characters — and the two routinely differ. */
  videoTitle: string;
  title: string;
  channelTitle: string;
  status: PublishStatus;
  visibility: PublishVisibility;
  scheduledFor: Date | null;
  /** Null for a SCHEDULED row: it means "when this went live", and a video
   *  waiting on YouTube's scheduler has not. See publish.service.ts. */
  publishedAt: Date | null;
  youtubeVideoId: string | null;
  /** False when the video uploaded but its custom thumbnail did not attach —
   *  most often an unverified YouTube channel, which is a thing the operator
   *  can fix, not a publish failure. */
  thumbnailApplied: boolean;
  error: string | null;
  createdAt: Date;
}

export interface ReadyVideoEntry {
  videoId: string;
  title: string;
  projectName: string;
  /** Null when the video's project has no channel assigned, which
   *  `publish()` refuses on — surfaced here so the operator sees the blocker
   *  before opening the video. */
  channelTitle: string | null;
  /**
   * True while `runPipeline`'s `metadata` and `thumbnail` stages are still
   * running behind an already-READY status. `publish()` refuses during this
   * window because publishing inside it uploads the placeholder title with no
   * tags and no thumbnail — see its own comment. Same signal, same
   * definition, as `PipelineState.isFinalizing`.
   */
  isFinalizing: boolean;
  updatedAt: Date;
}

export interface PublishingOverview {
  publications: PublicationEntry[];
  readyToPublish: ReadyVideoEntry[];
}

export class PublishingService {
  /**
   * Both halves of the page in one round trip pair. They are queried together
   * rather than by separate callers because they answer one question between
   * them — what has gone out, and what is waiting — and a page that fetched
   * them independently could show a video as both published and ready if a
   * publish landed between the two reads.
   */
  async getOverview(userId: string): Promise<PublishingOverview> {
    const now = new Date();

    const [publications, ready] = await Promise.all([
      prisma.publication.findMany({
        where: { video: { userId, deletedAt: null } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          status: true,
          visibility: true,
          scheduledFor: true,
          publishedAt: true,
          youtubeVideoId: true,
          thumbnailApplied: true,
          error: true,
          createdAt: true,
          video: { select: { id: true, title: true } },
          // Only the display columns. `Channel` also holds OAuth access and
          // refresh tokens, whose accidental exposure is a security incident
          // (see the model's own comment) — this payload crosses to the
          // browser, so it selects the title and nothing else.
          channel: { select: { title: true } },
        },
      }),
      // A video is publishable exactly when `publish()` would accept it:
      // READY, and with no `Publication` row already claiming it. The row is
      // created *before* the upload as the concurrency claim, so "has a
      // publication" covers in-flight and failed attempts too — both of which
      // block a second publish and must not be offered as ready.
      prisma.video.findMany({
        where: {
          userId,
          deletedAt: null,
          status: "READY",
          publication: null,
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          updatedAt: true,
          leaseExpiresAt: true,
          project: {
            select: { name: true, channel: { select: { title: true } } },
          },
        },
      }),
    ]);

    return {
      publications: publications.map((publication) => ({
        id: publication.id,
        videoId: publication.video.id,
        videoTitle: publication.video.title,
        title: publication.title,
        channelTitle: publication.channel.title,
        status: publication.status,
        visibility: publication.visibility,
        scheduledFor: publication.scheduledFor,
        publishedAt: publication.publishedAt,
        youtubeVideoId: publication.youtubeVideoId,
        thumbnailApplied: publication.thumbnailApplied,
        error: publication.error,
        createdAt: publication.createdAt,
      })),
      readyToPublish: ready.map((video) => ({
        videoId: video.id,
        title: video.title,
        projectName: video.project.name,
        channelTitle: video.project.channel?.title ?? null,
        isFinalizing:
          video.leaseExpiresAt !== null && video.leaseExpiresAt > now,
        updatedAt: video.updatedAt,
      })),
    };
  }
}

export const publishingService = new PublishingService();
