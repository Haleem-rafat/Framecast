import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { brandService } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

let userId: string;
let channelId: string;

beforeEach(async () => {
  userId = await createTestUser("brand");
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Test channel",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  channelId = channel.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("brandService.resolve", () => {
  it("returns every default when the channel has no brand row", async () => {
    const brand = await brandService.resolve(channelId);

    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
    expect(brand.logoPath).toBeNull();
  });

  it("returns defaults for a null channel", async () => {
    // A video whose project has no channel assigned still renders.
    const brand = await brandService.resolve(null);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("merges a partial videoStyle over the defaults rather than replacing it", async () => {
    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: { durationSeconds: 0.25 } } },
    });

    const brand = await brandService.resolve(channelId);

    // The one named value wins; everything unnamed keeps its default, so a
    // brand that sets one field cannot silently blank the rest.
    expect(brand.videoStyle.transitions.durationSeconds).toBe(0.25);
    expect(brand.videoStyle.transitions.enabled).toBe(DEFAULT_STYLE.transitions.enabled);
    expect(brand.videoStyle.captions).toEqual(DEFAULT_STYLE.captions);
  });

  it("ignores a videoStyle that is not an object", async () => {
    // The column is Json; nothing stops a bad write. Rendering with garbage is
    // worse than rendering with defaults.
    await prisma.channelBrand.create({
      data: { channelId: channelId, videoStyle: "not an object" },
    });

    const brand = await brandService.resolve(channelId);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("returns the brand's own text fields when set", async () => {
    await prisma.channelBrand.create({
      data: {
        channelId,
        tone: "dry and factual",
        niche: "business history",
        musicQuery: "calm ambient documentary",
        primaryColour: "#FFCC00",
      },
    });

    const brand = await brandService.resolve(channelId);

    expect(brand.tone).toBe("dry and factual");
    expect(brand.niche).toBe("business history");
    expect(brand.musicQuery).toBe("calm ambient documentary");
    expect(brand.primaryColour).toBe("#FFCC00");
  });
});
