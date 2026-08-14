"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Extends the observer's root 9,999px *upward* and not one pixel in any other
 * direction, which turns "is this region visible" into a question that can only
 * ever be answered once.
 *
 * A plain viewport-rooted observer does not fire when an element goes from
 * below the fold to above it inside a single frame — the intersection ratio is
 * 0 before and 0 after, no threshold is crossed, and the spec only queues an
 * entry when the threshold index or `isIntersecting` actually changes. Any jump
 * bigger than a screen does that: End, a hash link, find-in-page, a restored
 * scroll position, a hard fling on a trackpad. The region it skipped over stays
 * at `opacity: 0` for the life of the page. That is not hypothetical — it is
 * the bug that made the video detail page abandon its own scroll reveal, with a
 * measured 1,043px of blank page to show for it.
 *
 * With the root stretched upward, "intersecting" means "this element's top edge
 * has reached the bottom of the viewport, now or at any point in the past". It
 * is monotonic in scroll position, so no jump — of any size, in either
 * direction — can step over it. The browser recomputes intersection from
 * scratch each frame rather than diffing against the last one, so wherever the
 * page lands after a jump, the answer is correct.
 */
const ROOT_MARGIN = "9999px 0px 0px 0px";

/**
 * The same query `usePrefersReducedMotion` watches, asked again at the one
 * moment that has to be right.
 *
 * The hook reports `false` during hydration on purpose — that is how it avoids
 * rendering a different tree on the server than in the browser — and React runs
 * passive effects from that first commit *before* it reconciles the real value
 * in. Measured on /analytics with the media feature emulated: trusting the hook
 * alone constructed two observers and tore them down again a moment later, for
 * precisely the visitor who asked for none. So the hook stays, because it is
 * what re-runs this effect when the preference changes mid-session, but the
 * decision to arm is made against a fresh read.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * How long to wait for the observer's first callback before concluding it is
 * never coming. Generous by two orders of magnitude — a working observer
 * reports within a frame — because the only cost of being generous is that a
 * genuinely broken browser shows an off-screen region a second late, and the
 * cost of being stingy is cancelling animations that were about to work.
 */
const OBSERVER_HEARTBEAT_MS = 1_000;

/**
 * `initial` and `revealed` look identical on screen; they differ only in
 * whether a transition is armed. That is what lets the server render `initial`
 * — a region with no opacity or transform of its own, fully visible in the
 * HTML — and still get a real transition later.
 *
 * `armed` deliberately carries no transition. It is applied to elements that
 * are off screen, so it must land instantly; if it faded out over the same
 * duration it fades in, an operator who scrolled down mid-arm would catch the
 * region on its way out and watch it reverse.
 */
type Phase = "initial" | "armed" | "revealed";

const PHASE_CLASS: Record<Phase, string> = {
  initial: "",
  armed: "translate-y-2 opacity-0",
  revealed:
    "translate-y-0 opacity-100 transition-[opacity,translate] duration-500 ease-out",
};

export interface RevealProps {
  children: ReactNode;
  /**
   * Applied to the wrapper. This element is a real box in the layout — usually
   * a flex child of the dashboard's `main` — so any grid, spacing or column
   * span the region needs belongs here rather than on a second nested div.
   */
  className?: string;
}

