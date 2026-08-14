"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's LampContainer — two conic gradients meeting at a hot filament,
 * so the section looks lit from a fixture above it. On a page about video that
 * is not decoration: it is a practical light, and it is the one component here
 * that could not be replaced with a gradient and a shrug.
 *
 * Adapted from upstream:
 * - Height. Upstream is `min-h-screen` with the content pulled up by
 *   `-translate-y-80`, a pair of numbers that only agree at one viewport. This
 *   version sizes the fixture in its own right and lets the content sit under
 *   it in normal flow, so it works from 375px up without a magic offset.
 * - Ground. Upstream hard-codes `bg-slate-950` in eight places. This version
 *   drove all eight from one `--lamp-bg`, but pinned that variable to a fixed
 *   near-black so the section stayed dark in both themes — the argument being
 *   that a lamp needs a dark room. That was wrong, and it shipped as a bug: on
 *   a light page the pricing section was the one band that ignored the theme
 *   entirely, and every card inside it had to be hand-painted in whites and
 *   neutrals to stay legible against a ground nothing else shared.
 *
 *   `--lamp-bg` is `var(--background)` now, so the room is whatever the page
 *   is. The fixture still reads as a fixture, because what makes it one is the
 *   two conic beams meeting at a hot filament, not the darkness behind them.
 *   In the light theme those beams are turned down (`--lamp-beam:0.45`) —
 *   at full strength a saturated cyan-to-violet wash over a near-white ground
 *   goes muddy rather than luminous.
 * - Colour. `cyan-400/500` becomes the marketing palette's cyan and violet, so
 *   the beam is the same grade as the rest of the page.
 * - `bg-gradient-conic` is a Tailwind v3 utility with no v4 equivalent. It was
 *   always redundant — the component sets `background-image: conic-gradient(…)`
 *   inline anyway — so it is simply dropped, and `from-*`/`to-*` still supply
 *   `--tw-gradient-stops` to that inline value.
 * - Every animation is `whileInView` with `once`, i.e. one-shot on arrival, and
 *   is skipped entirely under reduced motion — the lamp is then simply already
 *   on.
 */
export function LampSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();

  // Upstream animates `width`, which is a layout property. Kept as-is because
  // it fires once on arrival rather than on every scroll frame, and because the
  // conic gradients are anchored to the element's own box — scaling instead
  // would smear the beam's angle.
  // The final width always lives in `className`, so the reduced-motion branch
  // can return nothing at all and still render a fully-open lamp — no `style`
  // to collide with the `backgroundImage` two of these elements also need.
  const grow = (from: string, to: string) =>
    reduceMotion
      ? {}
      : {
          initial: { width: from, opacity: 0.5 },
          whileInView: { width: to, opacity: 1 },
          viewport: { once: true, amount: 0.3 },
          transition: { delay: 0.2, duration: 0.8, ease: "easeInOut" as const },
        };

  return (
    <div
      className={cn(
        // Every `bg-[var(--lamp-bg)]` below is a mask that blends a beam back
        // into the ground, so the ground and the masks have to be the same
        // colour. Driving both from one variable is what lets that stay true
        // when the theme flips.
        "bg-background relative isolate w-full overflow-hidden [--lamp-beam:0.45] [--lamp-bg:var(--background)] dark:[--lamp-beam:1]",
        className,
      )}
    >
      {/* The fixture. Decorative in full: it carries no information the heading
          below does not already give in text. */}
      <div
        aria-hidden="true"
        className="relative isolate flex h-40 w-full items-center justify-center opacity-[var(--lamp-beam)] sm:h-52"
      >
        <motion.div
          {...grow("15rem", "30rem")}
          style={{
            backgroundImage:
              "conic-gradient(var(--conic-position), var(--tw-gradient-stops))",
          }}
          className="from-brand-cyan absolute inset-auto right-1/2 h-56 w-[30rem] overflow-visible via-transparent to-transparent [--conic-position:from_70deg_at_center_top]"
        >
          <div className="absolute bottom-0 left-0 z-20 h-40 w-full bg-[var(--lamp-bg)] [mask-image:linear-gradient(to_top,white,transparent)]" />
          <div className="absolute bottom-0 left-0 z-20 h-full w-40 bg-[var(--lamp-bg)] [mask-image:linear-gradient(to_right,white,transparent)]" />
        </motion.div>

        <motion.div
          {...grow("15rem", "30rem")}
          style={{
            backgroundImage:
              "conic-gradient(var(--conic-position), var(--tw-gradient-stops))",
          }}
          className="to-brand-violet absolute inset-auto left-1/2 h-56 w-[30rem] from-transparent via-transparent [--conic-position:from_290deg_at_center_top]"
        >
          <div className="absolute right-0 bottom-0 z-20 h-full w-40 bg-[var(--lamp-bg)] [mask-image:linear-gradient(to_left,white,transparent)]" />
          <div className="absolute right-0 bottom-0 z-20 h-40 w-full bg-[var(--lamp-bg)] [mask-image:linear-gradient(to_top,white,transparent)]" />
        </motion.div>

        <div className="absolute top-1/2 h-48 w-full translate-y-12 scale-x-150 bg-[var(--lamp-bg)] blur-2xl" />
        <div className="bg-brand-violet absolute inset-auto z-50 h-36 w-[28rem] -translate-y-1/2 rounded-full opacity-40 blur-3xl" />

        <motion.div
          {...grow("8rem", "16rem")}
          className="bg-brand-cyan absolute inset-auto z-30 h-36 w-64 -translate-y-24 rounded-full opacity-60 blur-2xl"
        />
        {/* The filament itself. */}
        <motion.div
          {...grow("15rem", "30rem")}
          className="bg-brand-cyan absolute inset-auto z-50 h-px w-[30rem] -translate-y-28"
        />

        <div className="absolute inset-auto z-40 h-44 w-full -translate-y-[12.5rem] bg-[var(--lamp-bg)]" />
      </div>

      {/* Lit content. No colour of its own — it inherits `--foreground`, so it
          is light-on-dark or dark-on-light exactly as the rest of the page is. */}
      <div className="relative z-50 -mt-16 sm:-mt-20">{children}</div>
    </div>
  );
}
