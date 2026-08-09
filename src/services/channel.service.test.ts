import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// that also holds the operator's real data. Every test in this file gets its
// own private, throwaway User (see src/test/fixtures.ts) instead of the
// operator's real account, so a connect() here can never collide with — and
// overwrite — a real Channel row, which is unique on [userId,
// youtubeChannelId]. Because the user is private to this one test, this
// file's own rows are the only rows it can ever see.
const RUN = randomUUID().slice(0, 8);
const YOUTUBE_CHANNEL_ID = `UC_${RUN}`;

let userId: string;

const TOKENS = {
  accessToken: "ya29.test-access-token",
  refreshToken: "1//test-refresh-token",
  expiresInSeconds: 3600,
  scopes: ["https://www.googleapis.com/auth/youtube.upload"],
};

beforeEach(async () => {
  userId = await createTestUser("channel");
});

// Deleting the user cascades away every fixture the test created.
afterEach(() => deleteTestUser(userId));

describe("channelService", () => {
  it("stores tokens encrypted, never in plaintext", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      ...TOKENS,
    });

    const row = await prisma.channel.findFirstOrThrow({
      where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
    });
    expect(row.accessToken).not.toContain("ya29.test-access-token");
    expect(row.refreshToken).not.toContain("1//test-refresh-token");
  });

  it("round-trips the access token through resolveAccessToken", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      ...TOKENS,
    });

    const channel = await prisma.channel.findFirstOrThrow({
      where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
    });
    expect(await channelService.resolveAccessToken(userId, channel.id)).toBe(
      "ya29.test-access-token",
    );
  });

  it("never leaks either token from list()", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
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
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      ...TOKENS,
    });
    await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics (renamed)",
      ...TOKENS,
      accessToken: "ya29.second-token",
    });

    // This user is private to this test, so its channel list is exactly
    // what this test created — reconnecting must have replaced the row
    // rather than duplicated it.
    const mine = await channelService.list(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("Money Mechanics (renamed)");
  });

  it("disconnect removes the stored tokens", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      ...TOKENS,
    });
    const channel = await prisma.channel.findFirstOrThrow({
      where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
    });

    await channelService.disconnect(userId, channel.id);

    const mine = await channelService.list(userId);
    expect(mine).toHaveLength(0);
  });
});
