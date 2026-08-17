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

/** The top of the page, where the header is always shown. */
const REVEAL_ZONE = 80;

/** How far the page must move before a direction counts. See the hook below. */
const DEADBAND = 4;

/**
 * Two pieces of scroll state, read from one listener.
 *
 * `scrolled` — past 24px, so the bar contracts into its pill. 24 rather than 0
 * so the rubber-band at the top of an iOS scroll does not flicker it.
 *
 * `hidden` — the visitor is scrolling *down*, and is far enough into the page
 * that the header is in the way rather than in use. It comes back the instant
 * they scroll up, at any position, and it is never hidden in the top 80px
 * whatever the direction. This is a phone-app behaviour rather than a web one:
 * on a page five screens long, a bar that follows you down is a bar covering
 * the thing you scrolled to read.
 *
 * The ±4px deadband is what makes it usable with a finger. Touch scrolling
 * arrives as a stream of small, noisy deltas with momentum wobble at the end
 * of a fling, and comparing raw `y` against `lastY` without a deadband makes
 * the header strobe on every one of them.
 *
 * One `passive` listener, and the work is deferred to a frame — `scroll` can
 * fire many times between paints, and there is no reason to set state more
 * often than the screen updates. Nothing here measures layout, so nothing here
 * can cause a synchronous reflow.
 *
 * Note it listens to `scroll` rather than to `wheel` or `touchmove`, so it is
 * indifferent to what did the scrolling: a wheel, a finger, a trackpad fling,
 * a keyboard PageDown, or a fragment link jumping to a section all arrive the
 * same way.
 */
function useHeaderScroll() {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let lastY = Math.max(0, window.scrollY);
    let queued = false;

    const update = () => {
      queued = false;
      // Clamped: iOS reports a negative `scrollY` while rubber-banding at the
      // top, which would otherwise read as a scroll upward of some hundreds of
      // pixels and then a scroll back down.
      const y = Math.max(0, window.scrollY);

      setScrolled(y > 24);

      if (y <= REVEAL_ZONE) {
        setHidden(false);
      } else if (y > lastY + DEADBAND) {
        setHidden(true);
      } else if (y < lastY - DEADBAND) {
        setHidden(false);
      }

      lastY = y;
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

  return { scrolled, hidden };
}

/**
 * @param basePath the route these section anchors belong to. Root-relative and
 * explicit, because this shell is also used by pages that do not have those
 * sections on them, where a bare `#pricing` scrolls nowhere.
 */
export function MarketingNavBar({ basePath }: { basePath: string }) {
  const { scrolled, hidden } = useHeaderScroll();

  const links = [
    { href: `${basePath}#the-run`, label: "How it works" },
    { href: `${basePath}#features`, label: "Features" },
    { href: `${basePath}#pricing`, label: "Pricing" },
    { href: `${basePath}#faq`, label: "FAQ" },
  ];

  return (
    <header
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 transition-transform duration-300 ease-out motion-reduce:transition-none sm:pt-4",
        // `translateY`, not `display` or `height`: the header is `fixed`, so
        // the page underneath it never reflows either way, but a transform is
        // also the only one of the three the compositor can do without
        // touching layout at all.
        //
        // `focus-within` overrides the hidden state. Tabbing into a bar that
        // has slid off the top of the screen is the classic way this pattern
        // strands a keyboard user on a focused control they cannot see.
        hidden ? "-translate-y-[130%] focus-within:translate-y-0" : "translate-y-0",
      )}
    >
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
