"use client";

/*
 * Vendored from React Bits (https://reactbits.dev/r/AnimatedContent-TS-TW),
 * MIT + Commons Clause. Copied in by the shadcn CLI, so this file is ours.
 * Changes from upstream, all marked `EDIT:`:
 *
 *   1. `"use client"` — upstream targets Vite and ships no directive.
 *   2. The `invisible` class is gone. Upstream renders
 *      `<div class="invisible">{children}</div>` and only lifts it once
 *      GSAP's ScrollTrigger has fired, which means every section of the page
 *      is `visibility: hidden` in the server HTML and stays hidden for anyone
 *      whose JavaScript did not run. That is a wrapper you cannot put around
 *      the copy on a page written to be read by Google's OAuth reviewers and
 *      by a Safe Browsing crawler. The starting state is now set in a
 *      `useLayoutEffect`, which runs before the browser paints, so there is
 *      still no flash of un-animated content — but the HTML itself is honest.
 *   3. `prefers-reduced-motion` — upstream animates unconditionally. Here the
 *      children are rendered untouched and GSAP is never asked to do anything.
 *   4. The `document.getElementById('snap-main-container')` fallback scroller
 *      is gone. It is a leftover from React Bits' own site and silently
 *      re-points ScrollTrigger at whatever element happens to carry that id.
 */

import React, { useRef, useLayoutEffect } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

interface AnimatedContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  container?: Element | string | null;
  distance?: number;
  direction?: 'vertical' | 'horizontal';
  reverse?: boolean;
  duration?: number;
  ease?: string;
  initialOpacity?: number;
  animateOpacity?: boolean;
  scale?: number;
  threshold?: number;
  delay?: number;
  onComplete?: () => void;
}

const AnimatedContent: React.FC<AnimatedContentProps> = ({
  children,
  container,
  distance = 100,
  direction = 'vertical',
  reverse = false,
  duration = 0.8,
  ease = 'power3.out',
  initialOpacity = 0,
  animateOpacity = true,
  scale = 1,
  threshold = 0.1,
  delay = 0,
  onComplete,
  className = '',
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // EDIT: honour the OS preference. `matchMedia` rather than a React hook so
    // the check happens in the same pre-paint pass that would otherwise hide
    // the element, and nothing is ever hidden for these visitors.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let scrollerTarget: Element | string | null = container ?? null;
    if (typeof scrollerTarget === 'string') {
      scrollerTarget = document.querySelector(scrollerTarget);
    }

    const axis = direction === 'horizontal' ? 'x' : 'y';
    const offset = reverse ? -distance : distance;
    const startPct = (1 - threshold) * 100;

    const ctx = gsap.context(() => {
      gsap.set(el, {
        [axis]: offset,
        scale,
        opacity: animateOpacity ? initialOpacity : 1
      });

      const tl = gsap.timeline({ paused: true, delay, onComplete });
      tl.to(el, { [axis]: 0, scale: 1, opacity: 1, duration, ease });

      ScrollTrigger.create({
        trigger: el,
        scroller: scrollerTarget || window,
        start: `top ${startPct}%`,
        once: true,
        onEnter: () => tl.play()
      });
    }, el);

    return () => ctx.revert();
  }, [
    container,
    distance,
    direction,
    reverse,
    duration,
    ease,
    initialOpacity,
    animateOpacity,
    scale,
    threshold,
    delay,
    onComplete
  ]);

  return (
    <div ref={ref} className={className} {...props}>
      {children}
    </div>
  );
};

export default AnimatedContent;
