import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";

let userId: string;

const TOKENS = {
  accessToken: "ya29.test-access-token",
  refreshToken: "1//test-refresh-token",
  expiresInSeconds: 3600,
  scopes: ["https://www.googleapis.com/auth/youtube.upload"],
};

beforeEach(async () => {
  await prisma.channel.deleteMany();
  userId = (await prisma.user.findFirstOrThrow()).id;
});

describe("channelService", () => {
  it("stores tokens encrypted, never in plaintext", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const row = await prisma.channel.findFirstOrThrow({ where: { userId } });
    expect(row.accessToken).not.toContain("ya29.test-access-token");
    expect(row.refreshToken).not.toContain("1//test-refresh-token");
  });

  it("round-trips the access token through resolveAccessToken", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const channel = await prisma.channel.findFirstOrThrow({ where: { userId } });
    expect(await channelService.resolveAccessToken(userId, channel.id)).toBe(
      "ya29.test-access-token",
    );
  });

  it("never leaks either token from list()", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const all = await channelService.list(userId);
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain("accessToken");
    expect(serialised).not.toContain("refreshToken");
  });

  it("reconnecting the same channel replaces the tokens rather than duplicating", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics (renamed)",
      ...TOKENS,
      accessToken: "ya29.second-token",
    });

    const all = await channelService.list(userId);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Money Mechanics (renamed)");
  });

  it("disconnect removes the stored tokens", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });
    const channel = await prisma.channel.findFirstOrThrow({ where: { userId } });

    await channelService.disconnect(userId, channel.id);

    expect(await channelService.list(userId)).toHaveLength(0);
  });
});
