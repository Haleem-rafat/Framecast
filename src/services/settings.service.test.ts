import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { createTestUser, deleteTestUser } from "@/test/fixtures";
import { accentColours } from "@/schemas/settings.schema";
import { promptTemplateService } from "@/services/prompt-template.service";
import {
  APPEARANCE_DEFAULTS,
  SETTINGS_DEFAULTS,
  settingsService,
} from "@/services/settings.service";

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("settings");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

/** Every required field, so each test only has to state what it cares about. */
function validInput(overrides: Partial<Parameters<typeof settingsService.update>[1]> = {}) {
  return {
    theme: "DARK" as const,
    accent: "INDIGO" as const,
    defaultScriptProvider: "ANTHROPIC" as const,
    defaultVoiceProvider: "ELEVENLABS" as const,
    defaultVoiceId: null,
    defaultVisibility: "UNLISTED" as const,
    defaultTags: [],
    storageBucket: null,
    defaultScriptPromptId: null,
    ...overrides,
  };
}

describe("settingsService.get", () => {
  it("returns the schema defaults for a user with no row, without creating one", async () => {
    const settings = await settingsService.get(userId);

    expect(settings).toEqual(SETTINGS_DEFAULTS);
    expect(settings.updatedAt).toBeNull();
    // Merely reading must not leave a row behind.
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(0);
  });
});

describe("settingsService.appearance", () => {
  it("returns the monochrome default for a user with no row, without creating one", async () => {
    // The whole promise of the migration: an operator who has never touched
    // Settings keeps the studio exactly as it shipped. GRAPHITE emits no CSS
    // at all (see src/lib/accent.ts), so "default" here means "unchanged".
    const appearance = await settingsService.appearance(userId);

    expect(appearance).toEqual(APPEARANCE_DEFAULTS);
    expect(appearance.accent).toBe("GRAPHITE");
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(0);
  });

  it("reads back what update() saved", async () => {
    await settingsService.update(userId, validInput({ accent: "TEAL" }));

    expect(await settingsService.appearance(userId)).toEqual({
      theme: "DARK",
      accent: "TEAL",
    });
  });

  it("is scoped to the user asking", async () => {
    // Appearance is read on every authenticated page render, so a leak here
    // would repaint one operator's studio in another's accent.
    const otherUserId = await createTestUser("settings-appearance");

    try {
      await settingsService.update(userId, validInput({ accent: "ROSE" }));

      expect(await settingsService.appearance(otherUserId)).toEqual(
        APPEARANCE_DEFAULTS,
      );
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("settingsService.updateTheme", () => {
  it("creates the row for an operator who has never opened Settings", async () => {
    // This is what made `theme` unusable before: the top-bar toggle had no way
    // to record anything, because most operators have no UserSetting row at
    // all. The upsert is the fix.
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(0);

    const appearance = await settingsService.updateTheme(userId, "DARK");

    expect(appearance).toEqual({ theme: "DARK", accent: "GRAPHITE" });
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(1);
  });

  it("leaves every other setting alone", async () => {
    await settingsService.update(
      userId,
      validInput({
        theme: "LIGHT",
        accent: "EMERALD",
        defaultTags: ["finance"],
        storageBucket: "framecast-media",
      }),
    );

    await settingsService.updateTheme(userId, "SYSTEM");

    const settings = await settingsService.get(userId);

    expect(settings.theme).toBe("SYSTEM");
    // The toggle knows about one column and must not be able to reset the
    // other eight to their defaults on the way past.
    expect(settings.accent).toBe("EMERALD");
    expect(settings.defaultTags).toEqual(["finance"]);
    expect(settings.storageBucket).toBe("framecast-media");
  });

  it("does not touch another operator's row", async () => {
    const otherUserId = await createTestUser("settings-theme");

    try {
      await settingsService.updateTheme(otherUserId, "DARK");
      await settingsService.updateTheme(userId, "LIGHT");

      expect((await settingsService.appearance(otherUserId)).theme).toBe("DARK");
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("settingsService.update", () => {
  it("creates the row on first save and updates it on the second", async () => {
    const created = await settingsService.update(
      userId,
      validInput({ defaultTags: ["finance", "explainer"] }),
    );

    expect(created.theme).toBe("DARK");
    expect(created.defaultTags).toEqual(["finance", "explainer"]);
    expect(created.updatedAt).not.toBeNull();
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(1);

    const updated = await settingsService.update(
      userId,
      validInput({ theme: "LIGHT", defaultVoiceId: "abc123" }),
    );

    expect(updated.theme).toBe("LIGHT");
    expect(updated.defaultVoiceId).toBe("abc123");
    // Still one row — the second save must not have inserted a duplicate.
    expect(await prisma.userSetting.count({ where: { userId } })).toBe(1);
  });

  it("stores every accent the picker offers", async () => {
    // The swatch tuple in settings.schema.ts is hand-maintained against the
    // Prisma enum, so this walks all eleven through a real INSERT. A member
    // added to the picker but not to the database fails here rather than as a
    // runtime error the first time somebody chooses it.
    for (const accent of accentColours) {
      const saved = await settingsService.update(userId, validInput({ accent }));

      expect(saved.accent).toBe(accent);
    }

    expect(await prisma.userSetting.count({ where: { userId } })).toBe(1);
  });

  it("round-trips through get", async () => {
    await settingsService.update(
      userId,
      validInput({ storageBucket: "framecast-media" }),
    );

    const settings = await settingsService.get(userId);

    expect(settings.storageBucket).toBe("framecast-media");
    expect(settings.defaultVisibility).toBe("UNLISTED");
  });

  it("accepts a script template the user owns", async () => {
    const template = await promptTemplateService.create(userId, {
      name: "My script prompt",
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: false,
      variables: [],
    });

    const settings = await settingsService.update(
      userId,
      validInput({ defaultScriptPromptId: template.id }),
    );

    expect(settings.defaultScriptPromptId).toBe(template.id);
  });

  it("refuses a script template belonging to another user", async () => {
    // `defaultScriptPromptId` has no foreign key, so nothing but this check
    // stops one operator pinning another operator's template.
    const otherUserId = await createTestUser("settings-other");

    try {
      const theirTemplate = await promptTemplateService.create(otherUserId, {
        name: "Their script prompt",
        category: "SCRIPT",
        content: "Write a script about {{topic}}.",
        isDefault: false,
        variables: [],
      });

      await expect(
        settingsService.update(
          userId,
          validInput({ defaultScriptPromptId: theirTemplate.id }),
        ),
      ).rejects.toThrow(NotFoundError);

      // The rejected save must not have written anything at all.
      expect(await prisma.userSetting.count({ where: { userId } })).toBe(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});
