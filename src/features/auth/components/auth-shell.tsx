import Link from "next/link";
import type { ReactNode } from "react";

import { LogoMark } from "@/components/brand/logo-mark";

interface AuthShellProps {
  /** One line under the wordmark saying what this page is for. */
  subtitle: string;
  children: ReactNode;
  /** Fine print below the card — links to the other auth pages, usually. */
  footer?: ReactNode;
}

/**
 * The centered card layout every page under (auth) shares. Extracted when the
 * second page appeared: five copies of the same wash-and-wordmark markup drift
 * apart one padding value at a time.
 *
 * Three things below exist for a reason that is not layout, and are worth not
 * "tidying away": the mark links back to the home page, the page says in one
 * sentence what Framecast is and who runs it, and the privacy policy and terms
 * are linked from the page itself. All four (auth) pages ask for an email
 * address and three of them ask for a password, and a credential form on a
 * domain that never names its own product, never says who is collecting the
 * data and offers no route to a privacy policy is indistinguishable — to an
 * automated reviewer, and honestly to a careful person — from a phishing page.
 * The marketing page carries all of this; the sign-in page is the one a
 * stranger actually lands on, and it carried none of it.
 */
export function AuthShell({ subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden p-6">
      {/* Ambient wash. Purely decorative, so it stays out of the a11y tree. */}
      <div
        aria-hidden="true"
        className="from-primary/10 pointer-events-none absolute inset-0 bg-gradient-to-b via-transparent to-transparent"
      />

      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Link
            href="/"
            aria-label="Framecast home"
            className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl shadow-sm"
          >
            <LogoMark className="size-5" />
          </Link>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Framecast</h1>
            <p className="text-muted-foreground text-sm">{subtitle}</p>
          </div>
        </div>

        {children}

        {footer && (
          <div className="text-muted-foreground text-center text-xs text-balance">
            {footer}
          </div>
        )}

        <p className="text-muted-foreground/80 text-center text-xs text-balance">
          Framecast is a private video production studio — it takes a topic
          through script, narration, footage and render, and holds the result
          for your approval before it publishes to your own YouTube channel.
          It is operated by its owner and is not affiliated with Google or
          YouTube.{" "}
          <Link href="/" className="hover:text-foreground underline">
            About Framecast
          </Link>
        </p>
      </div>

      <div className="text-muted-foreground/80 relative mt-8 flex items-center gap-3 text-xs">
        <span>© {new Date().getFullYear()} Framecast</span>
        <Link href="/privacy" className="hover:text-foreground underline">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-foreground underline">
          Terms
        </Link>
      </div>
    </div>
  );
}
