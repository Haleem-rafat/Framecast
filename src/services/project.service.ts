import "server-only";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateProjectInput } from "@/schemas/project.schema";

export class ProjectService {
  async list(userId: string) {
    return prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { videos: true } } },
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
}

export const projectService = new ProjectService();
