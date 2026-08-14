import "server-only";

import type { VideoStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateVideoInput } from "@/schemas/video.schema";

/** Shown whenever a delete is refused because the render worker holds the
 * video's lease right now — both the single- and bulk-delete paths report the
 * same reason, so an operator sees one consistent explanation everywhere. */
const ACTIVE_LEASE_MESSAGE =
  "This video is actively being processed by the render worker. Cancel it " +
  "first from the pipeline panel, then delete it once it's stopped.";

/**
 * True exactly when a worker holds this video's lease right now.
 * `GENERATING`/`RENDERING` alone isn't enough — a lapsed `leaseExpiresAt` on
 * either status means the worker that claimed it died (see
 * `job.service.ts`'s own doc comments on leases), and that video is
 * deletable like any other. Only a lease still in the future means a worker
 * process may be mid-write to this video's rows right now.
 */
function isActivelyLeased(
  video: { status: string; leaseExpiresAt: Date | null },
  now: Date,
): boolean {
  return (
    (video.status === "GENERATING" || video.status === "RENDERING") &&
    video.leaseExpiresAt !== null &&
    video.leaseExpiresAt > now
  );
}

export class VideoService {
  /**
   * The video list, optionally narrowed to one status.
   *
   * `status` is applied here rather than by the caller filtering the returned
   * array: `@@index([userId, status, deletedAt])` already exists and matches
   * this predicate exactly, so the filtered read is an index scan that returns
   * only the rows the page will render, instead of every video the operator
   * has ever made followed by a discard in JavaScript.
   */
  async list(userId: string, status?: VideoStatus) {
    return prisma.video.findMany({
      where: { userId, deletedAt: null, ...(status ? { status } : {}) },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        topic: true,
        status: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        // `channel` here is Gate 2's "which channel does this publish to"
        // answer — the publish confirmation dialog names it rather than
        // making the operator guess. Only `id`/`title` selected: never the
        // token columns (see channel.service.ts's SUMMARY_SELECT for the
        // same discipline).
        project: {
          select: {
            id: true,
            name: true,
            channel: { select: { id: true, title: true } },
          },
        },
        // `select`, not `include`. An `include` here pulled every column of
        // every `ScriptVersion` — `content`, `prompt`, `cues` and `sources`
        // are all large, and the history list renders none of them. On a
        // video regenerated eight times that was 65kB fetched to draw eight
        // one-line rows totalling 376 bytes, and because `VersionHistory` is
        // a client component the whole 65kB was serialised into the RSC
        // payload and shipped to the browser as well.
        //
        // The two consumers want different shapes, so they get different
        // selects: `ScriptPanel` loads `activeVersion.content` into its
        // editor and genuinely needs it; `VersionHistory` renders only the
        // five fields below.
        script: {
          select: {
            activeVersionId: true,
            versions: {
              orderBy: { version: "desc" },
              select: {
                id: true,
                version: true,
                wordCount: true,
                createdAt: true,
                model: true,
              },
            },
            activeVersion: {
              select: {
                id: true,
                content: true,
                version: true,
                wordCount: true,
              },
            },
          },
        },
        statusEvents: { orderBy: { createdAt: "desc" }, take: 10 },
        // Most recent attempt only — a retried render leaves earlier FAILED
        // rows behind (see RenderService.render), and only the latest one
        // can have the outputUrl the preview cares about.
        renderJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outputUrl: true },
        },
        voiceOver: { select: { audioUrl: true, durationSeconds: true } },
        // `Publication` is `@unique` on `videoId` (Gate 2's claim row, see
        // publish.service.ts) — at most one, so a direct `include` here is
        // enough to show the operator the real result once PUBLISHED.
        publication: {
          select: { youtubeVideoId: true, status: true, error: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    return video;
  }

  async create(userId: string, input: CreateVideoInput) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    return prisma.$transaction(async (tx) => {
      const video = await tx.video.create({
        data: {
          userId,
          projectId: project.id,
          title: input.title,
          topic: input.topic,
        },
      });

      await tx.videoStatusEvent.create({
        data: { videoId: video.id, to: "DRAFT", message: "Video created" },
      });

      return video;
    });
  }

  /**
   * Gate 1. Approving costs nothing yet — it only makes the video eligible for
   * the expensive stages, which is precisely why the gate sits here.
   */
  async approveScript(userId: string, id: string) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        script: { select: { activeVersion: { select: { content: true } } } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "DRAFT") {
      throw new ConflictError(
        `Only draft videos can be approved. This one is ${video.status.toLowerCase()}.`,
      );
    }

    if (!video.script?.activeVersion?.content.trim()) {
      throw new ConflictError("Generate a script before approving.");
    }

    await prisma.$transaction(async (tx) => {
      // The reads above exist only to produce a precise error message. The
      // actual guard against a concurrent double-approval is this conditional
      // update: two callers can both read DRAFT, but the `status: "DRAFT"`
      // clause means only one of their updates can match the row, so only one
      // can go on to append the QUEUED event below.
      const { count } = await tx.video.updateMany({
        where: { id, userId, deletedAt: null, status: "DRAFT" },
        data: { status: "QUEUED" },
      });

      if (count === 0) {
        throw new ConflictError("Only draft videos can be approved.");
      }

      await tx.videoStatusEvent.create({
        data: {
          videoId: id,
          from: "DRAFT",
          to: "QUEUED",
          message: "Script approved by operator",
        },
      });
    });
  }

