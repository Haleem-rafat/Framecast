import "server-only";

import { NotFoundError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import type { YouTubeTokens } from "@/lib/youtube-oauth";

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
  async list(userId: string): Promise<ChannelSummary[]> {
    return prisma.channel.findMany({
      where: { userId, deletedAt: null },
      orderBy: { connectedAt: "desc" },
      select: SUMMARY_SELECT,
    });
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

  /** The only place a stored access token is ever decrypted back to plaintext. */
  async resolveAccessToken(userId: string, channelId: string): Promise<string> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { accessToken: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    return decryptSecret(channel.accessToken);
  }
}

export const channelService = new ChannelService();
