"use client";

import { motion } from "motion/react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

/**
 * Aceternity's "Spotlight (new)", adapted in three ways.
 *
 * 1. Theming. Upstream hard-codes blue `hsla()` beams, which are invisible on a
 *    white page. The stops now come from `--spotlight-*` in globals.css, which
 *    are redefined under `.dark`, so both themes work with no JS theme probe
 *    and therefore no flash between server and client render.
 * 2. Reduced motion. The slow left/right drift is dropped entirely (not merely
 *    shortened) when the visitor asks for less motion; the beams still fade in
 *    so the composition is unchanged.
 * 3. Containment. Upstream sizes the two beam groups `w-screen h-screen`, which
 *    pushes a horizontal scrollbar onto narrow phones. They are `w-full h-full`
 *    here, and the parent is expected to be `relative overflow-hidden`. The
 *    upstream `z-40` is gone too — at that level the beams paint *over* the
 *    headline and tint it.
 */
type SpotlightProps = {
  translateY?: number;
  width?: number;
  height?: number;
  smallWidth?: number;
  duration?: number;
  xOffset?: number;
};

const GRADIENT_FIRST =
  "radial-gradient(68.54% 68.72% at 55.02% 31.46%, var(--spotlight-core) 0, var(--spotlight-mid) 50%, transparent 80%)";
const GRADIENT_SECOND =
  "radial-gradient(50% 50% at 50% 50%, var(--spotlight-mid) 0, var(--spotlight-edge) 80%, transparent 100%)";
const GRADIENT_THIRD =
  "radial-gradient(50% 50% at 50% 50%, var(--spotlight-edge) 0, var(--spotlight-edge) 80%, transparent 100%)";

export function Spotlight({
  translateY = -350,
  width = 560,
  height = 1380,
  smallWidth = 240,
  duration = 9,
  xOffset = 90,
}: SpotlightProps = {}) {
  const reduceMotion = usePrefersReducedMotion();

  // Transform-only and composited, so the browser can run it off the main
  // thread; a single pair of drifting layers is the whole animation budget for
  // this page above the fold.
  const drift = (offset: number) =>
    reduceMotion
      ? undefined
      : {
          animate: { x: [0, offset, 0] },
          transition: {
            duration,
            repeat: Infinity,
            repeatType: "reverse" as const,
            ease: "easeInOut" as const,
          },
        };

  return (
    <motion.div
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.5 }}
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <motion.div
        {...drift(xOffset)}
        className="pointer-events-none absolute top-0 left-0 h-full w-full"
      >
        <div
          style={{
            transform: `translateY(${translateY}px) rotate(-45deg)`,
            background: GRADIENT_FIRST,
            width: `${width}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 left-0"
        />
        <div
          style={{
            transform: "rotate(-45deg) translate(5%, -50%)",
            background: GRADIENT_SECOND,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 left-0 origin-top-left"
        />
        <div
          style={{
            transform: "rotate(-45deg) translate(-180%, -70%)",
            background: GRADIENT_THIRD,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 left-0 origin-top-left"
        />
      </motion.div>

      <motion.div
        {...drift(-xOffset)}
        className="pointer-events-none absolute top-0 right-0 h-full w-full"
      >
        <div
          style={{
            transform: `translateY(${translateY}px) rotate(45deg)`,
            background: GRADIENT_FIRST,
            width: `${width}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 right-0"
        />
        <div
          style={{
            transform: "rotate(45deg) translate(-5%, -50%)",
            background: GRADIENT_SECOND,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 right-0 origin-top-right"
        />
        <div
          style={{
            transform: "rotate(45deg) translate(180%, -70%)",
            background: GRADIENT_THIRD,
            width: `${smallWidth}px`,
            height: `${height}px`,
          }}
          className="absolute top-0 right-0 origin-top-right"
        />
      </motion.div>
    </motion.div>
  );
}