  /**
   * Soft delete: sets `deletedAt`, matching every other domain entity (see
   * schema.prisma's top comment). The row — and everything Cascade-deletes
   * off it transitively (script, voice-over, scenes, render jobs,
   * publication, status events) — stays in Postgres, just excluded from
   * every `deletedAt: null` query from here on. The render under
   * `RENDER_ROOT` and any stored scene assets are deliberately left in
   * place: destroying the underlying files here would make this exactly as
   * unrecoverable as a hard delete, which defeats the point of soft
   * deleting at all. Deleting Framecast's record of a video never touches
   * YouTube either — there is no unpublish path (see
   * `publish.service.ts`'s own doc comment) — so a published video's
   * upload stays live at its original link after this.
   *
   * Refused while the render worker actively holds the video: a
   * `leaseExpiresAt` still in the future on a `GENERATING`/`RENDERING`
   * video means a worker process has it claimed right now and may be
   * mid-write to its rows. Deleting out from under that is a
   * use-after-free on the DB row, not a UI nicety to skip — the operator
   * needs to cancel it first (`JobService.requestCancel`) and let the
   * worker's next heartbeat actually stop it.
   */
  async remove(userId: string, id: string): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, status: true, leaseExpiresAt: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const now = new Date();

    if (isActivelyLeased(video, now)) {
      throw new ConflictError(ACTIVE_LEASE_MESSAGE);
    }

    // Same shape as every other conditional-update guard in this codebase
    // (see `approveScript` above, or `JobService.requeue`): the read above
    // only produces a precise error message, this `NOT` clause is what
    // actually stops a worker that claims the video in the instant between
    // that read and this write from having its row deleted under it.
    const { count } = await prisma.video.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
        NOT: {
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      },
      data: { deletedAt: now },
    });

    if (count === 0) {
      throw new ConflictError(ACTIVE_LEASE_MESSAGE);
    }
  }

  /**
   * Bulk cleanup for the video list's multi-select — see `remove` for what a
   * delete actually does. A single conditional `updateMany` rather than a
   * loop of `remove` calls: `ids` comes straight off the operator's own
   * checked rows, already scoped to their own visible list, so there is no
   * per-row message worth computing — only how many landed. Any id that
   * doesn't match (someone else's, already deleted, or actively leased —
   * see `remove`'s own doc comment) is silently skipped rather than failing
   * the whole batch, and reported back only as a count.
   */
  async removeMany(
    userId: string,
    ids: string[],
  ): Promise<{ deletedCount: number; skippedCount: number }> {
    if (ids.length === 0) {
      return { deletedCount: 0, skippedCount: 0 };
    }

    const now = new Date();
    const { count } = await prisma.video.updateMany({
      where: {
        id: { in: ids },
        userId,
        deletedAt: null,
        NOT: {
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      },
      data: { deletedAt: now },
    });

    return { deletedCount: count, skippedCount: ids.length - count };
  }
}

export const videoService = new VideoService();
