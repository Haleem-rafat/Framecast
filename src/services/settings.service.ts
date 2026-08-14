import "server-only";

import type {
  AccentColour,
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
  accent: AccentColour;
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
  // GRAPHITE is not a colour, it is the monochrome the studio already renders
  // — so an operator who has never opened Settings sees no change at all.
  accent: "GRAPHITE",
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
    accent: row.accent,
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

/**
 * The two columns that decide what the studio looks like, and the only part of
 * `UserSetting` that is read on *every* dashboard page rather than on the
 * settings page alone.
 */
export interface AppearanceView {
  theme: ThemePreference;
  accent: AccentColour;
}

export const APPEARANCE_DEFAULTS: AppearanceView = {
  theme: SETTINGS_DEFAULTS.theme,
  accent: SETTINGS_DEFAULTS.accent,
};

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

  /**
   * What the dashboard layout needs to paint the first frame correctly.
   *
   * A separate, two-column read rather than `get()` because this one is on the
   * critical path of every authenticated page render, and the rest of the row —
   * tag arrays, bucket names, provider defaults — is of no interest to a
   * stylesheet. Same "reading is not consent to write" rule as `get()`: an
   * operator who has never saved gets the defaults and no row.
   */
  async appearance(userId: string): Promise<AppearanceView> {
    const row = await prisma.userSetting.findUnique({
      where: { userId },
      select: { theme: true, accent: true },
    });

    return row ?? APPEARANCE_DEFAULTS;
  }

  /**
   * Persists a theme change made from the top-bar toggle.
   *
   * Deliberately narrower than `update()`: the toggle knows one field and must
   * not be able to write the other eight, which is what sending the whole
   * `UpdateSettingsInput` would let it do. The upsert is what makes the toggle
   * work for an operator who has never opened Settings — until now their row
   * did not exist, which is a large part of why `theme` was never read back.
   */
  async updateTheme(
    userId: string,
    theme: ThemePreference,
  ): Promise<AppearanceView> {
    const row = await prisma.userSetting.upsert({
      where: { userId },
      create: { userId, theme },
      update: { theme },
      select: { theme: true, accent: true },
    });

    return row;
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
