import "server-only";

import type {
  AiProviderType,
  PublishVisibility,
  ThemePreference,
} from "@/generated/prisma/enums";
import type { UserSetting } from "@/generated/prisma/client";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { UpdateSettingsInput } from "@/schemas/settings.schema";

/**
 * What the settings page renders. Deliberately not `UserSetting` itself: the
 * row's `id`, `userId` and `createdAt` are of no interest to any caller, and
 * `updatedAt` is widened to nullable so "never saved" is representable — the
 * common case, since a `UserSetting` row is only created on first save.
 */
export interface UserSettingsView {
  theme: ThemePreference;
  defaultScriptProvider: AiProviderType;
  defaultVoiceProvider: AiProviderType;
  defaultVoiceId: string | null;
  defaultVisibility: PublishVisibility;
  defaultTags: string[];
  storageBucket: string | null;
  defaultScriptPromptId: string | null;
  /** Null until the operator has saved at least once. */
  updatedAt: Date | null;
}

/**
 * Mirrors the column defaults in prisma/schema.prisma. Kept in step by hand:
 * Prisma applies `@default` on INSERT, so a user with no row yet would
 * otherwise have nothing to render, and defaulting in the component would put
 * the same constants in two places with no relationship between them.
 */
export const SETTINGS_DEFAULTS: UserSettingsView = {
  theme: "SYSTEM",
  defaultScriptProvider: "OPENAI",
  defaultVoiceProvider: "ELEVENLABS",
  defaultVoiceId: null,
  defaultVisibility: "PRIVATE",
  defaultTags: [],
  storageBucket: null,
  defaultScriptPromptId: null,
  updatedAt: null,
};

/** Field-by-field rather than a spread, so `id` and `userId` can never leak. */
function toView(row: UserSetting): UserSettingsView {
  return {
    theme: row.theme,
    defaultScriptProvider: row.defaultScriptProvider,
    defaultVoiceProvider: row.defaultVoiceProvider,
    defaultVoiceId: row.defaultVoiceId,
    defaultVisibility: row.defaultVisibility,
    defaultTags: row.defaultTags,
    storageBucket: row.storageBucket,
    defaultScriptPromptId: row.defaultScriptPromptId,
    updatedAt: row.updatedAt,
  };
}

export class SettingsService {
  /**
   * Never writes. A page load is not consent to create a row, and returning
   * the schema defaults for an absent row is indistinguishable to the caller
   * from having created one — without leaving a `UserSetting` behind for every
   * operator who merely opened the page.
   */
  async get(userId: string): Promise<UserSettingsView> {
    const row = await prisma.userSetting.findUnique({ where: { userId } });

    return row ? toView(row) : SETTINGS_DEFAULTS;
  }

  async update(
    userId: string,
    input: UpdateSettingsInput,
  ): Promise<UserSettingsView> {
    // `defaultScriptPromptId` is a bare uuid column with no foreign key, so
    // the database will happily store a pointer to another operator's
    // template. The value arrives from a client-controlled `<Select>`, so
    // ownership has to be proven here rather than assumed from the fact that
    // the dropdown only listed this operator's own templates.
    if (input.defaultScriptPromptId) {
      const owned = await prisma.promptTemplate.findFirst({
        where: { id: input.defaultScriptPromptId, userId, deletedAt: null },
        select: { id: true },
      });

      if (!owned) {
        throw new NotFoundError("Prompt template");
      }
    }

    const row = await prisma.userSetting.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });

    return toView(row);
  }
}

export const settingsService = new SettingsService();
