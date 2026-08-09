/**
 * The connect flow fails for two kinds of reasons: a bare code we detect
 * ourselves before ever calling Google (state mismatch, no code) or Google's
 * own "access_denied", versus an operator-facing message we already wrote at
 * the point of failure (see the `ProviderError`s in `lib/youtube-oauth.ts`).
 * Anything not in this table is treated as the latter and shown as-is.
 */
const CODES: Record<string, string> = {
  access_denied:
    "You declined the Google consent screen, so no channel was connected.",
  invalid_state:
    "The connection attempt expired or could not be verified. Please try connecting again.",
  missing_code:
    "Google did not return an authorisation code. Please try again.",
};

export function channelErrorMessage(error: string | undefined): string | null {
  if (!error) {
    return null;
  }

  return CODES[error] ?? error;
}
