/**
 * What to tell an operator when Google refuses to refresh a channel's token.
 *
 * Pure, and separate from `channel.service.ts`, because the thing worth getting
 * right here is a decision about Google's response body — and a decision about
 * a response body should be testable against real response bodies rather than
 * against a mocked HTTP client.
 *
 * ## Why this exists at all
 *
 * The refresh failure used to report one sentence for every cause: *"Could not
 * refresh this channel's access token. Reconnect the channel."* That is right
 * for one of the three things that actually go wrong and wrong for the other
 * two, and being told to reconnect against a problem reconnecting cannot fix
 * is worse than being told nothing.
 *
 * ## The three cases, and how Google distinguishes them
 *
 * Google answers a failed refresh with `{ error, error_description }`. The
 * machine-readable half is `error`; `error_description` is the sentence for a
 * human. **The classification must read `error`.** The first version of this
 * logic tested `error_description` for the string "invalid_grant" — which never
 * appears there, because the description of `invalid_grant` is the prose
 * "Token has been expired or revoked." So a revoked token, the one case where
 * reconnecting IS the fix, was reported as the case where it probably is not.
 */

/** Google's shape for a failed token exchange. Both fields optional: a 5xx
 *  from the front door is not always JSON at all. */
interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

export interface RefreshFailure {
  message: string;
  /** Whether the caller should try again on its own. Only true for the
   *  transient case — an operator-actionable failure retried in a loop is just
   *  a slower way of not working. */
  retryable: boolean;
}

export function describeRefreshFailure(status: number, rawBody: string): RefreshFailure {
  let parsed: TokenErrorBody = {};

  try {
    parsed = JSON.parse(rawBody) as TokenErrorBody;
  } catch {
    // Not JSON. Google does this for some 5xx responses, and the body is
    // usually an HTML error page — kept only as a last-resort detail below.
  }

  // The sentence for a human, falling back to the code, falling back to
  // whatever arrived. Never the whole body: an HTML error page in a status
  // message helps nobody.
  const detail = parsed.error_description ?? parsed.error ?? rawBody.slice(0, 160).trim();

  if (status >= 500) {
    return {
      message:
        `Google could not refresh this channel's access token just now (${status}). ` +
        "This usually clears on its own, and the upload will be tried again.",
      retryable: true,
    };
  }

  // Read from `error`, not from the description. See the note above — this is
  // the exact line the first version got wrong.
  if (parsed.error === "invalid_grant") {
    return {
      message:
        "This channel's access has expired or been revoked, so its token can no longer be " +
        "refreshed. Reconnect the channel on the channels screen — that will fix it.",
      retryable: false,
    };
  }

  // Everything else is a problem with how this deployment asks, not with the
  // operator's channel: a wrong client id, a wrong secret, a client that has
  // been deleted in the Google console. Saying "reconnect the channel" here is
  // what sends somebody round a loop that cannot terminate.
  return {
    message:
      `Google refused to refresh this channel's access token (${status})` +
      `${detail ? `: ${detail}` : "."} This is usually a problem with this ` +
      "deployment's Google credentials rather than with your channel, so reconnecting " +
      "may not help.",
    retryable: false,
  };
}
