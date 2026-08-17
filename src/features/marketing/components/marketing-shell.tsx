import Link from "next/link";

import {
  MarketingDock,
  MarketingDockSpacer,
} from "@/features/marketing/components/marketing-dock";
import { MarketingHeader } from "@/features/marketing/components/marketing-header";
import { cn } from "@/lib/utils";

/**
 * Public shell for the pages served to signed-out visitors. Kept deliberately
 * separate from the dashboard shell: nothing here may read the session, because
 * these pages are reachable — and are meant to be readable — by anyone,
 * including Google's OAuth reviewers and Safe Browsing crawlers.
 *
 * The `marketing` class on the root is the colour boundary — see globals.css.
 *
 * `width` exists so the landing page can run full-bleed sections without
 * dragging the privacy policy and terms out of the ~65-character measure that
 * makes a wall of legal text readable. Those two pages take the default and are
 * laid out exactly as they were before the landing page was rebuilt; changing
 * that default would widen a document Google is actively reviewing.
 */
export function MarketingShell({
  children,
  width = "prose",
}: {
  children: React.ReactNode;
  /** `prose` for documents, `wide` for the landing page's own layout. */
  width?: "prose" | "wide";
}) {
  const wide = width === "wide";
  const bar = cn(
    "mx-auto w-full px-6",
    wide ? "max-w-6xl" : "max-w-3xl",
  );

  return (
    // `marketing` is what switches the whole CSS-variable palette from the
    // studio's chroma-0 neutrals to the colour grade in globals.css. It is set
    // here and nowhere else, so /dashboard and the rest stay monochrome. The
    // explicit bg/text pair repaints the ground with the tokens this class has
    // just redefined — `body` is outside it and keeps the studio's.
    <div className="marketing bg-background text-foreground flex min-h-svh flex-col">
      <MarketingHeader />

      {/* The header is `fixed` — it floats over the page as a pill once you
          scroll — so it occupies no layout. The landing page's hero pads for
          it itself; the document pages get the offset here, because a privacy
          policy whose first line starts underneath the bar is the kind of
          thing a compliance reviewer notices. */}
      <main
        className={cn(
          "flex-1",
          wide ? "w-full" : cn(bar, "pt-24 pb-12"),
        )}
      >
        {children}
      </main>

      <footer className="border-t">
        <div
          className={cn(
            bar,
            "text-muted-foreground flex flex-wrap items-center justify-between gap-3 py-6 text-xs",
          )}
        >
          <span>© {new Date().getFullYear()} Framecast</span>
          <nav className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
          </nav>
        </div>
        {/* The dock is fixed, so it sits on top of this footer — and the
            footer is where Privacy and Terms are, which are the two links a
            compliance reviewer goes looking for. */}
        <MarketingDockSpacer />
      </footer>

      <MarketingDock />
    </div>
  );
}

/** Shared page heading, so the three public pages stay visually consistent. */
export function MarketingHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h1>
      {subtitle && (
        <p className="text-muted-foreground text-sm text-pretty">{subtitle}</p>
      )}
    </div>
  );
}
