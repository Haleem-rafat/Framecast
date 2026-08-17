"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowRight, Hand } from "lucide-react";

import SplitFlapText from "@/components/react-bits/SplitFlapText";
import StarBorder from "@/components/react-bits/StarBorder";
import Threads from "@/components/react-bits/Threads";
import { Button } from "@/components/ui/button";

/**
 * The brand violet, per theme, as the `[r, g, b]` triple in 0–1 that a shader
 * uniform wants.
 *
 * React Bits' Threads is WebGL: it cannot read `--brand-violet`, which is an
 * `oklch()` custom property. These are that exact token converted to sRGB and
 * normalised. If globals.css changes the hue, change it here too — there is no
 * way for the shader to follow it on its own, and that is the standing cost of
 * a WebGL background inside a design system built on CSS variables.
 */
const THREAD_COLOR = {
  // oklch(0.55 0.2 285) → #6b55df
  light: [0.42, 0.333, 0.875],
  // oklch(0.68 0.18 285) → #9083ff
  dark: [0.565, 0.514, 1],
} as const;

/**
 * The seven things a run produces, in the order it produces them. Every one is
 * a real artefact — nothing here is a feature that has not been built.
 *
 * Uppercase and short because they are going on a split-flap board, which is a
 * fixed grid of character tiles: the board is padded to the longest phrase, so
 * a long one would set the width for all of them and push the line off a
 * 390px screen.
 */
const STAGES = [
  "SCRIPT",
  "NARRATION",
  "FOOTAGE",
  "CAPTIONS",
  "MUSIC",
  "THUMBNAIL",
  "UPLOAD",
];

/**
 * The woven-line field behind the hero, or nothing.
 *
 *  1. It is a WebGL loop, so anyone who has asked their OS for reduced motion
 *     gets the flat gradient underneath and no canvas at all.
 *  2. Its colour has to come from the resolved theme, and `next-themes` only
 *     knows that on the client — so it waits for mount rather than guessing
 *     and then flipping.
 *  3. It is decoration. Nothing in the hero's meaning is inside it.
 *
 * Threads rather than the library's Aurora, which was the first thing tried
 * here. Aurora paints a saturated field across the whole frame; measured on
 * the light theme the lead paragraph ended up as grey text on teal. This draws
 * thin lines on a transparent ground, so the type keeps the page's own
 * background behind it and the contrast is unchanged.
 */
