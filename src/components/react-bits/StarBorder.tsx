"use client";

/*
 * Vendored from React Bits (https://reactbits.dev/r/StarBorder-TS-TW), MIT +
 * Commons Clause. No third-party dependency — it is two blurred radial
 * gradients on a CSS keyframe. Copied in by the shadcn CLI. Changes from
 * upstream, marked `EDIT:`:
 *
 *   1. `"use client"` — not strictly required (there are no hooks) but this is
 *      only ever used around an interactive control, and the directive keeps
 *      the whole family of vendored files consistent.
 *   2. The inner surface is transparent and unstyled instead of
 *      `bg-gradient-to-b from-black to-gray-900 border-gray-800 text-white`
 *      with 16px/26px padding baked in. Upstream ships a finished dark button;
 *      here it has to wrap the app's own `Button`, whose size, radius and
 *      `pointer-coarse:h-11` touch target are not this component's business.
 *   3. `contentClassName` — so the caller can give that inner surface a
 *      radius that matches the control inside it.
 *   4. The two casts to `any` are gone. `next/typescript` bans them and they
 *      were only there because upstream spreads a generic prop bag.
 *   5. `motion-reduce:animate-none` on both beams.
 *
 * The `animate-star-movement-*` utilities and their keyframes are declared in
 * `src/app/globals.css`. Upstream ships them as a `tailwind.config.js` snippet
 * in a trailing comment, which is Tailwind v3; this project is on v4 and has
 * no such file.
 */

import React from 'react';

type StarBorderOwnProps = {
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
  color?: string;
  speed?: React.CSSProperties['animationDuration'];
  thickness?: number;
};

type StarBorderProps<T extends React.ElementType> = StarBorderOwnProps & {
  as?: T;
} & Omit<React.ComponentPropsWithoutRef<T>, keyof StarBorderOwnProps | 'as'>;

const StarBorder = <T extends React.ElementType = 'div'>({
  as,
  className = '',
  contentClassName = '',
  color = 'currentColor',
  speed = '6s',
  thickness = 1,
  children,
  ...rest
}: StarBorderProps<T>) => {
  const Component = (as ?? 'div') as React.ElementType;

  return (
    <Component
      className={`relative inline-block overflow-hidden rounded-full ${className}`}
      style={{ padding: `${thickness}px 0` }}
      {...rest}
    >
      <span
        aria-hidden="true"
        className="animate-star-movement-bottom absolute right-[-250%] bottom-[-11px] z-0 h-[50%] w-[300%] rounded-full opacity-70 motion-reduce:animate-none"
        style={{
          background: `radial-gradient(circle, ${color}, transparent 10%)`,
          animationDuration: speed,
        }}
      />
      <span
        aria-hidden="true"
        className="animate-star-movement-top absolute top-[-10px] left-[-250%] z-0 h-[50%] w-[300%] rounded-full opacity-70 motion-reduce:animate-none"
        style={{
          background: `radial-gradient(circle, ${color}, transparent 10%)`,
          animationDuration: speed,
        }}
      />
      <span className={`relative z-[1] block rounded-full ${contentClassName}`}>
        {children}
      </span>
    </Component>
  );
};

export default StarBorder;
