"use client";

import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's AuroraBackground: two stacked repeating gradients, one striped
 * and one coloured, drifting across each other behind the content.
 *
 * Adapted in four ways.
 *
 * 1. Tailwind v4. Upstream needs an `animate-aurora` utility that came from
 *    `keyframes` in `tailwind.config.js`. That file does not exist here, so the
 *    animation is declared as `--animate-aurora` plus `@keyframes aurora` in
 *    globals.css — the v4 equivalent — rather than reintroducing a v3 config.
 * 2. Palette. The hard-coded blue/indigo/violet hexes are replaced by the
 *    `--brand-*` marketing tokens, which are defined per theme, so the wash is
 *    the same grade as the rest of the page in both light and dark.
 * 3. Cost. Upstream renders the layer at `-inset-[10px]` with `blur(10px)` over
 *    a full viewport and animates it forever. The blur is halved and the whole
 *    thing is masked down to the top of its container, so the browser is
 *    compositing a band rather than a screen. It is still the most expensive
 *    thing on the page, which is why it appears exactly once.
 * 4. Reduced motion stops the drift. The gradients stay — the colour is the
 *    point, the movement is not — so the composition does not change.
 *
 * Upstream's `invert dark:invert-0` is kept, and it is load-bearing: the
 * coloured layer is composited with `mix-blend-difference`, which on a white
 * ground returns each hue's complement — violet and cyan come back as a muddy
 * pink and orange. Inverting in light mode differences against black instead
 * and the intended hues survive. This was worth rediscovering the hard way.
 *
 * Upstream also wrapped itself in a `<main>` element, which would have put a
 * second `<main>` inside the shell's. It renders a plain `<div>` now.
 */
export function AuroraBackground({
  children,
  className,
  containerClassName,
}: {
  children: ReactNode;
  /** Applied to the aurora layer itself, for masking or opacity. */
  className?: string;
  containerClassName?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div className={cn("relative isolate overflow-hidden", containerClassName)}>
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "pointer-events-none absolute -inset-[10px] opacity-40 blur-[8px] invert will-change-transform dark:invert-0",
            "[--aurora:repeating-linear-gradient(100deg,var(--brand-violet)_10%,var(--brand-blue)_16%,var(--brand-cyan)_22%,var(--brand-blue)_28%,var(--brand-violet)_34%)]",
            "[--stripes:repeating-linear-gradient(100deg,var(--background)_0%,var(--background)_7%,transparent_10%,transparent_12%,var(--background)_16%)]",
            "[background-image:var(--stripes),var(--aurora)] [background-position:50%_50%,50%_50%] [background-size:300%,_200%]",
            "after:absolute after:inset-0 after:content-[''] after:[background-image:var(--stripes),var(--aurora)] after:[background-size:200%,_100%] after:mix-blend-difference",
            !reduceMotion && "after:animate-aurora",
            className,
          )}
        />
      </div>

      <div className="relative">{children}</div>
    </div>
  );
}
