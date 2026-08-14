import Link from "next/link";

import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { MarketingThemeToggle } from "@/features/marketing/components/marketing-theme-toggle";
import { cn } from "@/lib/utils";

/**
 * Public shell for the pages served to signed-out visitors. Kept deliberately
 * separate from the dashboard shell: nothing here may read the session, because
 * these pages are reachable — and are meant to be readable — by anyone,
 * including Google's OAuth reviewers and Safe Browsing crawlers.
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
    <div className="flex min-h-svh flex-col">
      <header className="bg-background/80 sticky top-0 z-50 border-b backdrop-blur-sm">
        <div className={cn(bar, "flex items-center justify-between gap-4 py-3")}>
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg">
              <LogoMark className="size-4" />
            </span>
            Framecast
          </Link>

          <div className="flex items-center gap-1">
            <MarketingThemeToggle />
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link href="/sign-up">Create an account</Link>
            </Button>
          </div>
        </div>
      </header>

      <main
        className={cn(
          "flex-1",
          wide ? "w-full" : cn(bar, "py-12"),
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
      </footer>
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
