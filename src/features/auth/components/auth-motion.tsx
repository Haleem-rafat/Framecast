"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/**
 * The entrance the (auth) pages get, and the only scripted motion on them.
 *
 * Deliberately one gesture — a short lift and fade, staggered across the three
 * blocks of the shell — rather than anything per-field. Somebody is on this
 * page for a few seconds to get into their account; a form that assembles
 * itself in front of them is a cost, not a flourish. The whole sequence is over
 * in under 400ms including the last delay, it is opacity and transform only
 * (both composited, neither triggers layout), and nothing here sets
 * `pointer-events`, so a field can be clicked and typed into from the first
 * frame — the animation never gates the form.
 *
 * `usePrefersReducedMotion` rather than motion's own `useReducedMotion`: that
 * one returns `null` on the server and resolves in an effect, so a visitor who
 * asked for less motion would get one frame of the animation they opted out of
 * plus a hydration mismatch. The project hook is a `useSyncExternalStore` over
 * the same media query, which settles before the browser paints. When it is on,
 * this renders a plain element with no motion component in the tree at all —
 * the animation is not shortened, it is absent.
 */
export function AuthReveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Seconds. Kept small — see the note above about the total budget. */
  delay?: number;
  className?: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.28,
        delay,
        // Decelerating: fast off the mark, settled at the end. A symmetric
        // ease at this distance reads as sluggish.
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}
