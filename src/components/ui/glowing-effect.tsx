"use client";

import { animate } from "motion/react";
import { memo, useCallback, useEffect, useRef } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's GlowingEffect: a conic sliver of light that runs around a card's
 * border and points back at the cursor.
 *
 * Adapted from upstream in three ways that matter.
 *
 * 1. Where the listener lives. Upstream attaches a `pointermove` handler to
 *    `document.body` *per instance*, so a nine-tile grid installs nine global
 *    listeners, each doing a `getBoundingClientRect` on every mouse move
 *    anywhere on the page. This attaches to the card itself, so a tile only
 *    does work while the pointer is actually over it — one card's worth of
 *    measurement at a time instead of nine. The cost is upstream's `proximity`
 *    option, where a card lights up before you reach it; that is not worth
 *    nine permanent listeners on a 2-vCPU box.
 * 2. Colour. Upstream's gradient is four fixed hexes — pink, mustard, green and
 *    slate blue — which is a rainbow, not a palette. It draws in the four
 *    `--brand-*` marketing tokens now, so the glow is the page's own grade.
 * 3. Reduced motion turns it off, and `disabled` still forces it off. Upstream
 *    defaults `disabled` to `true`, which quietly does nothing until you notice
 *    the prop; the default here is on, because that is why you would add it.
 */
export const GlowingEffect = memo(function GlowingEffect({
  blur = 0,
  inactiveZone = 0.6,
  spread = 24,
  className,
  disabled = false,
  movementDuration = 1.4,
  borderWidth = 1,
}: {
  blur?: number;
  /** Fraction of the card's centre that counts as "not pointing at an edge". */
  inactiveZone?: number;
  spread?: number;
  className?: string;
  disabled?: boolean;
  movementDuration?: number;
  borderWidth?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const reduceMotion = usePrefersReducedMotion();
  const off = disabled || reduceMotion;

  const handleMove = useCallback(
    (event: PointerEvent) => {
      const element = containerRef.current;
      if (!element) return;

      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        const { left, top, width, height } = element.getBoundingClientRect();
        const centerX = left + width * 0.5;
        const centerY = top + height * 0.5;
        const distance = Math.hypot(event.x - centerX, event.y - centerY);

        // Dead zone in the middle: without it the sliver spins wildly as the
        // pointer crosses the centre, where "which edge" has no answer.
        if (distance < 0.5 * Math.min(width, height) * inactiveZone) {
          element.style.setProperty("--active", "0");
          return;
        }
        element.style.setProperty("--active", "1");

        const current =
          Number.parseFloat(element.style.getPropertyValue("--start")) || 0;
        const target =
          (180 * Math.atan2(event.y - centerY, event.x - centerX)) / Math.PI +
          90;
        // Take the short way round rather than unwinding through 360°.
        const next = current + ((((target - current + 180) % 360) + 360) % 360) - 180;

        animate(current, next, {
          duration: movementDuration,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (value) =>
            element.style.setProperty("--start", String(value)),
        });
      });
    },
    [inactiveZone, movementDuration],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (off || !element) return;

    const parent = element.parentElement;
    if (!parent) return;

    const handleLeave = () => element.style.setProperty("--active", "0");

    parent.addEventListener("pointermove", handleMove, { passive: true });
    parent.addEventListener("pointerleave", handleLeave, { passive: true });

    return () => {
      cancelAnimationFrame(frameRef.current);
      parent.removeEventListener("pointermove", handleMove);
      parent.removeEventListener("pointerleave", handleLeave);
    };
  }, [handleMove, off]);

  if (off) return null;

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={
        {
          "--blur": `${blur}px`,
          "--spread": spread,
          "--start": "0",
          "--active": "0",
          "--glow-border-width": `${borderWidth}px`,
          "--gradient": `radial-gradient(circle, var(--brand-violet) 10%, transparent 20%),
            radial-gradient(circle at 40% 40%, var(--brand-amber) 5%, transparent 15%),
            radial-gradient(circle at 60% 60%, var(--brand-cyan) 10%, transparent 20%),
            radial-gradient(circle at 40% 60%, var(--brand-blue) 10%, transparent 20%),
            repeating-conic-gradient(
              from 236.84deg at 50% 50%,
              var(--brand-violet) 0%,
              var(--brand-blue) 5%,
              var(--brand-cyan) 10%,
              var(--brand-amber) 15%,
              var(--brand-violet) 20%
            )`,
        } as React.CSSProperties
      }
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit]",
        blur > 0 && "blur-[var(--blur)]",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-[inherit]",
          'after:absolute after:inset-[calc(-1*var(--glow-border-width))] after:rounded-[inherit] after:content-[""]',
          "after:[border:var(--glow-border-width)_solid_transparent]",
          "after:[background:var(--gradient)] after:[background-attachment:fixed]",
          "after:opacity-[var(--active)] after:transition-opacity after:duration-300",
          "after:[mask-clip:padding-box,border-box] after:[mask-composite:intersect]",
          "after:[mask-image:linear-gradient(#0000,#0000),conic-gradient(from_calc((var(--start)-var(--spread))*1deg),#00000000_0deg,#fff,#00000000_calc(var(--spread)*2deg))]",
        )}
      />
    </div>
  );
});
