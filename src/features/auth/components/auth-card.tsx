import type { ComponentProps } from "react";

import { CardSpotlight } from "@/components/ui/card-spotlight";
import { cn } from "@/lib/utils";

/**
 * The card every (auth) page puts its form in, styled once so the five pages
 * cannot drift apart.
 *
 * The surface is the same one the shell was already built around: slightly
 * translucent over a blur so the wash behind it reads *through* the card
 * instead of stopping dead at its edge, and lifted off the page with a soft
 * shadow rather than a heavier border — on a page this empty, elevation is what
 * separates the form from the ground, and a second strong line would just
 * compete with the fields inside it.
 *
 * What is new is Aceternity's Card Spotlight under it: a soft pool of light
 * that follows the pointer across the card's surface. The component is the one
 * already vendored at `components/ui/card-spotlight` for the landing page —
 * shared rather than reimplemented, so there is exactly one spotlight in this
 * codebase and one place to change it. Its own note explains why the registry's
 * `CanvasRevealEffect` (a `@react-three/fiber` shader, and `three` in the
 * bundle) is not part of it; that reasoning holds twice over on the page whose
 * entire job is to let somebody type a password and leave.
 *
 * Four things make it safe to put a hover effect on a page like this one.
 *
 * 1. It is turned down from the landing page's setting. The wash and the dot
 *    grid are `--card-spotlight-*`, which the caller may override — the pricing
 *    section already does — and the values here are roughly two thirds of the
 *    defaults. On a card carrying labelled inputs, a validation message in
 *    destructive red and a submit button, the pool has to read as the card
 *    catching the light and never as a tint over the text. At these values the
 *    body text, the error text and the input borders hold the contrast they
 *    have with the pointer nowhere near the card.
 * 2. Both are drawn from `--brand-violet` through `color-mix`, not from fresh
 *    literals. The token is redefined per theme in globals.css, so light gets a
 *    violet tint on a near-white card and dark gets a lift on the indigo one,
 *    from one definition neither of which is repeated here.
 * 3. The light paints under the content, never over it: the component keeps its
 *    children in their own stacking context above both layers. That is what
 *    keeps the effect off the Google button in particular — it sits opaque,
 *    above the pool, at every pointer position. Google's guidelines do not
 *    allow that button's fill or its mark to be tinted by anything, so it is
 *    excluded structurally rather than by choosing a weak colour and hoping.
 * 4. Under `prefers-reduced-motion` the component mounts no handlers, no motion
 *    values and no overlay at all — a plain static card.
 */
export function AuthCard({
  className,
  contentClassName,
  children,
  ...props
}: ComponentProps<typeof CardSpotlight>) {
  return (
    <CardSpotlight
      radius={280}
      className={cn(
        "bg-card/85 text-card-foreground rounded-xl border-0 text-sm shadow-2xl shadow-black/[0.06] ring-1 ring-foreground/10 backdrop-blur-md dark:shadow-black/25",
        "[--card-spotlight-wash:color-mix(in_oklch,var(--brand-violet)_7%,transparent)] [--card-spotlight-dot:color-mix(in_oklch,var(--brand-violet)_14%,transparent)]",
        "dark:[--card-spotlight-wash:color-mix(in_oklch,var(--brand-violet)_14%,transparent)] dark:[--card-spotlight-dot:color-mix(in_oklch,var(--brand-violet)_20%,transparent)]",
        className,
      )}
      /**
       * `Card`'s own layout, lifted onto the wrapper the spotlight puts its
       * children in. The card slots the pages use — CardHeader, CardContent —
       * only need the column, the gap and `--card-spacing` to hang their
       * padding off, and this is the level those have to live at: on the
       * surface itself they would lay out the wrapper and nothing else.
       */
      contentClassName={cn(
        "flex flex-col gap-(--card-spacing) py-(--card-spacing) [--card-spacing:--spacing(5)]",
        contentClassName,
      )}
      {...props}
    >
      {children}
    </CardSpotlight>
  );
}