/**
 * Fades a region up by 8px the first time it scrolls into view.
 *
 * Three properties are load-bearing, and each one is a rule about what this
 * must *not* be able to do:
 *
 * 1. **It cannot hide content.** The server renders `initial`, which has no
 *    opacity and no transform, so the HTML that reaches the browser — and the
 *    crawler, and the reader-mode extraction — is a complete, visible page.
 *    Nothing is dimmed until client JavaScript has run and measured the
 *    element, so a page whose bundle never executes, whose observer never
 *    constructs, or whose observer never fires is a page with no animation
 *    rather than a page with no content. The reveal is a flourish layered onto
 *    a working page, never a gate in front of one.
 *
 * 2. **It cannot animate anything the operator is already looking at.** The
 *    element is only armed if, at mount, it sits entirely below the fold. This
 *    is not just an optimisation for the top of the page — it is the whole
 *    answer to re-animation. A filter change, a `router.refresh()`, a poll that
 *    swaps a panel's data: any of those can remount this component, but if the
 *    region is on screen at that moment the measurement declines to arm it and
 *    the data lands with no transition at all. A region can therefore only ever
 *    animate somewhere the operator cannot see it happen, which is the only
 *    place an entrance animation is ever correct. It also means the first block
 *    or two of every page — the thing the operator navigated here for — paints
 *    at full opacity immediately, so no page is ever slower than it was.
 *
 * 3. **It cannot cost anything after it has run.** One observer per element,
 *    disconnected inside the callback that fires it, and none created at all
 *    for a visitor who asked for reduced motion. There is no scroll handler:
 *    the browser reports the crossing once, off the main thread, instead of
 *    every region on the page running a measurement on every scrolled frame.
 */
export function Reveal({ children, className }: RevealProps) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("initial");

  useEffect(() => {
    if (reduced || window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      // Also the repair path for someone who turns reduced motion *on* while a
      // region below them is already armed: without this the effect would
      // simply stop, leaving that region invisible until they reloaded. A
      // no-op when the phase is already `initial`, which is the usual case.
      setPhase("initial");
      return;
    }

    const element = ref.current;
    if (!element) return;
    // Nothing to arm *with*. Bailing here rather than after the class has been
    // applied is the difference between a page with no animation and a page
    // with a permanently invisible region.
    if (typeof IntersectionObserver === "undefined") return;

    const rect = element.getBoundingClientRect();
    // A zero-height region is a block that rendered nothing — a conditional
    // alert that isn't showing, an empty list. Arming it would leave an
    // observer watching a box that can never intersect anything.
    if (rect.height === 0) return;
    // Already on screen, or already scrolled past: see property 2 above. Note
    // this runs after the browser has painted, so arming an element here would
    // be visible as a flash if it were not off screen — which is exactly why
    // the condition is "entirely below the fold" rather than a softer
    // threshold somewhere up in the viewport.
    if (rect.top < window.innerHeight) return;

    setPhase("armed");

    let heartbeat = 0;

    const observer = new IntersectionObserver(
      (entries) => {
        // Any callback at all — including the "not intersecting yet" one every
        // conforming implementation delivers a frame or so after `observe()` —
        // is proof the observer is alive, which is the whole question the
        // heartbeat below is asking.
        window.clearTimeout(heartbeat);

        if (!entries[0]?.isIntersecting) return;
        // Disconnected before the state update rather than after, so the
        // subscription is gone even if the render that follows throws.
        observer.disconnect();
        setPhase("revealed");
      },
      { rootMargin: ROOT_MARGIN },
    );

    // The last thing standing between a broken observer and a blank region.
    // Everything above makes an observer that *works* impossible to miss, but
    // none of it helps if the callback never arrives at all — a browser without
    // a real implementation behind the constructor, a polyfill that failed to
    // install, an extension that replaced it. Verified by stubbing the
    // constructor to accept `observe()` and never call back: without this, four
    // regions on /analytics stayed at `opacity: 0` for the life of the page.
    //
    // This is a liveness check and not a reveal timer, which is why it is armed
    // before `observe()` and cleared by the first callback rather than by the
    // first *intersection*: on any working browser it is cancelled within a
    // frame or two and never influences when a region appears. On a broken one
    // it costs the animation and keeps the page.
    heartbeat = window.setTimeout(() => {
      observer.disconnect();
      setPhase("revealed");
    }, OBSERVER_HEARTBEAT_MS);

    observer.observe(element);

    return () => {
      window.clearTimeout(heartbeat);
      observer.disconnect();
    };
  }, [reduced]);

  return (
    <div ref={ref} className={cn(PHASE_CLASS[phase], className)}>
      {children}
    </div>
  );
}
