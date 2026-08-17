"use client";

/*
 * Vendored from React Bits (https://reactbits.dev/r/SpotlightCard-TS-TW),
 * MIT + Commons Clause. No third-party dependency at all — it is a pointer
 * position and a radial gradient. Copied in by the shadcn CLI, so this file is
 * ours. Changes from upstream, all marked `EDIT:`:
 *
 *   1. `"use client"` — upstream targets Vite and ships no directive.
 *   2. The card's own colours are tokens rather than `border-neutral-800
 *      bg-neutral-900`. Upstream is painted for a dark demo site; hard-coded
 *      neutrals here would be a black card on the light theme, and passing an
 *      overriding class would not reliably win because two utilities of equal
 *      specificity are decided by CSS source order, not by the order they
 *      appear in a `className` string.
 *   3. `spotlightColor` defaults to a CSS custom property instead of
 *      `rgba(255,255,255,0.25)`, and its type is widened from the
 *      `rgba(n, n, n, n)` template literal to `string` so a `var()` or an
 *      `oklch()` can be passed. White light on a white card is not light.
 *   4. `prefers-reduced-motion` is respected via CSS — the 500ms opacity
 *      transition is dropped, so the pool appears and disappears at once
 *      rather than fading.
 */

import React, { useRef, useState } from 'react';

interface Position {
  x: number;
  y: number;
}

interface SpotlightCardProps extends React.PropsWithChildren {
  className?: string;
  /** EDIT: widened from a template-literal rgba type — see note 3. */
  spotlightColor?: string;
}

const SpotlightCard: React.FC<SpotlightCardProps> = ({
  children,
  className = '',
  spotlightColor = 'var(--card-spotlight-wash)'
}) => {
  const divRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState<number>(0);

  const handleMouseMove: React.MouseEventHandler<HTMLDivElement> = e => {
    if (!divRef.current || isFocused) return;

    const rect = divRef.current.getBoundingClientRect();
    setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleFocus = () => {
    setIsFocused(true);
    setOpacity(1);
  };

  const handleBlur = () => {
    setIsFocused(false);
    setOpacity(0);
  };

  const handleMouseEnter = () => {
    setOpacity(1);
  };

  const handleMouseLeave = () => {
    setOpacity(0);
  };

  return (
    <div
      ref={divRef}
      onMouseMove={handleMouseMove}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      // EDIT: tokens, so the card follows the theme and the marketing palette.
      className={`border-border bg-card relative overflow-hidden rounded-2xl border ${className}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 ease-in-out motion-reduce:transition-none"
        style={{
          opacity,
          background: `radial-gradient(circle at ${position.x}px ${position.y}px, ${spotlightColor}, transparent 80%)`
        }}
      />
      {children}
    </div>
  );
};

export default SpotlightCard;
