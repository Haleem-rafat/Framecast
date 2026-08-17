"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowRight, Hand } from "lucide-react";

import SplitFlapText from "@/components/react-bits/SplitFlapText";
import StarBorder from "@/components/react-bits/StarBorder";
import { Button } from "@/components/ui/button";

/**
 * The seven things a run produces, in the order it produces them. Every one is
 * a real artefact — nothing here is a feature that has not been built.
 *
 * Uppercase and short because they are going on a split-flap board, which is a
 * fixed grid of character tiles: the board pads to the longest phrase, so one
 * long entry would set the width for all of them and push the line off a 390px
 * screen.
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
 * The hero's ground, drawn entirely in CSS.
 *
 * There is no canvas here and that is deliberate. Three WebGL backgrounds were
 * tried in this slot and all three are gone: React Bits' Aurora, then Threads,
 * then GradientWaves. The technical objections were real — each one binds hex
 * colours to shader uniforms, so it cannot read the `oklch()` brand tokens and
 * needs a hand-maintained sRGB copy of the palette; each one runs an
 * unstoppable `requestAnimationFrame` loop that has to be gated on
 * `prefers-reduced-motion` from outside; and Aurora in particular painted a
 * saturated field across the whole frame, on which the lead paragraph measured
 * as grey text on teal. But the deciding objection was simpler: the owner did
 * not want an animated background, and a hero does not need one.
 *
 * What is here instead is three layers of gradient and a ruled field, which
 * costs one composite, needs no dependency, follows the theme through the
 * tokens directly, and has nothing to switch off for reduced motion because
 * nothing moves.
 *
 * The rules are on purpose rather than decoration for its own sake: evenly
 * spaced vertical lines fanning out under the type read as a timeline ruler,
 * which is the surface this product's whole pipeline is measured against.
 */
function HeroGround() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      {/* The wash the whole section stands on. */}
      <div className="from-brand-violet/12 via-brand-blue/5 absolute inset-0 bg-gradient-to-b to-transparent" />

      {/* A soft pool of light behind the headline, so the type has something
          to sit in rather than floating on a flat field. */}
      <div className="bg-[radial-gradient(60%_45%_at_50%_28%,var(--brand-violet)_0%,transparent_70%)] absolute inset-0 opacity-[0.10] dark:opacity-[0.18]" />

      {/* The ruler. `--border` rather than a brand hue, so it reads as
          structure rather than as more colour, and masked to a band across the
          lower half so it never runs behind the headline. */}
      <div
        className="absolute inset-x-0 bottom-0 h-[55%] [mask-image:linear-gradient(to_top,transparent_0%,black_35%,transparent_100%)]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px 4.5rem)",
        }}
      />

      {/* And a horizon under it, so the ruled band has a floor. */}
      <div className="via-brand-cyan/25 absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent to-transparent" />
    </div>
  );
}

/**
 * The production board.
 *
 * A split-flap departure board clacking through the seven artefacts a run
 * produces, in the order it produces them. It is the one piece of motion in
 * the hero that is also information: the same list v1 states as a seven-clause
 * sentence, read out one stage at a time.
 *
 * React Bits' SplitFlapText is the best-behaved component in the library —
 * it checks `prefers-reduced-motion` itself, takes its tile and text colours
 * as props instead of hard-coding a dark palette, and pads every phrase to the
 * width of the longest, so the board cannot reflow the line under it.
 *
 * Those colours are passed as hex per theme because the component puts them
 * into `color-mix()` and gradients rather than into a class, so it cannot take
 * a `var()`. It renders nothing until mounted, so the server render and the
 * first client render agree.
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
            // tiles, so its width follows the font size, and nine tiles at the
            // desktop size are wider than a 390px phone.
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
 * The hero.
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
 * The gradient on "finished video" is the `-ink` triple, never the decorative
 * one. `bg-clip-text` makes the gradient the text's actual colour, and the
 * decorative cyan measures 2.18:1 on the light ground — under even the 3:1
 * floor that large text gets. It is also static text rather than a per-word
 * animation: React Bits' BlurText was tried here, and a `bg-clip-text`
 * gradient across a line of individually transformed `inline-block` words
 * clips to glyphs that are mid-flight and ghosts badly. ParticleText was tried
 * after it and was worse — it draws the words into a canvas, so the most
 * important sentence on the page became a field of dots that could not be
 * selected, searched or read aloud, and did not survive being looked at.
 *
 * Named brands are plain text. No mark, no logo, no borrowed brand colour —
 * this domain is under a Safe Browsing review and that is exactly the signal
 * not to send.
 */
export function V2Hero() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden border-b">
      <HeroGround />

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
