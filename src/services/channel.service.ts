import "server-only";

import { env } from "@/config/env";
import { NotFoundError, ProviderError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import type { YouTubeTokens } from "@/lib/youtube-oauth";

/** Injectable so tests never make a real call to Google's token endpoint. */
export type FetchLike = typeof fetch;

/** Google access tokens last ~1h; refresh a little early rather than racing
 * an upload that starts mid-request against the exact expiry instant. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface ChannelSummary {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  isActive: boolean;
  connectedAt: Date;
}

export interface ConnectChannelInput extends YouTubeTokens {
  youtubeChannelId: string;
  title: string;
  handle?: string | null;
  description?: string | null;
  thumbnailUrl?: string | null;
}

/**
 * Rows this service is allowed to hand back to callers. `accessToken` and
 * `refreshToken` are omitted by construction — not filtered out after the
 * fact — so a future column can never leak through `list()` by accident.
 */
const SUMMARY_SELECT = {
  id: true,
  youtubeChannelId: true,
  title: true,
  handle: true,
  description: true,
  thumbnailUrl: true,
  isActive: true,
  connectedAt: true,
} as const;

/**
 * Owns the one place `Channel.accessToken` / `Channel.refreshToken` are ever
 * decrypted. Every other consumer works from `ChannelSummary`.
 */
export class ChannelService {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async list(userId: string): Promise<ChannelSummary[]> {
    return prisma.channel.findMany({
      where: { userId, deletedAt: null },
      orderBy: { connectedAt: "desc" },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * One channel, for the page that is about a single channel.
   *
   * Scoped by `userId` in the query rather than fetched and checked
   * afterwards, so a foreign id and an invented one are indistinguishable —
   * both are `NotFoundError`, which the route turns into a 404. The same
   * `SUMMARY_SELECT` as `list`, so the tokens cannot leak through this door
   * either.
   */
  async get(userId: string, channelId: string): Promise<ChannelSummary> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: SUMMARY_SELECT,
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    return channel;
  }

  /**
   * Upserts on `[userId, youtubeChannelId]` so reconnecting the same channel
   * replaces its tokens and metadata rather than creating a duplicate row.
   */
  async connect(
    userId: string,
    input: ConnectChannelInput,
  ): Promise<ChannelSummary> {
    const {
      youtubeChannelId,
      title,
      handle = null,
      description = null,
      thumbnailUrl = null,
      accessToken,
      refreshToken,
      expiresInSeconds,
      scopes,
    } = input;

    const encryptedAccessToken = encryptSecret(accessToken);
    const encryptedRefreshToken = encryptSecret(refreshToken);
    const tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    return prisma.channel.upsert({
      where: { userId_youtubeChannelId: { userId, youtubeChannelId } },
      create: {
        userId,
        youtubeChannelId,
        title,
        handle,
        description,
        thumbnailUrl,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt,
        scopes,
        isActive: true,
        deletedAt: null,
      },
      update: {
        title,
        handle,
        description,
        thumbnailUrl,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt,
        scopes,
        isActive: true,
        deletedAt: null,
      },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * Hard delete. Leaving encrypted upload credentials behind after the
   * operator asks to disconnect is not acceptable, and `Publication.channelId`
   * cascades so its publish history goes with it.
   */
  async disconnect(userId: string, channelId: string): Promise<void> {
    const { count } = await prisma.channel.deleteMany({
      where: { id: channelId, userId },
    });

    if (count === 0) {
      throw new NotFoundError("Channel");
    }
  }

  /**
   * The only place a stored access token is ever decrypted back to
   * plaintext. Google's access tokens expire after ~1h; a channel connected
   * minutes ago works, but the same call an hour later fails with what looks
   * like an intermittent, unrelated error unless the token is refreshed here.
   * Refreshing eagerly (rather than letting the caller retry on a 401) means
   * every consumer gets a token good for the request it's about to make.
   */
  async resolveAccessToken(userId: string, channelId: string): Promise<string> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    const msUntilExpiry = channel.tokenExpiresAt.getTime() - Date.now();
    if (msUntilExpiry > REFRESH_WINDOW_MS) {
      return decryptSecret(channel.accessToken);
    }

    return this.refreshAccessToken(userId, channelId, decryptSecret(channel.refreshToken));
  }

  /**
   * Exchanges the stored refresh token for a new access token and persists
   * it, encrypted. Google does not always return a new refresh token on this
   * exchange — when it doesn't, the existing one is kept rather than
   * overwritten with `undefined`; losing it means the operator has to
   * reconnect the channel by hand.
   */
  private async refreshAccessToken(
    userId: string,
    channelId: string,
    refreshToken: string,
  ): Promise<string> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new ProviderError(
        "YOUTUBE",
        "Could not refresh this channel's access token. Reconnect the channel.",
        response.status >= 500,
      );
    }

    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const tokenExpiresAt = new Date(Date.now() + body.expires_in * 1000);

    await prisma.channel.updateMany({
      where: { id: channelId, userId, deletedAt: null },
      data: {
        accessToken: encryptSecret(body.access_token),
        tokenExpiresAt,
        // Absent unless Google re-issues one (e.g. forced consent) — keep the
        // existing refresh token rather than clobbering it with undefined.
        ...(body.refresh_token
          ? { refreshToken: encryptSecret(body.refresh_token) }
          : {}),
      },
    });

    return body.access_token;
  }
}

export const channelService = new ChannelService();
