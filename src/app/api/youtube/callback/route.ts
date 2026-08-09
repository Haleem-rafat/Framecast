import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { STATE_COOKIE_NAME } from "@/app/api/youtube/connect/route";
import { isAppError } from "@/lib/errors";
import { exchangeCode, fetchChannel } from "@/lib/youtube-oauth";
import { channelService } from "@/services/channel.service";
import { requireSession } from "@/server/session";

export async function GET(request: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const { searchParams } = new URL(request.url);
  const googleError = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE_NAME)?.value;
  cookieStore.delete(STATE_COOKIE_NAME);

  if (googleError) {
    return NextResponse.redirect(
      new URL("/channels?error=access_denied", request.url),
    );
  }

  // The whole point of the cookie: reject unless the state Google echoed back
  // matches the one we set before redirecting there. Without this check an
  // attacker could send the operator to Google under an attacker-controlled
  // state, then replay their own code against this callback to graft their
  // channel onto the operator's account.
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(
      new URL("/channels?error=invalid_state", request.url),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/channels?error=missing_code", request.url),
    );
  }

  try {
    const tokens = await exchangeCode(code);
    const channelInfo = await fetchChannel(tokens.accessToken);

    await channelService.connect(session.user.id, {
      ...channelInfo,
      ...tokens,
    });
  } catch (error) {
    // Our own thrown errors already carry an operator-facing message (e.g. the
    // "no refresh token" case in youtube-oauth.ts) — surface it as-is. Anything
    // else collapses to a generic message rather than leaking internals.
    const message = isAppError(error)
      ? error.message
      : "Something went wrong connecting your channel. Please try again.";

    return NextResponse.redirect(
      new URL(`/channels?error=${encodeURIComponent(message)}`, request.url),
    );
  }

  return NextResponse.redirect(new URL("/channels", request.url));
}
