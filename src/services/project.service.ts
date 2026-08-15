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
   * The way back from `archive`, and the reason that button can now honestly
   * call itself reversible. Restoring puts the project back in the new-video
   * picker (`/videos` filters that list to `ACTIVE`), which is the whole of
   * what archiving took away.
   *
   * Deliberately the mirror image of `archive` down to the `where` clause —
   * same `{ id, userId, deletedAt: null }` scoping, so a project belonging to
   * anyone else bounces off it with `NotFoundError` exactly as archiving does,
   * and same conditional `updateMany` rather than a read-then-write. In
   * particular it does *not* additionally require `status: "ARCHIVED"`:
   * restoring an already-active project is idempotent, and narrowing the
   * `where` would turn that harmless no-op into "Project was not found",
   * which is a lie about ownership.
   */
  async unarchive(userId: string, id: string) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "ACTIVE", archivedAt: null },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  /**
   * What `remove` would do to this project, read at the moment the operator is
   * being asked to confirm it — the numbers the delete confirmation states out
   * loud, and the pre-check for the one reason `remove` refuses.
   *
   * Read on demand rather than folded into `list`: `activeRenderCount` is the
   * refusal condition, and it is a function of `leaseExpiresAt > now`, so a
   * value baked into the page at render time is stale by the time anyone
   * clicks. It cannot close the race — `remove` re-checks inside its
   * transaction, and that check is the authority — but it is the difference
   * between telling the operator why the button will fail before they press it
   * and telling them afterwards. `videoCount` deliberately uses the same
   * `{ projectId, userId, deletedAt: null }` scope as `remove`'s cascading
   * `updateMany`, so the number in the confirmation is the number that goes.
   */
  async deletionImpact(
    userId: string,
    id: string,
  ): Promise<{
    videoCount: number;
    publishedCount: number;
    activeRenderCount: number;
  }> {
    const project = await prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    const scope = { projectId: id, userId, deletedAt: null } as const;
    const now = new Date();

    const [videoCount, publishedCount, activeRenderCount] = await Promise.all([
      prisma.video.count({ where: scope }),
      prisma.video.count({ where: { ...scope, status: "PUBLISHED" } }),
      prisma.video.count({
        where: {
          ...scope,
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      }),
    ]);

    return { videoCount, publishedCount, activeRenderCount };
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
