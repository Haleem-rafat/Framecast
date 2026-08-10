import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateProjectInput } from "@/schemas/project.schema";

export class ProjectService {
  async list(userId: string) {
    return prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      // Scoped to `deletedAt: null` like every other video read — otherwise
      // a soft-deleted video (see `VideoService.remove`) would keep
      // inflating this project's count forever, even though it no longer
      // shows up anywhere the operator can see it.
      include: { _count: { select: { videos: { where: { deletedAt: null } } } } },
    });
  }

  async create(userId: string, input: CreateProjectInput) {
    return prisma.project.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        channelId: input.channelId ?? null,
      },
    });
  }

  async update(userId: string, id: string, input: CreateProjectInput) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        name: input.name,
        description: input.description ?? null,
        channelId: input.channelId ?? null,
      },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  async archive(userId: string, id: string) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  /**
   * Soft delete, cascading to every one of this project's videos — see
   * `VideoService.remove` for what a video delete itself does (soft, files
   * left in place, YouTube untouched). Deliberately cascades rather than
   * leaving them behind: `Video.projectId` is required, not nullable, so an
   * orphaned video would still surface in every `videoService.list()` call
   * showing a project that no longer exists anywhere the operator can see
   * it. Archiving (`archive`, above) is the other, non-destructive way to
   * get a project out of the way — this is the one that actually removes it
   * and takes its videos with it.
   *
   * Refused, in full, if any of the project's videos is actively held by
   * the render worker (see `VideoService.remove`'s own doc comment on
   * leases) — an all-or-nothing check up front rather than deleting the
   * rest and silently skipping the busy ones, so the operator gets one
   * clear reason instead of a partially-deleted project to puzzle over.
   */
  async remove(userId: string, id: string): Promise<{ deletedVideoCount: number }> {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const activeCount = await tx.video.count({
        where: {
          projectId: id,
          deletedAt: null,
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      });

      if (activeCount > 0) {
        throw new ConflictError(
          `${activeCount} video${activeCount === 1 ? "" : "s"} in this project ` +
            `${activeCount === 1 ? "is" : "are"} actively being processed by the ` +
            `render worker. Cancel ${activeCount === 1 ? "it" : "them"} first, ` +
            "then delete the project.",
        );
      }

      const { count: deletedVideoCount } = await tx.video.updateMany({
        where: { projectId: id, userId, deletedAt: null },
        data: { deletedAt: now },
      });

      // Same conditional-update guard as `archive`, above: the `findFirst`
      // only produced a precise NotFoundError; this is what actually stops
      // a concurrent delete of the same project from applying twice.
      const { count } = await tx.project.updateMany({
        where: { id, userId, deletedAt: null },
        data: { deletedAt: now },
      });

      if (count === 0) {
        throw new ConflictError("This project changed unexpectedly.");
      }

      return { deletedVideoCount };
    });
  }
}

export const projectService = new ProjectService();
