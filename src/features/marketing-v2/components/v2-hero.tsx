"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowRight, Hand } from "lucide-react";

import Aurora from "@/components/react-bits/Aurora";
import BlurText from "@/components/react-bits/BlurText";
import RotatingText from "@/components/react-bits/RotatingText";
import StarBorder from "@/components/react-bits/StarBorder";
import { Button } from "@/components/ui/button";

/**
 * The sRGB equivalents of the marketing palette's three hues, per theme.
 *
 * React Bits' Aurora is a WebGL shader: it takes hex strings and feeds them to
 * `vec3` uniforms, so it cannot read `--brand-violet` and friends, which are
 * `oklch()` custom properties. These are those exact tokens converted to sRGB.
 * If globals.css changes a hue, change it here too — there is no way for the
 * shader to follow it on its own, and that is a real cost of putting a WebGL
 * background inside a design system built on CSS variables.
 *
 * Decorative stops rather than `-ink`: nothing here is text, and this is the
 * one place on the page where the hue is purely decoration.
 */
const AURORA_STOPS = {
  // oklch(0.55 0.2 285) / oklch(0.62 0.17 250) / oklch(0.74 0.13 205)
  light: ["#6b55df", "#1289e7", "#00c2d2"],
  // oklch(0.68 0.18 285) / oklch(0.7 0.15 250) / oklch(0.8 0.12 205)
  dark: ["#9083ff", "#4ba3f7", "#44d4e2"],
} as const;

/**
 * The nouns a finished run actually produces, in the order the pipeline makes
 * them. Every one of these is a real artefact — nothing here is a feature that
 * has not been built.
 */
const ARTEFACTS = [
  "a sourced script",
  "narration in your voice",
  "footage per line",
  "burned-in captions",
  "a music bed",
  "a thumbnail and metadata",
  "a published video",
];

/**
 * The aurora, or nothing.
 *
 *  1. It is a continuous `requestAnimationFrame` loop with no internal way to
 *     stop, so anyone who has asked their OS for reduced motion gets the flat
 *     gradient underneath and no WebGL context at all.
 *  2. Its colours have to be chosen from the resolved theme, and `next-themes`
 *     only knows that on the client — so it waits for mount rather than
 *     guessing and then flipping.
 *  3. It is decoration. Nothing in the hero's meaning is inside it.
 */
function HeroAurora() {
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
      // the thing that puts a horizontal scrollbar on a 390px phone.
      //
      // Masked to the top and held at 45% on the light theme. Left at full
      // strength this shader is a saturated field across the whole frame, and
      // the paragraph under the headline measured as pale grey text sitting on
      // teal — the aurora has to be a sky above the words, not a ground behind
      // them. The dark theme can carry more of it because the type there is
      // near-white and gains contrast from the wash rather than losing it.
      className="absolute inset-0 -z-10 opacity-45 [mask-image:radial-gradient(120%_75%_at_50%_-10%,black_0%,transparent_72%)] dark:opacity-70"
    >
      <Aurora
        colorStops={[...AURORA_STOPS[resolvedTheme === "dark" ? "dark" : "light"]]}
        amplitude={0.9}
        blend={0.5}
        speed={0.4}
      />
    </div>
  );
}

/**
 * v2's hero, and the biggest single departure from v1.
 *
 * v1 opens with a centred masthead inside a bordered section: badge, headline,
 * a five-line paragraph, a bordered box, two buttons. It reads like the top of
 * a document. This one is a full-height opening frame — the aurora runs the
 * whole width and off the bottom edge, and the sentence completes itself in
 * front of you rather than sitting there finished.
 *
 * Two things it is not allowed to lose, both carried over from v1 and both
 * documented there:
 *
 *  - The approval-gate claim. It is the most trust-building true thing this
 *    product can say and the main line between it and "an AI posts to my
 *    channel unsupervised". Here it is a bordered strip *below* the buttons
 *    rather than above them — v1 has to reorder it with `order-last` on a
 *    phone for the same reason, and putting it after them in source order gets
 *    there without a CSS rule.
 *  - Both calls to action above the fold at 390px. The lead is one short
 *    sentence rather than v1's five-line one; the full pipeline sentence is
 *    further down, in the band that is about the pipeline.
 *
 * Named brands are plain text. No mark, no logo, no borrowed brand colour —
 * this domain is under a Safe Browsing review and that is exactly the signal
 * not to send.
 */
export function V2Hero() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden">
      <HeroAurora />
      {/* Always painted, aurora or not: this is the ground the hero stands on
          and it is what a reduced-motion visitor sees instead. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/14 via-brand-blue/6 absolute inset-0 -z-20 bg-gradient-to-b to-transparent"
      />
      {/* The band the page continues into, so the hero has no hard edge. */}
      <div
        aria-hidden="true"
        className="to-background absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent"
      />

      <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-24">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        {/* React Bits' BlurText, rendering the real `<h1>` rather than its
            default `<p>`. The brand gradient is not on it and cannot be:
            BlurText wraps every word in a transformed `inline-block`, and a
            `bg-clip-text` gradient across a line of those clips to glyphs that
            are mid-flight. It moves to the rotating line below instead. */}
        <BlurText
          as="h1"
          text="Type a topic."
          animateBy="words"
          direction="top"
          delay={130}
          stepDuration={0.3}
          className="mt-6 text-[2.25rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl"
        />

        {/* The second line of the headline is the product's output list,
            rotating. It is the same claim v1 makes in a seven-clause
            paragraph, made one noun at a time — and every noun is an artefact
            a finished run really leaves behind.
            `min-h` and `justify-center` because the phrases are different
            lengths and a line that re-flows the page every two seconds is
            worse than no animation at all. */}
        <p className="mt-2 flex min-h-[2.6rem] items-center justify-center text-[1.75rem] leading-[1.05] font-semibold tracking-tight sm:mt-3 sm:min-h-[4rem] sm:text-5xl lg:min-h-[5rem] lg:text-6xl">
          {/* A non-breaking space rather than a margin. This `<p>` is a flex
              container, and a flex container drops whitespace-only text nodes
              between its items — so a plain space would vanish from the
              accessible name and a screen reader would read "Geta sourced
              script". The nbsp lives inside the span, where it survives. */}
          <span className="text-muted-foreground">Get&nbsp;</span>
          <RotatingText
            texts={ARTEFACTS}
            rotationInterval={2200}
            staggerDuration={0.012}
            staggerFrom="first"
            splitBy="characters"
            mainClassName="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent justify-center"
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
          />
        </p>

        <p className="text-muted-foreground mt-6 max-w-xl text-base text-pretty sm:text-lg">
          No writing, no recording, no editing — and nothing reaches your
          channel that you have not watched first.
        </p>

        {/* React Bits' StarBorder around the primary action. v1 puts a static
            blurred halo behind this button; this is a light that travels round
            its edge instead. The button inside is untouched — same
            `--primary`, same `size="lg"`, so it still grows to the 44px touch
            floor under `pointer-coarse`. */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
