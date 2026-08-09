import Link from "next/link";
import { Clapperboard } from "lucide-react";

/**
 * Public shell for the pages served to signed-out visitors. Kept deliberately
 * separate from the dashboard shell: nothing here may read the session, because
 * these pages are reachable — and are meant to be readable — by anyone,
 * including Google's OAuth reviewers and Safe Browsing crawlers.
 */
export function MarketingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg">
              <Clapperboard className="size-4" />
            </span>
            Framecast
          </Link>

          <Link
            href="/sign-in"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        {children}
      </main>

      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs">
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
