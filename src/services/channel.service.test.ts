import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";

// Tests run against a real, shared Supabase database (see src/test/setup.ts).
// Every fixture this file creates is tagged with a run-unique token so that
// a concurrent test run — or the operator's own dev app — never has rows it
// owns touched, and this file never touches rows it doesn't own.
const RUN = randomUUID().slice(0, 8);
const YOUTUBE_CHANNEL_ID = `UC_${RUN}`;

let userId: string;

const TOKENS = {
  accessToken: "ya29.test-access-token",
  refreshToken: "1//test-refresh-token",
  expiresInSeconds: 3600,
  scopes: ["https://www.googleapis.com/auth/youtube.upload"],
};

async function cleanup() {
  await prisma.channel.deleteMany({
    where: { youtubeChannelId: YOUTUBE_CHANNEL_ID },
  });
}

beforeEach(async () => {
  await cleanup();
  userId = (await prisma.user.findFirstOrThrow()).id;
});

// Belt and suspenders: afterEach keeps each test isolated from the next,
// afterAll guarantees nothing from this file survives even if a test throws
// before its own assertions run.
afterEach(cleanup);
afterAll(cleanup);

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

    // Scope the assertion to rows this run created rather than assuming the
    // table (or even this user's channel list) contains nothing else —
    // a concurrent run may legitimately have its own channels for the same
    // shared test user.
    const mine = (await channelService.list(userId)).filter(
      (c) => c.youtubeChannelId === YOUTUBE_CHANNEL_ID,
    );
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

    const mine = (await channelService.list(userId)).filter(
      (c) => c.youtubeChannelId === YOUTUBE_CHANNEL_ID,
    );
    expect(mine).toHaveLength(0);
  });
});
