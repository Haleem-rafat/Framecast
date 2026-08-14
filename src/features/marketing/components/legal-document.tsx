import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

/**
 * Presentation for the three public documents — privacy, terms and contact.
 *
 * These pages are the ones Google fetches while it verifies the domain, so the
 * rule here is that this file may change how the text *looks* and may not
 * change the text. Every string still lives in its own page; this only supplies
 * the band at the top, the measure, the section chrome and the contents rail.
 *
 * The measure is capped near 70 characters on purpose. A legal document set at
 * the landing page's width is technically "readable" and practically nobody
 * reads it, which for a privacy policy under review is the wrong outcome.
 */
export function LegalDocument({
  title,
  updated,
  intro,
  contents,
  children,
}: {
  title: string;
  updated: string;
  /** One line under the title. Optional; the policies do not use it. */
  intro?: string;
  /** Anchors for the sticky rail. Must match the ids given to LegalSection. */
  contents: { id: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <div>
      <header className="relative isolate overflow-hidden border-b">
        <div
          aria-hidden="true"
          className="from-brand-violet/15 via-brand-blue/8 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent"
        />
        <div className="relative mx-auto w-full max-w-6xl px-6 py-14 sm:py-20">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to Framecast
          </Link>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            {title}
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">{updated}</p>
          {intro && (
            <p className="text-muted-foreground mt-4 max-w-2xl text-base text-pretty sm:text-lg">
              {intro}
            </p>
          )}
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-12 sm:py-16 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-16">
        <nav
          aria-label="On this page"
          className="lg:sticky lg:top-28 lg:self-start"
        >
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            On this page
          </p>
          <ul className="mt-3 space-y-2">
            {contents.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className="text-muted-foreground hover:text-foreground text-sm text-pretty transition-colors"
                >
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-[68ch] space-y-10">{children}</article>
      </div>
    </div>
  );
}

/**
 * One section of a document. `scroll-mt` keeps the heading clear of the sticky
 * site header when the contents rail jumps to it — without it the anchor lands
 * with the heading hidden behind the bar.
 */
export function LegalSection({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 space-y-3 [&_li]:text-muted-foreground [&_li]:text-sm [&_li]:text-pretty [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:text-pretty"
    >
      <h2 className="border-brand-violet/40 border-l-2 pl-3 text-base font-medium">
        {heading}
      </h2>
      {children}
    </section>
  );
}
