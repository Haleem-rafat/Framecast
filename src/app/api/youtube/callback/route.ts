import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import {
  STATE_COOKIE_NAME,
  exchangeCode,
  fetchChannel,
} from "@/lib/youtube-oauth";
import { channelService } from "@/services/channel.service";
import { requireSession } from "@/server/session";

/**
 * `code` here is always one of the fixed strings `channel-error.ts` knows
 * about — never a message pulled from a thrown error. Round-tripping a
 * provider's message through the URL would make `/channels?error=…`
 * attacker-steerable, since that page is reachable directly, not only via
 * this redirect.
 */
function errorRedirect(request: NextRequest, code: string): NextResponse {
  return NextResponse.redirect(new URL(`/channels?error=${code}`, request.url));
}

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
    return errorRedirect(request, "access_denied");
  }

  // The whole point of the cookie: reject unless the state Google echoed back
  // matches the one we set before redirecting there. Without this check an
  // attacker could send the operator to Google under an attacker-controlled
  // state, then replay their own code against this callback to graft their
  // channel onto the operator's account.
  if (!state || !expectedState || state !== expectedState) {
    return errorRedirect(request, "invalid_state");
  }

  if (!code) {
    return errorRedirect(request, "missing_code");
  }

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch {
    // Covers both of exchangeCode's failure modes — Google rejecting the code
    // and Google granting access but withholding a refresh token — under one
    // code. channel-error.ts's message for it already tells the operator to
    // revoke and retry, which is safe advice either way.
    return errorRedirect(request, "token_exchange_failed");
  }

  let channelInfo;
  try {
    channelInfo = await fetchChannel(tokens.accessToken);
  } catch {
    return errorRedirect(request, "channel_fetch_failed");
  }

  try {
    await channelService.connect(session.user.id, {
      ...channelInfo,
      ...tokens,
    });
  } catch {
    return errorRedirect(request, "connect_failed");
  }

  return NextResponse.redirect(new URL("/channels", request.url));
}
