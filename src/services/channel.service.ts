import "server-only";

import { env } from "@/config/env";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { describeRefreshFailure } from "@/lib/oauth-refresh";
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
   * Destroys the credentials, keeps the channel.
   *
   * This was a hard delete, with a correct reason: leaving encrypted upload
   * credentials behind after somebody asks to disconnect is not acceptable.
   * What the delete did not account for is everything hanging off a `Channel`
   * with `onDelete: Cascade` — `ChannelBrand`, `Series`, `ReleaseCadence`,
   * `Publication` — and `Project.channelId`, which is `SetNull`.
   *
   * So disconnecting silently deleted the channel's entire configuration: its
   * footage style, art style, voice, tone and niche, every schedule built on
   * it, its release cadence, and its publish history. Reconnecting then made a
   * NEW row, because `connect` upserts on `(userId, youtubeChannelId)` and
   * there was nothing left to match — which left the operator's projects
   * unlinked and unable to publish at all. That is not a hypothetical: it
   * happened on this deployment, to a channel with twenty-three videos.
   *
   * Nulling the three credential columns satisfies the actual requirement —
   * the secrets are gone — and soft-deleting keeps everything that is not a
   * secret. `deletedAt` is already what every read in this file filters on, so
   * a disconnected channel disappears from the UI exactly as a deleted one did.
   *
   * Reconnecting needs no new code: `connect` already upserts on
   * `(userId, youtubeChannelId)` and already clears `deletedAt`, so it revives
   * this row with its brand, series and cadence still attached. That path was
   * always there; nothing could reach it while the row was being deleted out
   * from under it.
   */
  async disconnect(userId: string, channelId: string): Promise<void> {
    const { count } = await prisma.channel.updateMany({
      where: { id: channelId, userId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        isActive: false,
        // The point of the whole method.
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
      },
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

    // A disconnected channel keeps its row and loses its secrets, so "no
    // credentials" is now a state a caller can reach rather than an
    // impossibility. Named as itself: an operator who disconnected a channel
    // and left a video queued against it should be told that, not handed a
    // decryption failure.
    if (!channel.accessToken || !channel.refreshToken || !channel.tokenExpiresAt) {
      throw new ConflictError(
        "This channel is disconnected, so nothing can be uploaded to it. Reconnect it on the channels screen and try again.",
      );
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
      // Classified in `describeRefreshFailure`, which is pure so the decision
      // can be tested against Google's real response bodies. The distinction
      // that matters: a revoked grant is fixed by reconnecting, a bad client id
      // is not, and telling an operator to reconnect against the second is a
      // loop that cannot terminate.
      const failure = describeRefreshFailure(response.status, await response.text());

      throw new ProviderError("YOUTUBE", failure.message, failure.retryable);
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
