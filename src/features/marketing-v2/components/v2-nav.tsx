"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { MarketingNavSheet } from "@/features/marketing/components/marketing-nav";
import { MarketingThemeToggle } from "@/features/marketing/components/marketing-theme-toggle";
import { cn } from "@/lib/utils";

/**
 * The header: open across the page at rest, contracting into a floating pill
 * the moment you scroll. This is the behaviour reactbits.dev's own site has,
 * and it earns its keep — at the top of a page there is nothing underneath the
 * bar to separate from, so it can be transparent and full-width; once content
 * is running under it, it needs an edge and a ground, and a narrower pill is
 * the honest shape for that.
 *
 * Built here rather than taken from React Bits, and that is a decision rather
 * than laziness. The library has five navigation components and none survives
 * contact with this page:
 *
 *   - GooeyNav injects a `<style>` block containing bare `li::after` and
 *     `li.active` rules. Those are global: they would repaint every list item
 *     on the page, and this page has a numbered `<ol>` of pipeline stages and
 *     a twelve-item inventory list. It also hard-codes white text and
 *     `mix-blend-mode: lighten`, which means nothing on a light ground.
 *   - PillNav imports `react-router-dom`, which is not what an App Router
 *     project routes with.
 *   - CardNav pulls in `react-icons` beside the `lucide-react` this project
 *     already standardised on.
 *   - StaggeredMenu and BubbleMenu are full-screen overlay menus, not bars.
 *
 * What is left is about thirty lines of scroll state, one CSS transition, and
 * no new dependency.
 */

/**
 * True once the page has moved far enough that the bar should contract.
 *
 * 24px rather than 0, so the rubber-band at the top of an iOS scroll does not
 * flicker it. The listener is `passive` and reads a single number — no layout
 * is measured, so there is nothing here worth throttling.
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

/**
 * @param basePath the route these section anchors belong to. Root-relative and
 * explicit, because this shell is also used by pages that do not have those
 * sections on them, where a bare `#pricing` scrolls nowhere.
 */
export function MarketingNavBar({ basePath }: { basePath: string }) {
  const scrolled = useScrolled();

  const links = [
    { href: `${basePath}#the-run`, label: "How it works" },
    { href: `${basePath}#features`, label: "Features" },
    { href: `${basePath}#pricing`, label: "Pricing" },
    { href: `${basePath}#faq`, label: "FAQ" },
  ];

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:pt-4">
      <div
        className={cn(
          "pointer-events-auto flex w-full items-center gap-2 rounded-full border transition-all duration-300 ease-out motion-reduce:transition-none sm:gap-3",
          scrolled
            ? "bg-background/80 max-w-2xl px-2 py-1.5 shadow-lg backdrop-blur-md sm:px-3"
            : "max-w-6xl border-transparent bg-transparent px-3 py-2.5 sm:px-4 sm:py-3",
        )}
      >
        <Link
          href={basePath}
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

        {/* The links themselves never move. The space between them does — which
            is the whole trick, and the reason this reads as the bar gathering
            itself up rather than as four buttons sliding around. */}
        <nav
          aria-label="Sections"
          className={cn(
            "text-muted-foreground mx-auto hidden items-center text-sm transition-all duration-300 motion-reduce:transition-none md:flex",
            scrolled ? "gap-0.5" : "gap-2 lg:gap-6",
          )}
        >
          {links.map((link) => (
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
          <Button asChild size="sm" className="hidden rounded-full sm:inline-flex">
            <Link href="/sign-up">Create an account</Link>
          </Button>
          <MarketingNavSheet />
        </div>
      </div>
    </header>
  );
}
