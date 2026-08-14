"use client";

import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";

import { Card } from "@/components/ui/card";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * The card surface every (auth) page puts its form in, styled once so the five
 * pages cannot drift apart. Slightly translucent over a blur so the wash behind
 * it reads *through* the card instead of stopping dead at its edge, and lifted
 * off the page with a soft shadow rather than a heavier border — on a page this
 * empty, elevation is what separates the form from the ground, and a second
 * strong line would just compete with the fields inside it.
 */
const authCardClassName =
  "bg-card/85 shadow-2xl shadow-black/[0.06] backdrop-blur-md [--card-spacing:--spacing(5)] dark:shadow-black/25";

/** How far the spotlight reaches from the pointer, in px. */
const SPOTLIGHT_RADIUS = 300;

/**
 * The auth card, with Aceternity's Card Spotlight over its surface.
 *
 * The pointer tracking, the `useMotionTemplate` radial mask and the
 * fade-in-on-hover are Aceternity's `CardSpotlight`, taken from the current
 * registry source (`ui.aceternity.com/registry/card-spotlight.json`) rather
 * than from memory. Three things about it are changed, and each is a condition
 * this page has to meet that a component gallery does not.
 *
 * 1. No `CanvasRevealEffect`. Upstream paints a WebGL dot-matrix shader inside
 *    the mask, which is why the registry entry's real dependencies are `three`
 *    and `@react-three/fiber` — roughly three quarters of a megabyte of 3D
 *    runtime, downloaded and compiled, on the page whose entire job is to let
 *    somebody type a password and leave. The named effect, the one the
 *    component's own documentation describes as "a spotlight effect revealing a
 *    radial gradient background", is the masked layer, and that is what is here.
 *    The shader is the part that costs the most and reads the least at this
 *    size, and it is also the part that would animate blue and violet dots
 *    across a form containing an error message. It is left out on purpose.
 *
 * 2. Both themes, from the brand tokens. Upstream is `bg-black` with a
 *    `#262626` fill, which on a near-white card is not a spotlight but a
 *    smudge. The tint here is `--brand-violet` — the same token the landing
 *    page and the mark's bloom use, redefined per theme in globals.css and only
 *    consumed here — held at 6% on light and 10% on dark. That is deliberately
 *    below the level where it does anything to legibility: at 6% over
 *    `--card`, body text, the destructive red of a validation message and the
 *    input borders all keep the contrast they have with the spotlight off. The
 *    effect is meant to be noticed as the card catching the light, not as a
 *    coloured panel appearing under the form.
 *
 * 3. It sits *under* the content, not over it. The overlay is `-z-10` inside an
 *    `isolate` stacking context, so it paints above the card's own background
 *    and below every child — the labels, the inputs, the validation text, the
 *    submit button and, most importantly, the Google button, which is opaque
 *    and unreachable by this layer at any pointer position. Google's guidelines
 *    do not allow that button's fill or mark to be tinted by anything, so it is
 *    excluded structurally rather than by choosing a weak colour and hoping.
 *
 * Under `prefers-reduced-motion` none of this mounts: no listener, no motion
 * values, no overlay — a static card. Note also that no React state is involved
 * even when it is on. Upstream keeps an `isHovering` boolean to gate the
 * canvas; without the canvas there is nothing to gate, so pointer movement
 * writes to motion values and re-renders nothing, and the fade is a plain CSS
 * `group-hover` transition. Moving the mouse across a sign-in form should not
 * re-render it.
 */
export function AuthCard({
  className,
  children,
  ...props
}: ComponentProps<typeof Card>) {
  const prefersReducedMotion = usePrefersReducedMotion();

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const maskImage = useMotionTemplate`radial-gradient(${SPOTLIGHT_RADIUS}px circle at ${mouseX}px ${mouseY}px, white, transparent 80%)`;

  function handleMouseMove({
    currentTarget,
    clientX,
    clientY,
  }: ReactMouseEvent<HTMLDivElement>) {
    const { left, top } = currentTarget.getBoundingClientRect();

    mouseX.set(clientX - left);
    mouseY.set(clientY - top);
  }

  if (prefersReducedMotion) {
    return (
      <Card className={cn(authCardClassName, className)} {...props}>
        {children}
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        authCardClassName,
        // `relative` gives the overlay something to position against and
        // `isolate` gives it a stacking context to be -z-10 *inside*, which is
        // what keeps it above the card's background and below every child.
        "group/spotlight relative isolate",
        className,
      )}
      onMouseMove={handleMouseMove}
      {...props}
    >
      <motion.div
        aria-hidden="true"
        style={{ maskImage }}
        className="bg-brand-violet/6 dark:bg-brand-violet/10 pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover/spotlight:opacity-100"
      />
      {children}
    </Card>
  );
}
