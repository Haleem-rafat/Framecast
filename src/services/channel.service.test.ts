import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { FetchLike } from "@/services/channel.service";
import {
  CHANNEL_CONNECTED_ACTION,
  CHANNEL_TOKEN_REVOKED_ACTION,
  ChannelService,
  channelService,
} from "@/services/channel.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
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

  it("get returns one channel without its tokens", async () => {
    const connected = await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      handle: "@moneymechanics",
      ...TOKENS,
    });

    const channel = await channelService.get(userId, connected.id);

    expect(channel.title).toBe("Money Mechanics");
    expect(channel.handle).toBe("@moneymechanics");
    // `SUMMARY_SELECT` omits them by construction rather than filtering them
    // out afterwards, so this door cannot leak them either.
    expect(channel).not.toHaveProperty("accessToken");
    expect(channel).not.toHaveProperty("refreshToken");
  });

  it("get refuses another operator's channel, and a disconnected one", async () => {
    // The branding route reaches this straight from a URL, so a foreign or
    // invented id has to be indistinguishable — both are NotFoundError, which
    // the route turns into a 404 rather than an answer to "does this exist".
    const connected = await channelService.connect(userId, {
      youtubeChannelId: YOUTUBE_CHANNEL_ID,
      title: "Money Mechanics",
      ...TOKENS,
    });

    const otherUserId = await createTestUser("channel-other");

    try {
      await expect(
        channelService.get(otherUserId, connected.id),
      ).rejects.toThrow(NotFoundError);
    } finally {
      await deleteTestUser(otherUserId);
    }

    // Disconnect is a soft delete, so the row survives an id somebody kept.
    await channelService.disconnect(userId, connected.id);
    await expect(channelService.get(userId, connected.id)).rejects.toThrow(
      NotFoundError,
    );
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

  // Google access tokens expire after ~1h. `resolveAccessToken` refreshes
  // them transparently rather than handing back a token that will fail the
  // caller's next request minutes later. `fetch` is injected here so these
  // tests never hit Google's real token endpoint.
  describe("resolveAccessToken — refresh", () => {
    function stubFetch(
      response: { access_token: string; expires_in: number; refresh_token?: string },
      ok = true,
    ): { fetchImpl: FetchLike; calls: unknown[] } {
      const calls: unknown[] = [];
      const fetchImpl: FetchLike = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        calls.push({ input, init });
        return {
          ok,
          status: ok ? 200 : 400,
          json: async () => response,
        } as Response;
      }) as FetchLike;
      return { fetchImpl, calls };
    }

    it("does not refresh when the token is not close to expiring", async () => {
      await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Money Mechanics",
        ...TOKENS, // expiresInSeconds: 3600 — an hour away, well outside the 5-minute window.
      });
      const channel = await prisma.channel.findFirstOrThrow({
        where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
      });

      const { fetchImpl, calls } = stubFetch({
        access_token: "ya29.should-not-be-used",
        expires_in: 3600,
      });
      const service = new ChannelService(fetchImpl);

      const token = await service.resolveAccessToken(userId, channel.id);

      expect(token).toBe("ya29.test-access-token");
      expect(calls).toHaveLength(0);
    });

    it("refreshes and persists a new access token when the stored one is near expiry", async () => {
      await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Money Mechanics",
        ...TOKENS,
      });
      const channel = await prisma.channel.findFirstOrThrow({
        where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
      });
      // Inside the 5-minute refresh window.
      await prisma.channel.update({
        where: { id: channel.id },
        data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
      });

      const { fetchImpl, calls } = stubFetch({
        access_token: "ya29.refreshed-token",
        expires_in: 3600,
        // Google does not always return a new refresh token on this exchange.
      });
      const service = new ChannelService(fetchImpl);

      const token = await service.resolveAccessToken(userId, channel.id);

      expect(token).toBe("ya29.refreshed-token");
      expect(calls).toHaveLength(1);

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
      expect(row.accessToken).not.toContain("ya29.refreshed-token"); // stored encrypted
      // The refresh moved the row's expiry an hour out, so a second call
      // (even against the default singleton, with its real fetch) returns
      // the persisted refreshed token without refreshing again.
      expect(row.tokenExpiresAt).not.toBeNull();
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
      expect(await channelService.resolveAccessToken(userId, channel.id)).toBe(
        "ya29.refreshed-token",
      );
    });

    it("keeps the existing refresh token when Google does not return a new one", async () => {
      await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Money Mechanics",
        ...TOKENS,
      });
      const channel = await prisma.channel.findFirstOrThrow({
        where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
      });
      await prisma.channel.update({
        where: { id: channel.id },
        data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
      });

      const { fetchImpl } = stubFetch({
        access_token: "ya29.refreshed-token-2",
        expires_in: 3600,
        // No refresh_token in the response.
      });
      const service = new ChannelService(fetchImpl);
      await service.resolveAccessToken(userId, channel.id);

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
      const { decryptSecret } = await import("@/lib/crypto");
      expect(row.refreshToken).not.toBeNull();
      expect(decryptSecret(row.refreshToken!)).toBe("1//test-refresh-token");
    });

    it("replaces the refresh token when Google does return a new one", async () => {
      await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Money Mechanics",
        ...TOKENS,
      });
      const channel = await prisma.channel.findFirstOrThrow({
        where: { userId, youtubeChannelId: YOUTUBE_CHANNEL_ID },
      });
      await prisma.channel.update({
        where: { id: channel.id },
        data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
      });

      const { fetchImpl } = stubFetch({
        access_token: "ya29.refreshed-token-3",
        expires_in: 3600,
        refresh_token: "1//new-refresh-token",
      });
      const service = new ChannelService(fetchImpl);
      await service.resolveAccessToken(userId, channel.id);

      const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
      const { decryptSecret } = await import("@/lib/crypto");
      expect(row.refreshToken).not.toBeNull();
      expect(decryptSecret(row.refreshToken!)).toBe("1//new-refresh-token");
    });
  });

  // A dead refresh token is reported with its age, because Google kills tokens
  // issued to an OAuth app in Testing after exactly seven days with the same
  // invalid_grant it uses for a real revocation. Age is the only tell.
  describe("resolveAccessToken — a refused refresh token", () => {
    const DAY = 24 * 60 * 60 * 1000;

    function refusingFetch(status: number, body: object): FetchLike {
      return (async () =>
        ({
          ok: false,
          status,
          text: async () => JSON.stringify(body),
        }) as Response) as FetchLike;
    }

    const INVALID_GRANT = {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    };

    /** Connects, forces the next call to refresh, and backdates the connection. */
    async function connectedDaysAgo(days: number): Promise<string> {
      const summary = await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Dev Pixel",
        ...TOKENS,
      });
      await prisma.channel.update({
        where: { id: summary.id },
        data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
      });
      await prisma.activityLog.updateMany({
        where: { entityId: summary.id, action: CHANNEL_CONNECTED_ACTION },
        data: { createdAt: new Date(Date.now() - days * DAY) },
      });
      return summary.id;
    }

    it("records each (re)connection, which is what the age is measured from", async () => {
      const summary = await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Dev Pixel",
        ...TOKENS,
      });
      await channelService.connect(userId, {
        youtubeChannelId: YOUTUBE_CHANNEL_ID,
        title: "Dev Pixel",
        ...TOKENS,
      });

      expect(
        await prisma.activityLog.count({
          where: { userId, entityId: summary.id, action: CHANNEL_CONNECTED_ACTION },
        }),
      ).toBe(2);
    });

    it("names Testing mode when the token died seven days after connecting", async () => {
      const channelId = await connectedDaysAgo(7.1);
      const service = new ChannelService(refusingFetch(400, INVALID_GRANT));

      const error = await service.resolveAccessToken(userId, channelId).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect((error as ProviderError).message).toMatch(/Testing/);
      expect((error as ProviderError).message).toContain("Publishing status → Publish app");

      const logged = await prisma.activityLog.findFirstOrThrow({
        where: { userId, entityId: channelId, action: CHANNEL_TOKEN_REVOKED_ACTION },
      });
      expect(logged.level).toBe("ERROR");
      expect(logged.metadata).toMatchObject({
        googleError: "invalid_grant",
        likelyTestingMode: true,
      });
      expect((logged.metadata as { tokenAgeHours: number }).tokenAgeHours).toBeCloseTo(
        7.1 * 24,
        0,
      );
    });

    it("logs one row per dead token and keeps measuring to the first refusal", async () => {
      const channelId = await connectedDaysAgo(7.1);
      const service = new ChannelService(refusingFetch(400, INVALID_GRANT));

      await service.resolveAccessToken(userId, channelId).catch(() => undefined);
      // Days later the collector tries again. Measured to now this would be
      // 20 days and read as "not Testing mode"; measured to the first refusal
      // it is still 7.
      await prisma.activityLog.updateMany({
        where: { entityId: channelId, action: CHANNEL_TOKEN_REVOKED_ACTION },
        data: { createdAt: new Date(Date.now() - 13 * DAY) },
      });
      await prisma.activityLog.updateMany({
        where: { entityId: channelId, action: CHANNEL_CONNECTED_ACTION },
        data: { createdAt: new Date(Date.now() - 20 * DAY) },
      });
      const second = (await service
        .resolveAccessToken(userId, channelId)
        .catch((e: unknown) => e)) as ProviderError;

      expect(second.message).toMatch(/Testing/);
      expect(
        await prisma.activityLog.count({
          where: { entityId: channelId, action: CHANNEL_TOKEN_REVOKED_ACTION },
        }),
      ).toBe(1);
    });

    it("does not blame Testing mode for a token revoked two days in", async () => {
      const channelId = await connectedDaysAgo(2);
      const service = new ChannelService(refusingFetch(400, INVALID_GRANT));

      const error = (await service
        .resolveAccessToken(userId, channelId)
        .catch((e: unknown) => e)) as ProviderError;

      expect(error.message).not.toMatch(/Testing/);
      expect(error.message).toContain("2 days old");
      expect(error.message).toMatch(/reconnect the channel/i);
    });

    // Reconnecting starts a new token, so a later refusal is measured from the
    // new connection and logged afresh.
    it("measures a reconnected channel from the reconnection", async () => {
      const channelId = await connectedDaysAgo(7.1);
      const service = new ChannelService(refusingFetch(400, INVALID_GRANT));
      await service.resolveAccessToken(userId, channelId).catch(() => undefined);
      await prisma.activityLog.updateMany({
        where: { entityId: channelId },
        data: { createdAt: new Date(Date.now() - 10 * DAY) },
      });

      await connectedDaysAgo(1);
      const error = (await service
        .resolveAccessToken(userId, channelId)
        .catch((e: unknown) => e)) as ProviderError;

      expect(error.message).not.toMatch(/Testing/);
      expect(error.message).toContain("1 day old");
      expect(
        await prisma.activityLog.count({
          where: { entityId: channelId, action: CHANNEL_TOKEN_REVOKED_ACTION },
        }),
      ).toBe(2);
    });

    it("keeps a misconfigured client out of the revoked path entirely", async () => {
      const channelId = await connectedDaysAgo(7.1);
      const service = new ChannelService(
        refusingFetch(401, { error: "invalid_client", error_description: "Unauthorized" }),
      );

      const error = (await service
        .resolveAccessToken(userId, channelId)
        .catch((e: unknown) => e)) as ProviderError;

      expect(error.message).toMatch(/deployment's Google credentials/);
      expect(error.message).not.toMatch(/Testing/);
      expect(
        await prisma.activityLog.count({
          where: { entityId: channelId, action: CHANNEL_TOKEN_REVOKED_ACTION },
        }),
      ).toBe(0);
    });

    it("reports an unreachable Google as retryable, not as a revoked grant", async () => {
      const channelId = await connectedDaysAgo(7.1);
      const service = new ChannelService((async () => {
        throw new TypeError("fetch failed");
      }) as FetchLike);

      const error = (await service
        .resolveAccessToken(userId, channelId)
        .catch((e: unknown) => e)) as ProviderError;

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.retryable).toBe(true);
      expect(error.message).not.toMatch(/revoked|Testing/);
    });
  });
});
