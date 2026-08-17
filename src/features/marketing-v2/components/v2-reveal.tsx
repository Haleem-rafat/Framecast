"use client";

import AnimatedContent from "@/components/react-bits/AnimatedContent";

/**
 * The one scroll-reveal on this page, wrapped once so the sections below stay
 * server components and the arguments are stated in a single place.
 *
 * Short and shallow on purpose: 24px of travel over 0.5s, no scale, and it
 * fires when the block is 15% into the viewport. React Bits' defaults are
 * 100px and 0.8s with a `power3.out` ease, which on a page of eight stacked
 * sections reads as the whole document sliding around underneath you.
 *
 * The vendored component has been edited so the children are never
 * `visibility: hidden` in the server HTML and so the whole effect is skipped
 * under `prefers-reduced-motion` — see the header of
 * `src/components/react-bits/AnimatedContent.tsx`.
 */
export function V2Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <AnimatedContent
      distance={24}
      duration={0.5}
      ease="power2.out"
      threshold={0.15}
      delay={delay}
      className={className}
    >
      {children}
    </AnimatedContent>
  );
}
