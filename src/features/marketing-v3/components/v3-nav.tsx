"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { MarketingNavSheet } from "@/features/marketing/components/marketing-nav";
import { MarketingThemeToggle } from "@/features/marketing/components/marketing-theme-toggle";
import { cn } from "@/lib/utils";

/**
 * The navbar reactbits.dev wears: open across the page at the top, contracting
 * into a floating pill the moment you start scrolling.
 *
 * Built here rather than taken from the library, and that is a deliberate
 * choice rather than laziness. React Bits has five navigation components and
 * none of them survives contact with this page:
 *
 *   - GooeyNav injects a `<style>` block containing bare `li::after` and
 *     `li.active` rules. They are global — they would repaint every list item
 *     on the page, and this page has a numbered `<ol>` of pipeline stages and
 *     a twelve-item inventory. It also hard-codes white text and
 *     `mix-blend-mode: lighten`, which has no meaning on a light ground.
 *   - PillNav imports `react-router-dom`, which is not what an App Router
 *     project routes with.
 *   - CardNav pulls in `react-icons` for a project that already standardised
 *     on `lucide-react`.
 *   - StaggeredMenu and BubbleMenu are full-screen overlay menus, not bars.
 *
 * What is left is about forty lines of scroll state, which is what the effect
 * actually is. No new dependency, both themes, and the contraction is a CSS
 * transition that `motion-reduce` turns off.
 *
 * The anchors are `/v3#…`. v1's nav is root-relative because it also renders
 * on /privacy and /terms where a bare `#pricing` scrolls nowhere; here those
 * same hrefs would take the visitor off the page they are reading.
 */

const V3_NAV_LINKS = [
  { href: "/v3#the-run", label: "The run" },
  { href: "/v3#features", label: "Features" },
  { href: "/v3#pricing", label: "Pricing" },
  { href: "/v3#faq", label: "FAQ" },
] as const;

/**
 * True once the page has moved far enough that the bar should contract.
 *
 * The threshold is 24px rather than 0 so that the rubber-banding at the top of
 * an iOS scroll does not flicker it, and the listener is `passive` and reads
 * one number — no layout is measured, so there is nothing here to throttle.
 */
function useScrolled(threshold = 24) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return scrolled;
}

export function V3Nav() {
  const scrolled = useScrolled();

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:pt-4">
      <div
        className={cn(
          "pointer-events-auto flex w-full items-center gap-2 rounded-full border transition-all duration-300 ease-out motion-reduce:transition-none sm:gap-3",
          scrolled
            ? // Contracted: a narrow pill, opaque enough to sit over content.
              "bg-background/80 max-w-2xl px-2 py-1.5 shadow-lg backdrop-blur-md sm:px-3"
            : // Open: the full measure of the page, and transparent, because
              // at the top of the page there is nothing under it to separate
              // from.
              "max-w-6xl border-transparent bg-transparent px-3 py-2.5 sm:px-4 sm:py-3",
        )}
      >
        <Link
          href="/v3"
          className="flex shrink-0 items-center gap-2 text-sm font-semibold"
        >
          <span
            className={cn(
              "bg-primary text-primary-foreground flex items-center justify-center rounded-md transition-all duration-300 motion-reduce:transition-none",
              scrolled ? "size-6" : "size-7",
            )}
          >
            <LogoMark className={scrolled ? "size-3.5" : "size-4"} />
          </span>
          Framecast
        </Link>

        <nav
          aria-label="Sections"
          className={cn(
            "text-muted-foreground hidden items-center text-sm transition-all duration-300 motion-reduce:transition-none md:flex",
            // Spread out at rest, tucked together once contracted. This is the
            // whole trick: the links do not move, the space between them does.
            scrolled ? "mx-auto gap-0.5" : "mx-auto gap-2 lg:gap-6",
          )}
        >
          {V3_NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hover:text-foreground hover:bg-accent rounded-full px-3 py-1.5 whitespace-nowrap transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <MarketingThemeToggle />
          <Button
            asChild
            size="sm"
            className="hidden rounded-full sm:inline-flex"
          >
            <Link href="/sign-up">Create an account</Link>
          </Button>
          <MarketingNavSheet />
        </div>
      </div>
    </header>
  );
}
