import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { findScriptStyle, SCRIPT_STYLES } from "@/lib/script-styles";
import { promptTemplateService } from "@/services/prompt-template.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
// that also holds the operator's real data, so every test here gets its own
// throwaway User — see src/test/fixtures.ts for what happened before that was
// true.
let userId: string;

const KIDS_STYLE = findScriptStyle("childrens-content")!;

beforeEach(async () => {
  userId = await createTestUser("prompt-template");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("promptTemplateService.addScriptStyle", () => {
  it("copies a built-in style into the operator's own library", async () => {
    const added = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );

    expect(added.name).toBe(KIDS_STYLE.name);
    expect(added.restored).toBe(false);

    const template = await promptTemplateService.get(userId, added.id);
    expect(template.content).toBe(KIDS_STYLE.content);
    expect(template.category).toBe("SCRIPT");
    expect(template.description).toBe(KIDS_STYLE.description);

    // Variables come across too — a copy without them renders every
    // placeholder literally, which is the failure `renderTemplate`'s
    // "definitions are authoritative" rule turns into a visible one.
    expect(template.variables.map((one) => one.key).sort()).toEqual(
      KIDS_STYLE.variables.map((one) => one.key).sort(),
    );
    expect(
      template.variables.find((one) => one.key === "topic")?.required,
    ).toBe(true);
    expect(
      template.variables.find((one) => one.key === "duration")?.defaultValue,
    ).toBe("4");
  });

  it("refuses a second add, and leaves the operator's edits untouched", async () => {
    // The behaviour chosen over suffixing the name: two templates called
    // "Children's content" and "Children's content (2)" are indistinguishable
    // in every list in the app, and by the time somebody adds a style twice
    // the first copy is usually the one they have been editing.
    const added = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );

    const edited = "Write a two-minute script about {{topic}} for my own channel.";
    await promptTemplateService.update(userId, added.id, {
      name: KIDS_STYLE.name,
      description: "My version",
      category: "SCRIPT",
      content: edited,
      isDefault: false,
      variables: [{ key: "topic", label: "Topic", required: true }],
    });

    await expect(
      promptTemplateService.addScriptStyle(userId, KIDS_STYLE.id),
    ).rejects.toThrow(ConflictError);

    // The refusal names the template rather than reporting a constraint.
    await expect(
      promptTemplateService.addScriptStyle(userId, KIDS_STYLE.id),
    ).rejects.toThrow(/already in your library/);

    // And nothing was overwritten — the assertion that matters most here.
    const after = await promptTemplateService.get(userId, added.id);
    expect(after.content).toBe(edited);
    expect(after.description).toBe("My version");
    expect(after.variables).toHaveLength(1);
  });

  it("restores a style the operator had deleted, rather than failing on the unique name", async () => {
    // `deletedAt` is a soft delete; `@@unique([userId, name])` is not. A plain
    // create would fail on the constraint with nothing an operator could act
    // on, so re-adding a removed style brings it back.
    const added = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );
    await promptTemplateService.remove(userId, added.id);

    const again = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );

    expect(again.id).toBe(added.id);
    expect(again.restored).toBe(true);

    const template = await promptTemplateService.get(userId, again.id);
    expect(template.content).toBe(KIDS_STYLE.content);
    expect(template.deletedAt).toBeNull();
  });

  it("claims the category default only when the operator has none", async () => {
    // Adding a style must never silently repoint every future generation at
    // it. Which template a video uses is chosen per video in the script
    // panel, not as a side effect of browsing.
    const first = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );
    expect(first.becameDefault).toBe(true);

    const second = await promptTemplateService.addScriptStyle(
      userId,
      "myths-and-facts",
    );
    expect(second.becameDefault).toBe(false);

    const defaultTemplate = await promptTemplateService.getDefault(userId, "SCRIPT");
    expect(defaultTemplate.id).toBe(first.id);
  });

  it("refuses a style id that is not in the catalogue", async () => {
    // The add action takes an id and nothing else, so this is also the check
    // that stops a request storing arbitrary prompt text as a shipped style.
    await expect(
      promptTemplateService.addScriptStyle(userId, "not-a-style"),
    ).rejects.toThrow(NotFoundError);

    expect(await prisma.promptTemplate.count({ where: { userId } })).toBe(0);
  });

  it("scopes the copy to the operator who added it", async () => {
    const otherUserId = await createTestUser("prompt-template-other");

    try {
      await promptTemplateService.addScriptStyle(userId, KIDS_STYLE.id);

      // Same style, same name, different owner — and no conflict, because the
      // unique key is on (userId, name).
      const theirs = await promptTemplateService.addScriptStyle(
        otherUserId,
        KIDS_STYLE.id,
      );

      expect(
        await prisma.promptTemplate.count({ where: { userId } }),
      ).toBe(1);
      await expect(
        promptTemplateService.get(userId, theirs.id),
      ).rejects.toThrow(NotFoundError);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("promptTemplateService.listOwnedScriptStyleIds", () => {
  it("reports nothing for a library with no styles in it", async () => {
    expect(
      await promptTemplateService.listOwnedScriptStyleIds(userId, SCRIPT_STYLES),
    ).toEqual([]);
  });

  it("reports the styles this operator holds, and nobody else's", async () => {
    const otherUserId = await createTestUser("prompt-owned-other");

    try {
      await promptTemplateService.addScriptStyle(userId, KIDS_STYLE.id);
      await promptTemplateService.addScriptStyle(otherUserId, "countdown");

      expect(
        await promptTemplateService.listOwnedScriptStyleIds(userId, SCRIPT_STYLES),
      ).toEqual([KIDS_STYLE.id]);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("stops reporting a style once it is deleted", async () => {
    const added = await promptTemplateService.addScriptStyle(
      userId,
      KIDS_STYLE.id,
    );
    await promptTemplateService.remove(userId, added.id);

    expect(
      await promptTemplateService.listOwnedScriptStyleIds(userId, SCRIPT_STYLES),
    ).toEqual([]);
  });
});

describe("promptTemplateService.listForCategory", () => {
  it("returns this operator's templates in one category, default first", async () => {
    await promptTemplateService.addScriptStyle(userId, KIDS_STYLE.id);
    await promptTemplateService.addScriptStyle(userId, "countdown");
    await promptTemplateService.create(userId, {
      name: "A thumbnail prompt",
      category: "THUMBNAIL",
      content: "An image of {{topic}}",
      isDefault: false,
      variables: [],
    });

    const options = await promptTemplateService.listForCategory(userId, "SCRIPT");

    expect(options).toHaveLength(2);
    // The first add claimed the default (the operator had none), so it leads.
    expect(options[0].name).toBe(KIDS_STYLE.name);
    expect(options[0].isDefault).toBe(true);
    expect(options.every((option) => option.name !== "A thumbnail prompt")).toBe(
      true,
    );
  });

  it("never returns another operator's templates", async () => {
    const otherUserId = await createTestUser("prompt-category-other");

    try {
      await promptTemplateService.addScriptStyle(otherUserId, KIDS_STYLE.id);

      expect(
        await promptTemplateService.listForCategory(userId, "SCRIPT"),
      ).toEqual([]);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});
