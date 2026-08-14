"use client";

import { useMemo } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's Meteors. Kept because it is the cheapest bit of atmosphere in
 * the library: a handful of 2px spans with a CSS gradient tail, animated
 * entirely on `transform` and `opacity`, so the compositor does all of it and
 * the main thread does none.
 *
 * Adapted from upstream:
 * - Tailwind v4. `animate-meteor-effect` came from `tailwind.config.js`
 *   keyframes; it is `--animate-meteor` plus `@keyframes meteor` in globals.css
 *   now, for the same reason the aurora's animation moved there.
 * - Colour. `bg-slate-500` and the `#64748b` tail become the marketing cyan.
 * - Determinism. Upstream calls `Math.random()` during render, so the server
 *   and the client disagree about every delay and duration and React reports a
 *   hydration mismatch on all twenty. The values are derived from the index
 *   here instead — irregular enough to look scattered, identical on both sides.
 * - Reduced motion renders nothing at all. A meteor that does not move is a
 *   dot, and twenty stray dots are worse than an empty sky.
 */
export function Meteors({
  number = 12,
  className,
}: {
  number?: number;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();

  const meteors = useMemo(
    () =>
      Array.from({ length: number }, (_, index) => ({
        // Golden-ratio jitter: spreads the values without clustering, and gives
        // the same answer on the server as in the browser.
        left: `${((index * 61.8) % 100).toFixed(2)}%`,
        delay: `${(((index * 37) % 50) / 10).toFixed(1)}s`,
        duration: `${5 + ((index * 13) % 50) / 10}s`,
      })),
    [number],
  );

  if (reduceMotion) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {meteors.map((meteor, index) => (
        <span
          key={index}
          className={cn(
            "animate-meteor bg-brand-cyan absolute top-0 size-0.5 rotate-[45deg] rounded-full",
            "before:absolute before:top-1/2 before:h-px before:w-[50px] before:-translate-y-1/2 before:bg-gradient-to-r before:from-[var(--brand-cyan)] before:to-transparent before:content-['']",
            className,
          )}
          style={{
            left: meteor.left,
            animationDelay: meteor.delay,
            animationDuration: meteor.duration,
          }}
        />
      ))}
    </div>
  );
}
