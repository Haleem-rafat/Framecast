/**
 * `/channels?error=…` is reachable directly by anyone with the URL, not only
 * via our own OAuth redirects — so this must never echo the query value back
 * into the page. Only a fixed, known code renders its mapped message;
 * anything else — including attacker-authored text crafted to look like a
 * system message — collapses to the same generic fallback, mirroring
 * `sign-in-error.ts`'s pattern.
 */
const CODES: Record<string, string> = {
  access_denied:
    "You declined the Google consent screen, so no channel was connected.",
  invalid_state:
    "The connection attempt expired or could not be verified. Please try connecting again.",
  missing_code:
    "Google did not return an authorisation code. Please try again.",
  oauth_not_configured:
    "Google sign-in is not configured for this deployment. Contact whoever manages Framecast's environment configuration.",
  token_exchange_failed:
    "Google could not complete the connection. If you've connected Framecast before, revoke its access at myaccount.google.com/permissions and try connecting again.",
  channel_fetch_failed:
    "Could not read the channel from that Google account. Make sure it has a YouTube channel and try again.",
  connect_failed:
    "Something went wrong saving that channel. Please try again.",
};

const FALLBACK_MESSAGE =
  "That channel could not be connected. Please try again, or contact whoever manages Framecast if it keeps happening.";

export function channelErrorMessage(error: string | undefined): string | null {
  if (!error) {
    return null;
  }

  return CODES[error] ?? FALLBACK_MESSAGE;
}
