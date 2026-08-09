import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { buildAuthUrl } from "@/lib/youtube-oauth";
import { requireSession } from "@/server/session";

/**
 * Shared with the callback route, which reads and clears this same cookie to
 * verify `state`. httpOnly so a page script can't read or forge it; short-lived
 * because the whole round trip through Google's consent screen should be quick.
 */
export const STATE_COOKIE_NAME = "yt_oauth_state";
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

  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return NextResponse.redirect(buildAuthUrl(state));
}
