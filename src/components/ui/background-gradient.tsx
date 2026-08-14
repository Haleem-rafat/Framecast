"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const GRADIENT = [
  "radial-gradient(circle farthest-side at 0 100%, var(--brand-cyan), transparent)",
  "radial-gradient(circle farthest-side at 100% 0, var(--brand-violet), transparent)",
  "radial-gradient(circle farthest-side at 100% 100%, var(--brand-amber), transparent)",
  "radial-gradient(circle farthest-side at 0 0, var(--brand-blue), transparent)",
].join(",");

/**
 * Aceternity's BackgroundGradient: a card sitting on a soft, slowly shifting
 * halo of colour. Used once, on the plan that is actually available, so the eye
 * lands on the only thing on the pricing section a visitor can act on.
 *
 * Adapted from upstream:
 * - The four hard-coded hexes (`#00ccb1`, `#7b61ff`, `#ffc414`, `#1ca0fb`)
 *   become the four `--brand-*` tokens, and the opaque `#141316` backstop in
 *   the last stop becomes `transparent` — on a light page an almost-black
 *   corner in the halo looks like a rendering fault.
 * - Upstream renders the gradient twice, once blurred and once sharp. Only the
 *   blurred halo is kept. The sharp copy sits directly behind the card where
 *   nothing can see it except as a hard rim at the corners.
 * - `animate` now defaults to following the visitor's motion preference rather
 *   than being unconditionally on. The prop is still there to force it off.
 */
export function BackgroundGradient({
  children,
  className,
  containerClassName,
  animate = true,
}: {
  children?: ReactNode;
  className?: string;
  containerClassName?: string;
  animate?: boolean;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const moving = animate && !reduceMotion;

  return (
    <div className={cn("group relative p-1", containerClassName)}>
      <motion.div
        aria-hidden="true"
        initial={moving ? { backgroundPosition: "0 50%" } : undefined}
        animate={
          moving
            ? { backgroundPosition: ["0 50%", "100% 50%", "0 50%"] }
            : undefined
        }
        transition={
          moving
            ? { duration: 12, repeat: Infinity, repeatType: "reverse" }
            : undefined
        }
        style={{
          backgroundImage: GRADIENT,
          backgroundSize: moving ? "400% 400%" : undefined,
        }}
        className="absolute inset-0 z-0 rounded-[inherit] opacity-50 blur-xl transition-opacity duration-500 will-change-transform group-hover:opacity-80"
      />

      <div className={cn("relative z-10", className)}>{children}</div>
    </div>
  );
}
