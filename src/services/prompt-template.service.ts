import "server-only";

import type { PromptCategory } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { findScriptStyle, type ScriptStyle } from "@/lib/script-styles";
import type { UpsertPromptInput } from "@/schemas/prompt.schema";

/** What adding a catalogue style produced, for the toast that reports it. */
export interface AddedScriptStyle {
  id: string;
  name: string;
  /** True when the operator had deleted this style before and it came back
   *  rather than being created fresh — a different sentence to say. */
  restored: boolean;
  /** True when this copy also became the category's default, which only
   *  happens for an operator who had no default at all. */
  becameDefault: boolean;
}

export class PromptTemplateService {
  async list(userId: string) {
    return prisma.promptTemplate.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { variables: true },
    });
  }

  /**
   * The templates one category offers, for a picker rather than a page —
   * `select`ed down to the three columns a picker renders, because `content`
   * is kilobytes per row and a select element shows none of it.
   *
   * Ordered default-first: the option the operator would get by doing nothing
   * is the one at the top of the list.
   */
  async listForCategory(userId: string, category: PromptCategory) {
    return prisma.promptTemplate.findMany({
      where: { userId, category, deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isDefault: true },
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

  /**
   * Copies a built-in style out of `SCRIPT_STYLES` into this operator's
   * library.
   *
   * A copy, and only a copy. Nothing links the new row back to the catalogue
   * entry: the operator can rewrite it completely, and a later change to the
   * shipped style will not reach it. That is the whole contract of the browse
   * surface — "add it and it is yours" — and it is why this takes a style id
   * rather than prompt content. A client that could post arbitrary content
   * through here would be able to store anything as a shipped style.
   *
   * ── Adding twice ──────────────────────────────────────────────────────────
   * Refuses, rather than suffixing the name. Two chosen behaviours were
   * possible and this is the one that does not quietly damage a library: a
   * suffixed "Children's content (2)" is indistinguishable from the operator's
   * own edited copy in every list in the app, and the picker on the video page
   * would offer both with no way to tell which is which. Refusing names the
   * template that already exists and leaves the operator's edits untouched —
   * which is the point, because by the time somebody adds a style twice the
   * first copy is usually the one they have been editing.
   *
   * A *deleted* copy is the one exception, and it is not really a second add.
   * `deletedAt` is a soft delete but `@@unique([userId, name])` is not soft, so
   * a plain create would fail on the constraint with nothing an operator could
   * act on. A style that was removed and is being added again is restored to
   * the shipped content — there is nothing to preserve, since removing it was
   * the operator saying so.
   */
  async addScriptStyle(userId: string, styleId: string): Promise<AddedScriptStyle> {
    const style = findScriptStyle(styleId);

    if (!style) {
      throw new NotFoundError("Script style");
    }

    const existing = await prisma.promptTemplate.findUnique({
      where: { userId_name: { userId, name: style.name } },
      select: { id: true, deletedAt: true },
    });

    if (existing && existing.deletedAt === null) {
      throw new ConflictError(
        `"${style.name}" is already in your library. Open it from the ` +
          `${style.category.toLowerCase()} tab to edit it — adding it again would ` +
          "either overwrite your edits or leave you with two templates nobody " +
          "could tell apart.",
      );
    }

    // Claimed only by an operator who has no default in this category at all,
    // exactly as `scripts/seed-default-prompts.ts` does it. Adding a style
    // must never silently repoint every future generation at it: choosing
    // which template a video uses is a per-video decision made in the script
    // panel, not a side effect of browsing.
    const currentDefault = await prisma.promptTemplate.findFirst({
      where: {
        userId,
        category: style.category,
        isDefault: true,
        deletedAt: null,
        ...(existing ? { NOT: { id: existing.id } } : {}),
      },
      select: { id: true },
    });
    const becameDefault = currentDefault === null;

    const template = await prisma.$transaction(async (tx) => {
      const record = await tx.promptTemplate.upsert({
        where: { userId_name: { userId, name: style.name } },
        create: {
          userId,
          name: style.name,
          description: style.description,
          category: style.category,
          content: style.content,
          isDefault: becameDefault,
        },
        update: {
          description: style.description,
          category: style.category,
          content: style.content,
          isDefault: becameDefault,
          deletedAt: null,
        },
        select: { id: true, name: true },
      });

      // Replaced wholesale rather than merged, the same way `update()` above
      // treats them: a restored template must carry the shipped style's
      // variable set exactly, or a placeholder the operator's old row never
      // declared would reach the model un-substituted.
      await tx.promptVariable.deleteMany({ where: { promptTemplateId: record.id } });

      if (style.variables.length > 0) {
        await tx.promptVariable.createMany({
          data: style.variables.map((variable) => ({
            promptTemplateId: record.id,
            key: variable.key,
            label: variable.label,
            defaultValue: variable.defaultValue ?? null,
            required: variable.required ?? false,
          })),
        });
      }

      return record;
    });

    return {
      id: template.id,
      name: template.name,
      restored: existing !== null,
      becameDefault,
    };
  }

  /**
   * Which catalogue styles this operator already holds, by style id, so the
   * browse surface can say "already in your library" instead of offering an
   * add that `addScriptStyle` would refuse.
   *
   * Matched on name, because a copy has no other link back to its entry —
   * see `addScriptStyle`. That means an operator who renamed their copy is
   * offered the style again, which is correct: nothing in their library is
   * called that any more, and adding it will succeed.
   */
  async listOwnedScriptStyleIds(
    userId: string,
    styles: readonly ScriptStyle[],
  ): Promise<string[]> {
    const names = styles.map((style) => style.name);

    const owned = await prisma.promptTemplate.findMany({
      where: { userId, deletedAt: null, name: { in: names } },
      select: { name: true },
    });

    const ownedNames = new Set(owned.map((template) => template.name));

    return styles
      .filter((style) => ownedNames.has(style.name))
      .map((style) => style.id);
  }

  /**
   * Soft-deletes a template, unless a series is written in it.
   *
   * `Series.promptTemplateId` is what decides how every episode of a show is
   * written, and the deletion here is soft — so without this check the row
   * would survive the delete, the series would keep pointing at it, and the
   * next scheduled run would fail inside a worker with `NotFoundError` at 09:00
   * on a Monday. Three of those pause the schedule. Refusing now, naming the
   * shows that use it, costs the operator one message; the alternative costs
   * them a fortnight of videos and a confusing failure log.
   */
  async remove(userId: string, id: string) {
    await this.get(userId, id);

    const series = await prisma.series.findMany({
      where: { promptTemplateId: id, userId, deletedAt: null },
      select: { name: true },
      take: 5,
    });

    if (series.length > 0) {
      throw new ConflictError(
        `This is the script style ${series.length === 1 ? "the" : ""} ${series
          .map((show) => `"${show.name}"`)
          .join(", ")} series ${series.length === 1 ? "is" : "are"} written with. ` +
          "Point it at another style first, or delete the series.",
      );
    }

    await prisma.promptTemplate.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }
}

export const promptTemplateService = new PromptTemplateService();
