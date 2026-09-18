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
 *
 * ## The case inside the revoked case
 *
 * An OAuth app whose consent screen is still in "Testing" gets refresh tokens
 * that Google kills seven days after they are issued. The body is the same
 * `invalid_grant` / "Token has been expired or revoked." as a real revocation,
 * so reconnecting "fixes" it — for another seven days. The only signal that
 * tells the two apart is the token's age when it died, which the caller
 * measures and passes in as `tokenAgeMs`.
 */

/** Google's shape for a failed token exchange. Both fields optional: a 5xx
 *  from the front door is not always JSON at all. */
interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long Google keeps a refresh token alive for an app whose OAuth consent
 * screen is in "Testing" publishing status.
 */
export const TESTING_MODE_REFRESH_TOKEN_LIFETIME_MS = 7 * DAY_MS;

/**
 * The window a refused token's age has to land in to be read as Testing-mode
 * expiry. It opens an hour early for clock skew. It closes two days late
 * because nothing refreshes at the instant of expiry: the first refresh after
 * it is whichever comes first of a publish and the analytics collector's pass
 * over the channel, so the first refusal can land a day or so after the token
 * actually died. The age the caller measures is to that FIRST refusal (see
 * `ChannelService`), so later refusals of the same dead token don't drift out
 * of the window.
 */
const TESTING_MODE_WINDOW_START_MS = TESTING_MODE_REFRESH_TOKEN_LIFETIME_MS - HOUR_MS;
const TESTING_MODE_WINDOW_END_MS = TESTING_MODE_REFRESH_TOKEN_LIFETIME_MS + 2 * DAY_MS;

export type RefreshFailureKind =
  /** 5xx — Google's side. Retry. */
  | "transient"
  /** `invalid_grant` — the refresh token itself is dead; reconnecting fixes it. */
  | "revoked"
  /** Anything else — how this deployment asks (client id/secret), not the channel. */
  | "client";

export interface RefreshContext {
  /**
   * How long the refused refresh token had been alive when Google first
   * refused it: from the channel's most recent (re)connection to the first
   * `invalid_grant` after it. `null` when unknown — a channel connected before
   * connections were recorded.
   */
  tokenAgeMs?: number | null;
}

export interface RefreshFailure {
  kind: RefreshFailureKind;
  message: string;
  /** Whether the caller should try again on its own. Only true for the
   *  transient case — an operator-actionable failure retried in a loop is just
   *  a slower way of not working. */
  retryable: boolean;
}

function parseBody(rawBody: string): TokenErrorBody {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? (parsed as TokenErrorBody) : {};
  } catch {
    // Not JSON. Google does this for some 5xx responses, and the body is
    // usually an HTML error page — kept only as a last-resort detail below.
    return {};
  }
}

/**
 * Which of the three cases a failed refresh is. Separate from the message so a
 * caller can decide whether it is worth measuring the token's age (only a
 * revoked grant needs it) before asking for the sentence.
 */
export function classifyRefreshFailure(status: number, rawBody: string): RefreshFailureKind {
  if (status >= 500) {
    return "transient";
  }

  // Read from `error`, not from the description. See the note above — this is
  // the exact line the first version got wrong.
  return parseBody(rawBody).error === "invalid_grant" ? "revoked" : "client";
}

/**
 * True when a refresh token died at the age Google kills tokens issued to an
 * app in Testing. See the note at the top of this file for why age is the only
 * signal available.
 */
export function looksLikeTestingModeExpiry(tokenAgeMs: number | null | undefined): boolean {
  return (
    typeof tokenAgeMs === "number" &&
    tokenAgeMs >= TESTING_MODE_WINDOW_START_MS &&
    tokenAgeMs <= TESTING_MODE_WINDOW_END_MS
  );
}

/** "7 days, 2 hours" / "5 hours" / "under an hour" — for an operator, not a parser. */
export function formatTokenAge(ms: number): string {
  const totalHours = Math.floor(Math.max(0, ms) / HOUR_MS);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

  if (days === 0) {
    return hours === 0 ? "under an hour" : plural(hours, "hour");
  }

  return hours === 0 ? plural(days, "day") : `${plural(days, "day")}, ${plural(hours, "hour")}`;
}

export function describeRefreshFailure(
  status: number,
  rawBody: string,
  context: RefreshContext = {},
): RefreshFailure {
  const parsed = parseBody(rawBody);
  const kind = classifyRefreshFailure(status, rawBody);

  // The sentence for a human, falling back to the code, falling back to
  // whatever arrived. Never the whole body: an HTML error page in a status
  // message helps nobody.
  const detail = parsed.error_description ?? parsed.error ?? rawBody.slice(0, 160).trim();

  if (kind === "transient") {
    return {
      kind,
      message:
        `Google could not refresh this channel's access token just now (${status}). ` +
        "This usually clears on its own, and the upload will be tried again.",
      retryable: true,
    };
  }

  if (kind === "revoked") {
    const { tokenAgeMs } = context;

    // The case that sends an operator round the reconnect loop every week.
    // Reconnecting does fix it — for exactly seven more days — so saying only
    // "reconnect" is true and useless. The lasting fix is a console setting,
    // not code, so the sentence has to name the setting.
    if (typeof tokenAgeMs === "number" && looksLikeTestingModeExpiry(tokenAgeMs)) {
      return {
        kind,
        message:
          `This channel's access expired ${formatTokenAge(tokenAgeMs)} after it was connected. ` +
          "Google expires access after 7 days for apps whose OAuth consent screen is still in " +
          "Testing, so reconnecting alone will only work for another week. Fix it once in " +
          "Google Cloud Console: APIs & Services → OAuth consent screen → Publishing status → " +
          "Publish app. Then reconnect the channel on the channels screen.",
        retryable: false,
      };
    }

    const age =
      typeof tokenAgeMs === "number"
        ? ` Its access was ${formatTokenAge(tokenAgeMs)} old when Google refused it.`
        : "";

    return {
      kind,
      message:
        "This channel's access has expired or been revoked, so its token can no longer be " +
        `refreshed.${age} Reconnect the channel on the channels screen — that will fix it.`,
      retryable: false,
    };
  }

  // Everything else is a problem with how this deployment asks, not with the
  // operator's channel: a wrong client id, a wrong secret, a client that has
  // been deleted in the Google console. Saying "reconnect the channel" here is
  // what sends somebody round a loop that cannot terminate.
  return {
    kind,
    message:
      `Google refused to refresh this channel's access token (${status})` +
      `${detail ? `: ${detail}` : "."} This is usually a problem with this ` +
      "deployment's Google credentials rather than with your channel, so reconnecting " +
      "may not help.",
    retryable: false,
  };
}
