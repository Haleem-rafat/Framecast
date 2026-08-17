"use client";

import ScrollReveal from "@/components/react-bits/ScrollReveal";

/**
 * The supporting line under a band heading, un-blurring word by word as the
 * band comes up the screen.
 *
 * Used on three bands, not eight. React Bits' ScrollReveal is scrubbed to
 * scroll position rather than fired once, which means it is doing layout work
 * on every frame you scroll — putting one on every paragraph would be both
 * expensive and, worse, monotonous. It goes on the three bands whose opening
 * line is a claim rather than a label: the run, the output, and the studio.
 *
 * `baseRotation={0}` and a gentle `baseOpacity`. Upstream's defaults tilt the
 * whole paragraph three degrees and start it at 10% opacity, which on a page
 * of stacked bands reads as the document sliding around underneath you.
 *
 * The vendored copy has been edited so it renders a `<div><p>` rather than
 * upstream's `<h2><p>` — a heading element wrapped around body copy would put
 * a second `<h2>` beside every real one on the page — and so it skips GSAP
 * entirely under `prefers-reduced-motion`. See the header of
 * `src/components/react-bits/ScrollReveal.tsx`.
 *
 * `children` must be a plain string: upstream splits it with a regex and
 * silently renders nothing for element children.
 */
export function V2Lead({ children }: { children: string }) {
  return (
    <ScrollReveal
      baseOpacity={0.25}
      baseRotation={0}
      blurStrength={3}
      containerClassName="mt-4"
      textClassName="text-muted-foreground text-base text-pretty sm:text-lg"
    >
      {children}
    </ScrollReveal>
  );
}
