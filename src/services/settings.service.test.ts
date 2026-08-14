import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { createTestUser, deleteTestUser } from "@/test/fixtures";
import { promptTemplateService } from "@/services/prompt-template.service";
import {
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
