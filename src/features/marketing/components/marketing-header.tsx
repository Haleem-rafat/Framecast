"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import {
  NAV_LINKS,
  MarketingNavSheet,
} from "@/features/marketing/components/marketing-nav";
import { MarketingThemeToggle } from "@/features/marketing/components/marketing-theme-toggle";
import { cn } from "@/lib/utils";

/**
 * The public site's header, behaving the way reactbits.dev's own does.
 *
 * It contracts, and that is all it does. At the top of the page it is a
 * full-width transparent bar — there is nothing underneath it to separate
 * from, so it needs no ground and no edge. Once content is running under it,
 * it gathers into a centred pill with a background, a border and a shadow,
 * which is the honest shape for something floating over text.
 *
 * It does not hide. An earlier version slid up on scroll down and returned on
 * scroll up, the way a phone app's chrome does; the owner did not want it, and
 * on a page whose whole job is to get one button pressed, a header that takes
 * the sign-up button off screen while you read is working against the page.
 *
 * The nav is hand-built rather than taken from React Bits, and that is a
 * decision rather than laziness. The library has five navigation components
 * and none survives contact with this page:
 *
 *   - GooeyNav injects a `<style>` block containing bare `li::after` and
 *     `li.active` rules. Those are global — they would repaint every list item
 *     on the page, and the landing page has a bento grid and a twelve-item
 *     inventory list. It also hard-codes white text and
 *     `mix-blend-mode: lighten`, which means nothing on a light ground.
 *   - PillNav imports `react-router-dom`, which is not what an App Router
 *     project routes with.
 *   - CardNav pulls in `react-icons` beside the `lucide-react` this project
 *     already standardised on.
 *   - StaggeredMenu and BubbleMenu are full-screen overlay menus, not bars.
 *
 * What is left is one `passive` listener and a CSS transition.
 */

/** Past this, the bar contracts. Not 0, so an iOS rubber-band cannot flicker it. */
const CONTRACT_AT = 24;

/**
 * Whether the page has moved far enough for the bar to gather itself up.
 *
 * One `passive` listener reading one number, with the work deferred to a
 * frame: `scroll` can fire many times between paints and there is no reason to
 * set state more often than the screen updates. Nothing here measures layout,
 * so nothing here can force a synchronous reflow.
 *
 * It listens to `scroll` rather than to `wheel` or `touchmove`, so it is
 * indifferent to what did the scrolling — a wheel, a finger, a trackpad fling,
 * a keyboard PageDown and a fragment link all arrive the same way.
 */
function useContracted() {
  const [contracted, setContracted] = useState(false);

  useEffect(() => {
    let queued = false;

    const update = () => {
      queued = false;
      setContracted(window.scrollY > CONTRACT_AT);
    };

    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return contracted;
}

export function MarketingHeader() {
  const contracted = useContracted();

  return (
    // `pointer-events-none` on the full-width wrapper so the half of it that is
    // not the bar does not eat clicks on the page behind it.
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:pt-4">
      <header
        className={cn(
          "pointer-events-auto flex w-full items-center gap-2 rounded-full border transition-all duration-300 ease-out motion-reduce:transition-none sm:gap-3",
          contracted
            ? "bg-background/80 max-w-3xl px-2 py-1.5 shadow-lg backdrop-blur-md sm:px-3"
            : "max-w-6xl border-transparent bg-transparent px-3 py-2.5 sm:px-4 sm:py-3",
        )}
      >
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 pl-1 text-sm font-semibold"
        >
          <span
            className={cn(
              "bg-primary text-primary-foreground flex items-center justify-center rounded-md transition-all duration-300 motion-reduce:transition-none",
              contracted ? "size-6" : "size-7",
            )}
          >
            <LogoMark className={contracted ? "size-3.5" : "size-4"} />
          </span>
          Framecast
        </Link>

        {/* The links themselves never move. The space between them does, which
            is what makes this read as the bar gathering itself up rather than
            as four buttons sliding around.

            The hrefs are root-relative (`/#pricing`, not `#pricing`) because
            this header also renders on /privacy, /terms and /contact, where a
            bare fragment scrolls nowhere. */}
        <nav
          aria-label="Sections"
          className={cn(
            "text-muted-foreground mx-auto hidden items-center text-sm transition-all duration-300 motion-reduce:transition-none md:flex",
            contracted ? "gap-0.5" : "gap-2 lg:gap-6",
          )}
        >
          {NAV_LINKS.map((link) => (
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
            variant="ghost"
            size="sm"
            className="hidden rounded-full lg:inline-flex"
          >
            <Link href="/sign-in">Sign in</Link>
          </Button>
          <Button asChild size="sm" className="hidden rounded-full sm:inline-flex">
            <Link href="/sign-up">Create an account</Link>
          </Button>
          {/* Below md the section links collapse into this sheet, so a 375px
              bar is the wordmark, the theme toggle and one button rather than
              a row of truncated pills. */}
          <MarketingNavSheet />
        </div>
      </header>
    </div>
  );
}
