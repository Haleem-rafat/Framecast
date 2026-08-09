import "server-only";

import type { PromptCategory } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { UpsertPromptInput } from "@/schemas/prompt.schema";

export class PromptTemplateService {
  async list(userId: string) {
    return prisma.promptTemplate.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { variables: true },
    });
  }

  async get(userId: string, id: string) {
    const template = await prisma.promptTemplate.findFirst({
      where: { id, userId, deletedAt: null },
      include: { variables: true },
    });

    if (!template) {
      throw new NotFoundError("Prompt template");
    }

    return template;
  }

  async getDefault(userId: string, category: PromptCategory) {
    const template = await prisma.promptTemplate.findFirst({
      where: { userId, category, isDefault: true, deletedAt: null },
      include: { variables: true },
    });

    if (!template) {
      throw new NotFoundError(`Default ${category.toLowerCase()} prompt`);
    }

    return template;
  }

  async create(userId: string, input: UpsertPromptInput) {
    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { userId, category: input.category, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.promptTemplate.create({
        data: {
          userId,
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          content: input.content,
          isDefault: input.isDefault,
          variables: {
            create: input.variables.map((one) => ({
              key: one.key,
              label: one.label,
              defaultValue: one.defaultValue ?? null,
              required: one.required,
            })),
          },
        },
        include: { variables: true },
      });
    });
  }

  async update(userId: string, id: string, input: UpsertPromptInput) {
    await this.get(userId, id);

    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { userId, category: input.category, isDefault: true },
          data: { isDefault: false },
        });
      }

      // Variables are replaced wholesale: they have no identity of their own and
      // diffing them would add complexity with no user-visible benefit.
      await tx.promptVariable.deleteMany({ where: { promptTemplateId: id } });

      return tx.promptTemplate.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          content: input.content,
          isDefault: input.isDefault,
          variables: {
            create: input.variables.map((one) => ({
              key: one.key,
              label: one.label,
              defaultValue: one.defaultValue ?? null,
              required: one.required,
            })),
          },
        },
        include: { variables: true },
      });
    });
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await prisma.promptTemplate.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }
}

export const promptTemplateService = new PromptTemplateService();
