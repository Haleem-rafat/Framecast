import Link from "next/link";
import type { ReactNode } from "react";

import { LogoMark } from "@/components/brand/logo-mark";
import { Spotlight } from "@/components/ui/spotlight-new";
import { AuthReveal } from "@/features/auth/components/auth-motion";

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
 *
 * The entrance is three `AuthReveal`s in sequence — mark, card, fine print —
 * and that is the whole motion budget for the page beyond the backdrop. See
 * that component for why it is this short and how reduced motion is handled.
 *
 * Visually it is the landing page's shell with the volume down. `marketing` on
 * the root is the same colour boundary MarketingShell sets — the tokens are
 * defined once in globals.css and only consumed here — so the type, the border
 * weights and the greys are the grade a visitor just came from rather than the
 * studio's flat neutrals. The colour itself is rationed to two places: the
 * spotlight wash behind everything, and a soft gradient under the mark. The
 * card, the fields and the buttons stay monochrome, because the eye should
 * land on the form and nothing else. Somebody is here for eight seconds.
 */
export function AuthShell({ subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="marketing bg-background text-foreground relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-5 py-12 sm:px-6">
      {/*
        The same Spotlight the landing page closes with, masked to the top so it
        is light falling onto the card rather than a field behind the whole
        screen, and slowed down: this is a page people pass through, and a
        backdrop that pulls the eye before the form does is a failed backdrop.
        Both themes come from the `--spotlight-*` tokens, and the component
        drops its drift entirely under `prefers-reduced-motion`. Decorative, so
        it stays out of the a11y tree.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(125%_95%_at_50%_0%,black_30%,transparent_78%)]"
      >
        <Spotlight
          translateY={-300}
          width={520}
          height={1200}
          smallWidth={200}
          duration={14}
          xOffset={40}
        />
      </div>

      <div className="relative w-full max-w-sm space-y-6">
        <AuthReveal className="flex flex-col items-center gap-3 text-center">
          {/* The mark links home. It is the only way off this page that is not
              another auth page, and a credential form with no route back to
              the site it belongs to is a phishing tell. */}
          <h1 className="text-lg font-semibold tracking-tight">
            <Link
              href="/"
              aria-label="Framecast home"
              className="ring-offset-background focus-visible:ring-ring group/mark inline-flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-offset-4 focus-visible:outline-none"
            >
              <span className="relative inline-flex">
                {/* The one piece of brand colour in the composition that is not
                    the backdrop: a soft violet-to-cyan bloom under the mark,
                    the same two stops the landing headline is painted with. It
                    warms very slightly on hover, which is the only reward for
                    pointing at the one link that leaves. */}
                <span
                  aria-hidden="true"
                  className="from-brand-violet to-brand-cyan absolute -inset-1.5 rounded-2xl bg-gradient-to-br opacity-20 blur-md transition-opacity duration-300 group-hover/mark:opacity-35"
                />
                <span className="bg-primary text-primary-foreground relative flex size-10 items-center justify-center rounded-xl shadow-sm">
                  <LogoMark className="size-5" />
                </span>
              </span>
              Framecast
            </Link>
          </h1>
          <p className="text-muted-foreground text-sm text-balance">
            {subtitle}
          </p>
        </AuthReveal>

        <AuthReveal delay={0.06} className="space-y-4">
          {children}
        </AuthReveal>

        {footer && (
          <AuthReveal
            delay={0.1}
            className="text-muted-foreground text-center text-xs text-balance"
          >
            {footer}
          </AuthReveal>
        )}
      </div>

      <AuthReveal delay={0.1} className="relative mt-10 w-full max-w-sm space-y-4">
        <div className="via-border h-px bg-gradient-to-r from-transparent to-transparent" />

        <p className="text-muted-foreground/80 text-center text-xs leading-relaxed text-balance">
          Framecast is a private video production studio — it takes a topic
          through script, narration, footage and render, and holds the result
          for your approval before it publishes to your own YouTube channel.
          It is operated by its owner and is not affiliated with Google or
          YouTube.{" "}
          <Link href="/" className="hover:text-foreground underline">
            About Framecast
          </Link>
        </p>

        {/* Still underlined, still in the flow of the page. These read as links
            at a glance to a person and are plain <a> elements to a crawler,
            which is the only form of "visible" that counts here. */}
        <div className="text-muted-foreground/80 flex items-center justify-center gap-3 text-xs">
          <span>© {new Date().getFullYear()} Framecast</span>
          <Link
            href="/privacy"
            className="hover:text-foreground underline transition-colors"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="hover:text-foreground underline transition-colors"
          >
            Terms
          </Link>
        </div>
      </AuthReveal>
    </div>
  );
}
