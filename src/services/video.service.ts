import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateVideoInput } from "@/schemas/video.schema";

export class VideoService {
  async list(userId: string) {
    return prisma.video.findMany({
      where: { userId, deletedAt: null },
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
        script: {
          include: {
            versions: { orderBy: { version: "desc" } },
            activeVersion: true,
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
}

export const videoService = new VideoService();
