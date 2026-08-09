import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";

/**
 * Upload permission and read access to channel metadata. Deliberately not the
 * broad `youtube` scope — this app publishes and reports, it does not manage.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export interface YouTubeTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export interface YouTubeChannelInfo {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
}

function redirectUri(): string {
  return `${env.BETTER_AUTH_URL}/api/youtube/callback`;
}

export function buildAuthUrl(state: string): string {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ProviderError("GEMINI", "Google OAuth is not configured.", false);
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    // Google returns a refresh token only with offline access, and only re-issues
    // one when consent is forced. Without both, reconnecting yields no refresh
    // token and unattended publishing breaks the moment the access token expires.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<YouTubeTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new ProviderError(
      "GEMINI",
      "Google rejected the authorisation code.",
      response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!body.refresh_token) {
    throw new ProviderError(
      "GEMINI",
      "Google returned no refresh token. Revoke Framecast at myaccount.google.com/permissions and connect again.",
      false,
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSeconds: body.expires_in,
    scopes: body.scope.split(" "),
  };
}

export async function fetchChannel(
  accessToken: string,
): Promise<YouTubeChannelInfo> {
  const response = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    throw new ProviderError(
      "GEMINI",
      "Could not read the channel from YouTube.",
      response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    items?: Array<{
      id: string;
      snippet: {
        title: string;
        customUrl?: string;
        description?: string;
        thumbnails?: { default?: { url?: string } };
      };
    }>;
  };

  const channel = body.items?.[0];

  if (!channel) {
    throw new ProviderError(
      "GEMINI",
      "That Google account has no YouTube channel.",
      false,
    );
  }

  return {
    youtubeChannelId: channel.id,
    title: channel.snippet.title,
    handle: channel.snippet.customUrl ?? null,
    description: channel.snippet.description ?? null,
    thumbnailUrl: channel.snippet.thumbnails?.default?.url ?? null,
  };
}
