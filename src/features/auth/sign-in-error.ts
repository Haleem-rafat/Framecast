/**
 * Better Auth redirects back with a bare code on a failed social sign-in.
 * These are the ones an operator can actually act on; anything else collapses
 * to a generic message rather than leaking provider internals to the page.
 */
const MESSAGES: Record<string, string> = {
  access_denied:
    "Google refused the sign-in. If this project is still in Testing, add your address under Test users on the OAuth consent screen.",
  signup_disabled:
    "Registration through Google is turned off for this studio. Create an account with an email and password instead.",
  account_not_linked:
    "That email already has a password account. Sign in with your password first, then link Google.",
  unable_to_create_user:
    "No account could be created for that Google account. Try registering with an email and password instead.",
  invalid_state:
    "The sign-in attempt expired before it completed. Please try again.",
};

export function signInErrorMessage(code: string | undefined): string | null {
  if (!code) {
    return null;
  }

  return (
    MESSAGES[code] ??
    "Sign-in could not be completed. Please try again, or use your email and password."
  );
}
