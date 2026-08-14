"use client";

import { motion, useScroll } from "motion/react";
import { useRef, type ReactNode, type RefObject } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export interface TimelineEntry {
  title: string;
  /** Rendered inside the rail's marker. A lucide icon, usually. */
  icon?: ReactNode;
  content: ReactNode;
}

/**
 * Aceternity's Timeline: a vertical rail whose beam fills in as you read down
 * it. Kept for the shape it gives a sequence — you can see how far through the
 * pipeline you are — but rebuilt fairly heavily.
 *
 * - Upstream paints `bg-white dark:bg-neutral-950`, a purple-to-blue beam and
 *   its own hard-coded heading and blurb. All three are gone: the component is
 *   now transparent, draws in `--primary`/`--border`, and renders only the
 *   entries it is given.
 * - Upstream animates the beam's `height`, which is a layout property and makes
 *   the browser reflow the rail on every scroll frame. This animates `scaleY`
 *   from a fixed-height element instead, which the compositor can handle on its
 *   own thread. That also removes the `useState` + `getBoundingClientRect`
 *   measuring pass and the stale height it left behind after a resize.
 * - Under reduced motion the beam is not animated *or* subscribed: the scroll
 *   listener lives in a child that simply is not rendered, so there is no
 *   per-frame work at all, and the rail is drawn already complete.
 * - The layout is a two-column grid rather than absolute offsets, so it holds
 *   together down to 375px without the marker colliding with the text.
 */
export function Timeline({
  data,
  className,
}: {
  data: TimelineEntry[];
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* The unlit track. Masked at both ends so it fades rather than stops. */}
      <div
        aria-hidden="true"
        className="bg-border absolute top-2 bottom-2 left-[1.125rem] w-px -translate-x-1/2 [mask-image:linear-gradient(to_bottom,transparent,black_5%,black_95%,transparent)]"
      />
      {reduceMotion ? (
        <div
          aria-hidden="true"
          className="bg-primary/40 absolute top-2 bottom-2 left-[1.125rem] w-px -translate-x-1/2 [mask-image:linear-gradient(to_bottom,transparent,black_5%,black_95%,transparent)]"
        />
      ) : (
        <TimelineBeam containerRef={containerRef} />
      )}

      <ol className="relative">
        {data.map((entry) => (
          <li
            key={entry.title}
            className="grid grid-cols-[2.25rem_1fr] gap-x-4 pb-12 last:pb-0 sm:gap-x-6 sm:pb-16"
          >
            <span
              aria-hidden="true"
              className="bg-background text-muted-foreground ring-border flex size-9 items-center justify-center rounded-full ring-1 [&_svg]:size-4"
            >
              {entry.icon}
            </span>

            <div className="min-w-0 pt-1">
              <h3 className="text-base font-medium tracking-tight sm:text-lg">
                {entry.title}
              </h3>
              <div className="mt-2">{entry.content}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Split out so that the `useScroll` subscription only exists when it will
 * actually be used — a hook cannot be called conditionally, but a component can
 * be rendered conditionally.
 */
function TimelineBeam({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 65%", "end 85%"],
  });

  return (
    <motion.div
      aria-hidden="true"
      style={{ scaleY: scrollYProgress, transformOrigin: "top" }}
      className="from-primary/70 to-primary/20 absolute top-2 bottom-2 left-[1.125rem] w-px -translate-x-1/2 bg-gradient-to-b [mask-image:linear-gradient(to_bottom,transparent,black_5%,black_95%,transparent)]"
    />
  );
}
