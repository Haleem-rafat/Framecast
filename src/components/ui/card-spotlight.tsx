"use client";

import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * Aceternity's CardSpotlight: a card whose surface lights up in a soft radial
 * pool that follows the pointer.
 *
 * Vendored by hand rather than through `shadcn add`, because of what the
 * registry entry pulls in. `card-spotlight.json` lists
 * `canvas-reveal-effect.json` as a registry dependency, and that component is a
 * `@react-three/fiber` <Canvas> running a GLSL fragment shader — a WebGL
 * dot-matrix animation mounted on hover, plus `three` and `@react-three/fiber`
 * in the bundle of a public landing page. This app is served from a 2-vCPU VPS
 * and the brief for this page rules out a 3-D canvas outright, so the shader is
 * not here.
 *
 * What is here is the effect the component is named for, and it needs no canvas:
 *
 * - The spotlight is one composited element. Upstream paints a flat colour and
 *   masks it with a radial gradient, which is two layers only because the mask
 *   has to reveal the canvas underneath. With no canvas to reveal, the mask and
 *   the colour collapse into a single `radial-gradient` background.
 * - The dot matrix the shader drew is a static CSS dot grid inside that
 *   gradient, so the pool of light still reveals a texture as it moves. It is a
 *   `background-image`, so it costs one paint and no JavaScript.
 * - The pointer position rides `useMotionValue`, so a move retargets a style
 *   without re-rendering the React tree.
 *
 * Cost while idle is zero. The handlers are React mouse props, so they fire only
 * while the pointer is genuinely over this card — a card scrolled off-screen, or
 * any card at all on a touch device, does no work and installs no listener.
 *
 * Under reduced motion the card renders as a plain bordered surface: no motion
 * values, no handlers, no overlay element in the DOM at all. It reads
 * `usePrefersReducedMotion` rather than `useReducedMotion` from `motion`
 * because the latter returns `null` on the server and would hydrate the wrong
 * branch — see the hook's own note.
 *
 * Both themes: the surface is `--card` and the pool is drawn in tokens that are
 * redefined per theme in globals.css, so nothing here hard-codes a dark card.
 * A caller whose ground is fixed-dark regardless of theme — the pricing
 * section, sitting on the lamp — overrides those two tokens locally.
 */
export function CardSpotlight({
  children,
  radius = 350,
  className,
  contentClassName,
  ...props
}: {
  children: ReactNode;
  /** Radius of the pool of light, in pixels. */
  radius?: number;
  /** Classes for the card's own surface — border, background, rounding. */
  className?: string;
  /**
   * Classes for the wrapper the children sit in. Layout belongs here rather
   * than on the surface: the children are one level down, above the light, so
   * `flex` on the surface would lay out this wrapper and nothing else.
   */
  contentClassName?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const [lit, setLit] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  // Hooks cannot be called conditionally, so the template is always built; it
  // is simply never mounted on the reduced-motion branch.
  const spotlight = useMotionTemplate`radial-gradient(${radius}px circle at ${mouseX}px ${mouseY}px, var(--card-spotlight-wash), transparent 80%)`;

  function handleMouseMove({
    currentTarget,
    clientX,
    clientY,
  }: MouseEvent<HTMLDivElement>) {
    const { left, top } = currentTarget.getBoundingClientRect();
    mouseX.set(clientX - left);
    mouseY.set(clientY - top);
  }

  const interactive = !reduceMotion;

  return (
    <div
      className={cn(
        "group/spotlight bg-card relative overflow-hidden rounded-2xl border",
        className,
      )}
      onMouseMove={interactive ? handleMouseMove : undefined}
      onMouseEnter={interactive ? () => setLit(true) : undefined}
      onMouseLeave={interactive ? () => setLit(false) : undefined}
      {...props}
    >
      {interactive && (
        <>
          {/* The pool of light. */}
          <motion.div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-0 transition-opacity duration-300",
              lit ? "opacity-100" : "opacity-0",
            )}
            style={{ backgroundImage: spotlight }}
          />
          {/* The texture it reveals: static, masked by the same pool so it is
              invisible until the light reaches it. */}
          <motion.div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-0 transition-opacity duration-300",
              lit ? "opacity-100" : "opacity-0",
            )}
            style={{
              backgroundImage:
                "radial-gradient(var(--card-spotlight-dot) 1px, transparent 1px)",
              backgroundSize: "8px 8px",
              maskImage: spotlight,
              WebkitMaskImage: spotlight,
            }}
          />
        </>
      )}

      {/* Content sits above the light in its own stacking context, so the pool
          never washes out the text it is behind. */}
      <div className={cn("relative z-10 h-full", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
