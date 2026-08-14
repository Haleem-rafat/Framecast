"use client";

import Image from "next/image";
import { motion, useScroll, useTransform } from "motion/react";
import { useRef, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

/**
 * A laptop lid that swings open as you scroll it into view, with a real
 * screenshot in it. Adapted from Aceternity's MacbookScroll, and reduced hard.
 *
 * What went, and why:
 *
 * - **The keyboard.** Upstream draws a full Apple keyboard: 156 key elements,
 *   including a ⌘ command key and an ⌥ option key. That is a rendered Apple
 *   product on the homepage of a domain currently under a Google Safe Browsing
 *   review where misuse of a third-party mark is the leading suspicion, and it
 *   buys nothing — the screenshot is the point, not the laptop. Dropping it
 *   also drops the 156 nodes and, with them, the entire reason upstream needs
 *   `@tabler/icons-react`, so no new dependency was added. The deck below the
 *   hinge is now an unbranded slab.
 * - **The speaker grilles and trackpad**, for the same reason: detail that only
 *   made the machine more identifiably one company's.
 * - **`min-h-[200vh]`.** Upstream's runway is two full viewports of mostly
 *   empty page. This drives the open from `["start end", "center center"]` —
 *   the lid opens as the section travels from the bottom of the viewport to the
 *   middle — so the animation is over in about one screen of scrolling and
 *   leaves no dead region behind it.
 * - **`scale-[0.35] sm:scale-50 md:scale-100` over a fixed `w-[32rem]`.**
 *   Upstream sizes the machine in absolute pixels and then shrinks the whole
 *   thing at small breakpoints, which is why its text is unreadable on a phone.
 *   The geometry here is `max-w` plus an aspect ratio, so the frame is fluid
 *   from 375px up and the screenshot is never scaled below its container.
 *
 * What stayed: the open itself, which is the effect worth having.
 *
 * Cost. One animated property, `rotateX`, which the compositor owns — a scroll
 * frame touches neither layout nor paint, and a rotated element still occupies
 * its unrotated box so nothing below it reflows. Motion writes it through a
 * motion value, so React does not re-render. Under reduced motion the
 * subscribing component is not mounted at all: there is no scroll listener and
 * no per-frame work, and the lid is simply drawn already open.
 */
export function DeviceScroll({
  src,
  alt,
  width,
  height,
  caption,
  className,
}: {
  src: string;
  /** Describe what the screenshot shows — it carries real information. */
  alt: string;
  width: number;
  height: number;
  caption?: ReactNode;
  className?: string;
}) {
  const reduceMotion = usePrefersReducedMotion();
  const lid = <Lid src={src} alt={alt} width={width} height={height} />;

  return (
    <div className={cn("w-full", className)}>
      <div className="mx-auto w-full max-w-4xl">
        {/* Perspective belongs on the hinge's parent, and only the lid turns —
            rotating the whole assembly would swing the deck up with it, which
            is a machine tipping over rather than a lid opening. */}
        <div className="[perspective:1400px]">
          {reduceMotion ? (
            // Already open. No ref, no `useScroll`, no listener mounted.
            lid
          ) : (
            <OpeningLid>{lid}</OpeningLid>
          )}
        </div>
        <Deck />
      </div>
      {caption}
    </div>
  );
}

/**
 * The only part that subscribes to scroll. Kept as its own component so the
 * reduced-motion branch above can decline to mount it, rather than mounting it
 * and asking it to do nothing.
 */
function OpeningLid({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center center"],
  });

  // Stops at 0.85 rather than 1 so the lid is fully open slightly before the
  // section is centred — the last few degrees of a hinge are the least
  // interesting part, and finishing early means it is flat-on while you read.
  //
  // `rotateX` alone. A scale here would grow the lid without growing the deck
  // below it, and the two would visibly stop being the same machine.
  const rotateX = useTransform(scrollYProgress, [0, 0.85], [-72, 0]);

  return (
    <div ref={ref}>
      <motion.div style={{ rotateX, transformOrigin: "bottom center" }}>
        {children}
      </motion.div>
    </div>
  );
}

/**
 * The screen and its bezel — the part that hinges.
 *
 * `bg-neutral-900` in both themes rather than a token: a screen bezel is dark
 * because screens are, and a light-grey surround on a dark screenshot reads as
 * a rendering bug rather than as a light theme.
 */
function Lid({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
}) {
  return (
    <div className="rounded-t-xl border border-b-0 border-neutral-700/60 bg-neutral-900 p-1.5 shadow-2xl sm:rounded-t-2xl sm:p-2.5">
      <div className="relative aspect-[16/10] overflow-hidden rounded-md bg-neutral-950 sm:rounded-lg">
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          // Not `priority`: this sits below the fold, and preloading a
          // 2880-wide asset would compete with the hero for bandwidth on the
          // connection that can least afford it. `sizes` is what stops a phone
          // downloading the full-width original — it fetches the 640w variant.
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 896px"
          // Below `sm` the whole desktop UI is ~2880px of interface squeezed
          // into ~313px, which is not a small screenshot but an unreadable one:
          // it costs a download and communicates nothing. So a phone gets a
          // crop instead of a thumbnail.
          //
          // The numbers are measured, not guessed. Scaling by `s` about a
          // transform-origin at fraction `o` shows the band from `o(1 - 1/s)`
          // to `o + (1 - o)/s`. At o=97%, s=2.4 that is 56.6%–98.3% of the
          // width, which is the run of header holding the Draft badge, Delete
          // and — the whole point of this section — the Approve script button.
          // An earlier o=78% put the right edge at 87.2% and clipped that
          // button off entirely, which is a crop of everything except the
          // subject.
          className="size-full origin-[97%_6%] scale-[2.4] object-cover object-left-top sm:origin-center sm:scale-100"
        />
      </div>
    </div>
  );
}

/**
 * The slab under the hinge. No keys, no trackpad, no speaker grilles — nothing
 * that identifies a manufacturer, which is the whole point of redrawing it.
 */
function Deck() {
  return (
    <>
      <div className="relative mx-auto h-3 w-full rounded-b-lg bg-gradient-to-b from-neutral-700 to-neutral-800 sm:h-4 sm:rounded-b-xl">
        <div className="absolute inset-x-0 top-0 mx-auto h-[3px] w-24 rounded-b-full bg-neutral-900/70 sm:w-32" />
      </div>
      {/* A soft contact shadow, so the machine sits on something. */}
      <div
        aria-hidden="true"
        className="mx-auto h-6 w-[85%] rounded-[50%] bg-neutral-950/25 blur-xl dark:bg-black/50"
      />
    </>
  );
}
