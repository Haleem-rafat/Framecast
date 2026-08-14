"use client";

import { useState } from "react";

import { signIn } from "@/lib/auth-client";

/**
 * Google's official "G" mark, inlined.
 *
 * Inlined rather than fetched: a sign-in page that pulls an image from a
 * third-party host is both slower and, to anything inspecting the page, one
 * more remote dependency on a form that takes a password. The bytes are the
 * asset Google publishes for this button — the geometry is not redrawn.
 *
 * That distinction is the whole point. This file previously carried a
 * hand-approximated four-colour G on a 24x24 grid, which broke two of the
 * explicit "don't"s in Google's Sign-In branding guidelines ("Create your own
 * icon for the button or use an outdated Google 'G'"). An almost-right copy of
 * a well-known logo sitting beside an email and password field is also exactly
 * the shape an automated phishing classifier is trained to find, so getting
 * this exactly right is worth more here than it looks.
 *
 * https://developers.google.com/identity/branding-guidelines
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * Identity scopes only. Connecting a YouTube channel is a separate
 * authorization with its own scopes and its own token — see the Channels page.
 *
 * Deliberately *not* built on `<Button variant="outline">` like every other
 * button in the app. Google's guidelines fix this button's fill, stroke, text
 * colour and internal padding to exact values, and the shared Button's design
 * tokens and `h-8 px-2.5` sizing cannot express them. A button styled from our
 * palette would be a guideline violation that looks tidy; this one is
 * compliant and looks very slightly foreign, which is the trade the guidelines
 * ask for. The one substitution is the typeface — Google Sans Medium is not
 * loaded here, so the app font is used at the specified 14/20 metrics.
 *
 * The label stays one of the three permitted strings ("Sign in with Google",
 * "Sign up with Google", "Continue with Google"). "Continue with Google" is
 * used because this same component serves both the sign-in and the sign-up
 * page, and Google's flow genuinely does either.
 */
export function GoogleSignInButton({ redirectTo }: { redirectTo: string }) {
  const [isRedirecting, setIsRedirecting] = useState(false);

  async function onClick() {
    setIsRedirecting(true);

    // On success the browser leaves for Google, so this never resets. It is
    // only reset when the call itself fails and the user stays on the page.
    const { error } = await signIn.social({
      provider: "google",
      callbackURL: redirectTo,
      // Without this, a rejected sign-in lands on Better Auth's own error route
      // and the operator sees a bare error code with no way back.
      errorCallbackURL: "/sign-in",
    });

    if (error) {
      setIsRedirecting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isRedirecting}
      /**
       * The literal values from the guidelines, not tokens:
       *   light — fill #FFFFFF, 1px inside stroke #747775, text #1F1F1F
       *   dark  — fill #131314, 1px inside stroke #8E918F, text #E3E3E3
       * 12px before the logo, 10px after it, 12px after the text, 40px tall,
       * 4px corner radius (the "rectangular" shape Google publishes).
       *
       * The busy state dims the whole button rather than swapping the mark for
       * a spinner: "use the Google icon or logo by itself without the button
       * boundary and without text" is a listed don't, and a button that drops
       * its mark mid-interaction edges towards it for no real gain.
       */
      className="flex h-10 w-full items-center justify-center gap-[10px] rounded-[4px] border border-[#747775] bg-white pr-[12px] pl-[12px] text-sm leading-5 font-medium text-[#1F1F1F] transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60 dark:border-[#8E918F] dark:bg-[#131314] dark:text-[#E3E3E3]"
    >
      <GoogleMark />
      {isRedirecting ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}
