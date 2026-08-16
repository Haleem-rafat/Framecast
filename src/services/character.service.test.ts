import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findArtStyle } from "@/lib/art-styles";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { objectSizeBytes, removeObjects } from "@/lib/storage";
import { CharacterService } from "@/services/character.service";
import { channelService } from "@/services/channel.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Real Postgres and the real storage root, one throwaway User per test — the
// same arrangement logo.service.test.ts uses. The image provider is always
// the injected fake below: a real generation is real money, and that seam is
// what lets this suite avoid spending it.
vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);
const BRIEF = "Pip, a small round brown bear cub with a cream muzzle and a red knitted scarf.";

let userId: string;
let channelId: string;
const storedPaths: string[] = [];

function fakeImageProvider() {
  return {
    generate: vi.fn().mockResolvedValue({
      data: Buffer.from(`sheet-${RUN}`),
      model: "openai/gpt-image-2",
      costUsd: 0.053,
    }),
  };
}

beforeEach(async () => {
  userId = await createTestUser("character");
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Moonlit Meadow Stories",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  channelId = channel.id;
});

afterEach(async () => {
  const paths = storedPaths.splice(0);
  if (paths.length > 0) {
    await removeObjects(paths).catch(() => {});
  }
  await deleteTestUser(userId);
});

async function saveBrief(
  brief: string | null,
  extra: { niche?: string; tone?: string; artStyle?: string | null } = {},
) {
  // An art style unless a test says otherwise: every other test in this file
  // is about the brief, and one missing prerequisite failing them all would
  // hide what they are actually checking.
  const fields = { characterBrief: brief, artStyle: "storybook-watercolour", ...extra };
  await prisma.channelBrand.upsert({
    where: { channelId },
    create: { channelId, ...fields },
    update: fields,
  });
}

describe("CharacterService.generateSheet", () => {
  it("draws one sheet, stores it, and makes it the channel's", async () => {
    await saveBrief(BRIEF);
    const images = fakeImageProvider();

    const sheet = await new CharacterService(images).generateSheet(userId, channelId);
    storedPaths.push(sheet.path);

    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(await objectSizeBytes(sheet.path)).toBeGreaterThan(0);

    const brand = await prisma.channelBrand.findUniqueOrThrow({ where: { channelId } });
    expect(brand.characterSheetPath).toBe(sheet.path);
  });

  it("puts the operator's own description into the prompt, verbatim", async () => {
    // The description is the whole input. A prompt that paraphrased it would
    // be a different character from the one the operator wrote down.
    await saveBrief(BRIEF, { niche: "bedtime stories", tone: "warm and gentle" });
    const images = fakeImageProvider();

    const sheet = await new CharacterService(images).generateSheet(userId, channelId);
    storedPaths.push(sheet.path);

    const prompt = images.generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(BRIEF);
    // The chosen style's own fragment, verbatim — the sheet and every scene
    // have to ask for the same look in the same words.
    expect(prompt).toContain(findArtStyle("storybook-watercolour")!.prompt);
    expect(prompt).toContain("bedtime stories");
    expect(prompt).toContain("warm and gentle");
    // Three views, because a single frontal reference is what practitioner
    // reports found insufficient the moment a scene turns the character.
    expect(prompt).toContain("three-quarter view");
    // Square: this picture is never composed into a video, only fed to other
    // generations.
    expect(images.generate.mock.calls[0][0].aspectRatio).toBe("1:1");
  });

  it("reports what the generation actually cost", async () => {
    await saveBrief(BRIEF);
    const images = fakeImageProvider();

    const sheet = await new CharacterService(images).generateSheet(userId, channelId);
    storedPaths.push(sheet.path);

    expect(sheet.costUsd).toBeCloseTo(0.053, 6);
  });

  it("writes a new filename each time, so a cached sheet is never swapped underneath", async () => {
    // `putObject` upserts. Reusing one path would change the bytes behind a
    // URL the branding screen is already showing and caching for an hour —
    // the same failure LogoService's batch token exists to prevent.
    await saveBrief(BRIEF);
    const images = fakeImageProvider();
    const service = new CharacterService(images);

    const first = await service.generateSheet(userId, channelId);
    const second = await service.generateSheet(userId, channelId);
    storedPaths.push(first.path, second.path);

    expect(second.path).not.toBe(first.path);
    // The old object is still there — anything holding the old URL keeps
    // resolving to the picture it was showing.
    expect(await objectSizeBytes(first.path)).toBeGreaterThan(0);

    const brand = await prisma.channelBrand.findUniqueOrThrow({ where: { channelId } });
    expect(brand.characterSheetPath).toBe(second.path);
  });

  it("refuses without spending anything when nobody has described the character", async () => {
    // Refused rather than defaulted: there is no sensible stand-in
    // protagonist, and inventing one would put an arbitrary character into
    // this channel and then hold it there for every video.
    await saveBrief("   ");
    const images = fakeImageProvider();

    await expect(
      new CharacterService(images).generateSheet(userId, channelId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.generate).not.toHaveBeenCalled();
  });

  it("draws in the channel's chosen style, not a default one", async () => {
    await saveBrief(BRIEF, { artStyle: "cut-paper" });
    const images = fakeImageProvider();

    const sheet = await new CharacterService(images).generateSheet(userId, channelId);
    storedPaths.push(sheet.path);

    const prompt = images.generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(findArtStyle("cut-paper")!.prompt);
    expect(prompt).not.toContain(findArtStyle("storybook-watercolour")!.prompt);
  });

  it("refuses without spending anything when no art style is chosen", async () => {
    // Refused rather than defaulted. A fallback look would give every channel
    // that skipped this the same one, which is the opposite of the feature.
    await saveBrief(BRIEF, { artStyle: null });
    const images = fakeImageProvider();

    await expect(
      new CharacterService(images).generateSheet(userId, channelId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.generate).not.toHaveBeenCalled();
  });

  it("refuses when the stored style is one this app no longer offers", async () => {
    // The column is plain text so a retired slug is possible; resolving to
    // null and asking the operator to pick again beats a failed deploy.
    await saveBrief(BRIEF, { artStyle: "chalk-pastel-retired" });
    const images = fakeImageProvider();

    await expect(
      new CharacterService(images).generateSheet(userId, channelId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.generate).not.toHaveBeenCalled();
  });

  it("refuses for a channel with no brand row at all", async () => {
    const images = fakeImageProvider();

    await expect(
      new CharacterService(images).generateSheet(userId, channelId),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(images.generate).not.toHaveBeenCalled();
  });

  it("never draws for another operator's channel", async () => {
    // Ownership is proven before a single image is generated — these cost
    // money, and a foreign channel must not be able to spend the operator's.
    await saveBrief(BRIEF);
    const otherUserId = await createTestUser("character-other");
    const images = fakeImageProvider();

    try {
      await expect(
        new CharacterService(images).generateSheet(otherUserId, channelId),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(images.generate).not.toHaveBeenCalled();

      const brand = await prisma.channelBrand.findUniqueOrThrow({ where: { channelId } });
      expect(brand.characterSheetPath).toBeNull();
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});
