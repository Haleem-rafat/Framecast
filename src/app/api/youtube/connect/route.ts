import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { STATE_COOKIE_NAME, buildAuthUrl } from "@/lib/youtube-oauth";
import { requireSession } from "@/server/session";

/** Short-lived: the round trip through Google's consent screen should be quick. */
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

export async function GET(request: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  // Random per attempt, bound to this browser via an httpOnly cookie. The
  // callback rejects unless the `state` it receives matches this cookie —
  // without that check the callback is open to CSRF, letting an attacker graft
  // their own channel onto the operator's account.
  const state = randomBytes(32).toString("hex");

  // GOOGLE_CLIENT_ID/SECRET are `.optional()` in config/env.ts, so a
  // deployment missing them is reachable, not hypothetical — buildAuthUrl
  // throws ProviderError in that case. Checked before the cookie is set so a
  // misconfigured deployment doesn't leave a stray state cookie behind.
  let authUrl: string;
  try {
    authUrl = buildAuthUrl(state);
  } catch {
    return NextResponse.redirect(
      new URL("/channels?error=oauth_not_configured", request.url),
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return NextResponse.redirect(authUrl);
}