function HeroThreads() {
  const { resolvedTheme } = useTheme();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setEnabled(!query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  if (!enabled) return null;

  return (
    <div
      aria-hidden="true"
      // Sized from this box, never from the viewport, so the canvas cannot be
      // the thing that puts a horizontal scrollbar on a 390px phone. Masked to
      // the bottom so the lines gather under the type rather than running
      // through it.
      className="absolute inset-x-0 bottom-0 -z-10 h-[70%] opacity-40 [mask-image:linear-gradient(to_top,black_10%,transparent_85%)] dark:opacity-60"
    >
      <Threads
        color={
          [...THREAD_COLOR[resolvedTheme === "dark" ? "dark" : "light"]] as [
            number,
            number,
            number,
          ]
        }
        amplitude={1.6}
        distance={0.3}
        enableMouseInteraction={false}
      />
    </div>
  );
}

/**
 * The production board.
 *
 * A split-flap departure board, clacking through the seven artefacts a run
 * produces in the order it produces them. It is the one piece of motion in the
 * hero that is also information: the same list v1 states as a seven-clause
 * sentence, read out one stage at a time.
 *
 * The tile and text colours are passed as hex per theme because the component
 * puts them into `color-mix()` and gradients rather than into a class, so it
 * cannot take a `var()`. `useTheme` again, and again it renders nothing until
 * mounted so the server and the first client render agree.
 */
function ProductionBoard() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const dark = resolvedTheme === "dark";

  return (
    <div className="mt-7 flex flex-col items-center gap-2.5 sm:mt-8">
      <p className="text-muted-foreground font-mono text-[10px] tracking-[0.22em] uppercase">
        One run produces
      </p>

      {/* A reserved box, so the board arriving after mount does not shove the
          paragraph and the buttons below it down the page. */}
      <div className="flex h-[2.6rem] items-center sm:h-[3.4rem]">
        {mounted ? (
          <SplitFlapText
            words={STAGES}
            padTo={9}
            gap={4}
            tileRadius={6}
            // A string, not a number: the board is a fixed grid of `0.78em`
            // tiles, so its width is set by the font size, and nine tiles at
            // the desktop size are wider than a 390px phone.
            fontSize="clamp(1.5rem, 7vw, 2.5rem)"
            charset="alpha"
            cycleDelay={2200}
            tileColor={dark ? "#2a2440" : "#1c1830"}
            textColor={dark ? "#f4f2ff" : "#f8fafc"}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * v2's hero.
 *
 * v1 opens with a centred masthead inside a bordered section — badge,
 * headline, a five-line paragraph, a bordered box, two buttons — and reads
 * like the top of a document. This is a full-height opening frame with a woven
 * light field gathering at its foot and a departure board naming what the
 * machine is about to make.
 *
 * Two things it is not allowed to lose, both carried over from v1 and both
 * documented there:
 *
 *  - The approval-gate claim. It is the most trust-building true thing this
 *    product can say and the main line between it and "an AI posts to my
 *    channel unsupervised". It sits below the buttons rather than above them —
 *    v1 has to reorder it with `order-last` on a phone for the same reason,
 *    and putting it after them in source order gets there without a CSS rule.
 *  - Both calls to action above the fold at 390px. The lead is one short
 *    sentence rather than v1's five-line one; the full pipeline sentence is
 *    further down, in the band that is about the pipeline.
 *
 * The gradient on "finished video" is the `-ink` triple, not the decorative
 * one. `bg-clip-text` makes the gradient the text's actual colour, and the
 * decorative cyan measures 2.18:1 on the light ground — under even the 3:1
 * floor that large text gets. It is also plain static text rather than a
 * per-word animation: React Bits' BlurText was tried here first, and a
 * `bg-clip-text` gradient across a line of individually transformed
 * `inline-block` words clips to glyphs that are mid-flight and ghosts badly.
 *
 * Named brands are plain text. No mark, no logo, no borrowed brand colour —
 * this domain is under a Safe Browsing review and that is exactly the signal
 * not to send.
 */
export function V2Hero() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden">
      <HeroThreads />
      {/* Always painted, threads or not: this is the ground the hero stands on
          and it is what a reduced-motion visitor sees instead. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/12 via-brand-blue/5 absolute inset-0 -z-20 bg-gradient-to-b to-transparent"
      />

      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-24">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        <h1 className="mt-6 text-[2.25rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          Type a topic. Get a{" "}
          <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
            finished video
          </span>
          .
        </h1>

        <ProductionBoard />

        <p className="text-muted-foreground mt-7 max-w-xl text-base text-pretty sm:text-lg">
          No writing, no recording, no editing — and nothing reaches your
          channel that you have not watched first.
        </p>

        {/* React Bits' StarBorder around the primary action. v1 puts a static
            blurred halo behind this button; this is a light that travels round
            its edge instead. The button inside is untouched — same
            `--primary`, same `size="lg"`, so it still grows to the 44px touch
            floor under `pointer-coarse`. */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <StarBorder
            color="var(--brand-violet)"
            speed="5s"
            thickness={2}
            contentClassName="bg-background/40 p-[2px] backdrop-blur-sm"
          >
            <Button asChild size="lg" className="rounded-full px-5">
              <Link href="/sign-up">
                Create an account
                <ArrowRight />
              </Link>
            </Button>
          </StarBorder>

          <Button asChild size="lg" variant="outline" className="rounded-full px-5">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>

        <p className="border-brand-amber-ink/35 bg-background/50 mt-7 flex max-w-xl items-start gap-3 rounded-2xl border px-4 py-3 text-left text-sm text-pretty backdrop-blur-sm">
          <Hand className="text-brand-amber-ink mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">And it stops twice, for you.</span>{" "}
            <span className="text-muted-foreground">
              Nothing runs until you have approved the script. Nothing publishes
              until you have watched the finished video.
            </span>
          </span>
        </p>

        <p className="text-muted-foreground mt-5 max-w-md text-xs text-pretty">
          Free while in beta. Framecast is under active development, and every
          account is reviewed by an operator before it can be used.
        </p>
      </div>
    </section>
  );
}
