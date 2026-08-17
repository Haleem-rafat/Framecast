"use client";

/*
 * Vendored from React Bits (https://reactbits.dev/r/ScrollReveal-TS-TW),
 * MIT + Commons Clause. Copied in by the shadcn CLI. Changes from upstream,
 * marked `EDIT:`:
 *
 *   1. `"use client"` — upstream targets Vite and ships no directive.
 *   2. `prefers-reduced-motion` — no GSAP at all, and the paragraph renders at
 *      full opacity with no blur and no rotation.
 *   3. The starting opacity is applied by GSAP rather than by an inline style
 *      in the server HTML, so the copy is legible without JavaScript. Every
 *      word is a real text node either way — this component splits on
 *      whitespace and keeps the words in reading order — but upstream's
 *      `baseOpacity` would otherwise ship as `opacity: 0.1` in the markup.
 *
 * Note for anyone reusing this: `children` must be a plain string. Upstream
 * silently renders nothing for element children, because it splits
 * `children` with a regex.
 */

import React, { useEffect, useRef, useMemo, type ElementType, type ReactNode, type RefObject } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

interface ScrollRevealProps {
  children: ReactNode;
  scrollContainerRef?: RefObject<HTMLElement>;
  enableBlur?: boolean;
  baseOpacity?: number;
  baseRotation?: number;
  blurStrength?: number;
  containerClassName?: string;
  textClassName?: string;
  rotationEnd?: string;
  wordAnimationEnd?: string;
  /** EDIT: the wrapping element. Upstream is always an `<h2>` — see note 4. */
  as?: ElementType;
}

const ScrollReveal: React.FC<ScrollRevealProps> = ({
  children,
  scrollContainerRef,
  enableBlur = true,
  baseOpacity = 0.1,
  baseRotation = 3,
  blurStrength = 4,
  containerClassName = '',
  textClassName = '',
  rotationEnd = 'bottom bottom',
  wordAnimationEnd = 'bottom bottom',
  as: Tag = 'div'
}) => {
  const containerRef = useRef<HTMLHeadingElement>(null);

  const splitText = useMemo(() => {
    const text = typeof children === 'string' ? children : '';
    return text.split(/(\s+)/).map((word, index) => {
      if (word.match(/^\s+$/)) return word;
      return (
        <span className="inline-block word" key={index}>
          {word}
        </span>
      );
    });
  }, [children]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // EDIT: see note 2 at the top of the file.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const scroller = scrollContainerRef && scrollContainerRef.current ? scrollContainerRef.current : window;

    // EDIT: everything below is created inside a `gsap.context` scoped to this
    // element, and torn down with `ctx.revert()`. Upstream's cleanup was
    // `ScrollTrigger.getAll().forEach(t => t.kill())` — which kills every
    // ScrollTrigger on the page, including ones this component never created.
    // On a page with more than one scroll-driven component that is not a
    // cleanup, it is a demolition.
    const ctx = gsap.context(() => {
    gsap.fromTo(
      el,
      { transformOrigin: '0% 50%', rotate: baseRotation },
      {
        ease: 'none',
        rotate: 0,
        scrollTrigger: {
          trigger: el,
          scroller,
          start: 'top bottom',
          end: rotationEnd,
          scrub: true
        }
      }
    );

    const wordElements = el.querySelectorAll<HTMLElement>('.word');

    gsap.fromTo(
      wordElements,
      { opacity: baseOpacity, willChange: 'opacity' },
      {
        ease: 'none',
        opacity: 1,
        stagger: 0.05,
        scrollTrigger: {
          trigger: el,
          scroller,
          start: 'top bottom-=20%',
          end: wordAnimationEnd,
          scrub: true
        }
      }
    );

    if (enableBlur) {
      gsap.fromTo(
        wordElements,
        { filter: `blur(${blurStrength}px)` },
        {
          ease: 'none',
          filter: 'blur(0px)',
          stagger: 0.05,
          scrollTrigger: {
            trigger: el,
            scroller,
            start: 'top bottom-=20%',
            end: wordAnimationEnd,
            scrub: true
          }
        }
      );
    }

    }, el);

    return () => ctx.revert();
  }, [scrollContainerRef, enableBlur, baseRotation, baseOpacity, rotationEnd, wordAnimationEnd, blurStrength]);

  // EDIT: upstream returns `<h2><p>…</p></h2>` with a hard-coded
  // `clamp(1.6rem, 4vw, 3rem)` display size. That is a heading element around
  // a paragraph — wrong for the supporting copy this is used on here, and it
  // would put a second `<h2>` next to every real one on the page. The tag is
  // now the caller's choice and the type scale comes from `textClassName`.
  return (
    <Tag ref={containerRef} className={containerClassName}>
      <p className={textClassName}>{splitText}</p>
    </Tag>
  );
};

export default ScrollReveal;
