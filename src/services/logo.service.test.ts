import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { removeObjects } from "@/lib/storage";
import { channelService } from "@/services/channel.service";
import { LogoService } from "@/services/logo.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

let userId: string;
let channelId: string;
const storedPaths: string[] = [];

function fakeImageProvider() {
  return {
    generate: vi.fn().mockResolvedValue({
      data: Buffer.from(`logo-${RUN}`),
      model: "test/image-model",
    }),
  };
}

beforeEach(async () => {
  userId = await createTestUser("logo");
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
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

describe("LogoService.generateOptions", () => {
  it("generates the requested number of options and stores each", async () => {
    const images = fakeImageProvider();

    const paths = await new LogoService(images).generateOptions(userId, channelId, 3);
    storedPaths.push(...paths);

    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
    expect(images.generate).toHaveBeenCalledTimes(3);
    // A logo is square; a 16:9 logo is a banner.
    expect(images.generate.mock.calls[0][0].aspectRatio).toBe("1:1");
  });

  it("returns the options it did manage when one generation fails", async () => {
    const images = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({ data: Buffer.from("a"), model: "m" })
        .mockRejectedValueOnce(new Error("gateway down"))
        .mockResolvedValueOnce({ data: Buffer.from("c"), model: "m" }),
    };

    // Two usable logos to choose between beats an exception because the
    // middle one failed.
    const paths = await new LogoService(images).generateOptions(userId, channelId, 3);
    storedPaths.push(...paths);

    expect(paths).toHaveLength(2);
  });

  it("returns an empty list rather than throwing when every generation fails", async () => {
    const images = { generate: vi.fn().mockRejectedValue(new Error("down")) };

    expect(await new LogoService(images).generateOptions(userId, channelId, 2)).toEqual([]);
  });

  it("refuses a channel the caller does not own", async () => {
    const otherUserId = await createTestUser("logo-other");

    try {
      const images = fakeImageProvider();
      await expect(
        new LogoService(images).generateOptions(otherUserId, channelId, 1),
      ).rejects.toThrow();
      expect(images.generate).not.toHaveBeenCalled();
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("LogoService.choose", () => {
  it("stores the chosen logo, creating the brand row when there is none", async () => {
    const images = fakeImageProvider();
    const [first] = await new LogoService(images).generateOptions(userId, channelId, 1);
    storedPaths.push(first);

    // A channel may have no brand row yet — choosing a logo is often the first
    // branding action an operator takes.
    await new LogoService(images).choose(userId, channelId, first);

    const brand = await prisma.channelBrand.findUniqueOrThrow({ where: { channelId } });
    expect(brand.logoPath).toBe(first);
  });

  it("replaces a previously chosen logo without disturbing the rest of the brand", async () => {
    await prisma.channelBrand.create({
      data: { channelId, tone: "dry and factual", logoPath: "videos/old/logo.png" },
    });

    const images = fakeImageProvider();
    const [chosen] = await new LogoService(images).generateOptions(userId, channelId, 1);
    storedPaths.push(chosen);
    await new LogoService(images).choose(userId, channelId, chosen);

    const brand = await prisma.channelBrand.findUniqueOrThrow({ where: { channelId } });
    expect(brand.logoPath).toBe(chosen);
    expect(brand.tone).toBe("dry and factual");
  });
});
