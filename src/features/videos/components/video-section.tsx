"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * One card-shaped block on the video page, revealed as it comes into view.
 *
 * The page shows everything about a video at once — pipeline, player, script,
 * timeline, shorts, history — which is a lot of card arriving at once if it all
 * paints flat. A short entrance staggers that into something readable without
 * hiding anything: every section is present in the DOM from the first byte, so
 * a find-in-page, a screen reader and a crawler all see the whole page whether
 * or not the animation ever runs.
 *
 * `IntersectionObserver` rather than a scroll listener: the browser does the
 * work off the main thread and reports once per element, instead of this page
 * running a handler on every frame of every scroll for seven sections.
 */
export function VideoSection({
  children,
  className,
  /** Sections above the fold should not fade in from nothing — they are what
   * the operator came to look at. Set this on the first block or two. */
  immediate = false,
}: {
  children: ReactNode;
  className?: string;
  immediate?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(immediate);

  useEffect(() => {
    // Reduced motion means no reveal at all — not a faster one. The element is
    // simply visible, and no observer is created, so there is nothing running
    // in the background for a visitor who asked for stillness.
    if (reduced || immediate || shown) {
      setShown(true);
      return;
    }

    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      // A little before the edge, so a section is already settled by the time
      // it is properly on screen rather than animating under the operator's
      // eye as they scroll onto it.
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, [reduced, immediate, shown]);

  return (
    <section
      ref={ref}
      className={cn(
        "transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        className,
      )}
    >
      {children}
    </section>
  );
}
