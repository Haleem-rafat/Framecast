"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Hand } from "lucide-react";

import Galaxy from "@/components/react-bits/Galaxy";
import StarBorder from "@/components/react-bits/StarBorder";
import { Button } from "@/components/ui/button";

/**
 * The star field behind the hero, or nothing.
 *
 * React Bits' Galaxy: a procedural shader that drifts, twinkles and parts
 * around the pointer. It is the one WebGL background in the library that does
 * not need a hand-maintained sRGB copy of the brand palette — its colour comes
 * from a `hueShift` on a generated field rather than from props bound to the
 * tokens — so there is nothing here to keep in step with globals.css.
 *
 * Not mounted at all under `prefers-reduced-motion`. Galaxy does expose a
 * `disableAnimation` prop, but that only freezes the stars: the WebGL context,
 * the compiled shader and the render loop all still exist, and there is no
 * reason to pay for any of that for a visitor who has asked for less movement.
 * The gradient wash underneath is always painted, so the hero has a ground
 * either way and nothing about its meaning is inside the canvas.
 *
 * `transparent` so the page's own background shows through and the type keeps
 * its contrast; held well under half opacity for the same reason, because a
 * star field at full strength behind a paragraph is a paragraph on a texture.
 */
function HeroGalaxy() {
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
      // the thing that puts a horizontal scrollbar on a 390px phone. Masked
      // outward from the centre so the stars thin out behind the headline.
      className="absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(120%_100%_at_50%_50%,transparent_0%,black_55%)] dark:opacity-70"
    >
      <Galaxy
        transparent
        density={0.7}
        starSpeed={0.16}
        speed={0.6}
        glowIntensity={0.25}
        saturation={0.55}
        hueShift={252}
        twinkleIntensity={0.25}
        rotationSpeed={0.03}
        mouseInteraction
        mouseRepulsion={false}
        repulsionStrength={1.4}
      />
    </div>
  );
}

/**
 * The wash the hero stands on, drawn in CSS and always painted — with the star
 * field, without it, and for anyone whose JavaScript never runs.
 */
function HeroGround() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-20">
      <div className="from-brand-violet/12 via-brand-blue/5 absolute inset-0 bg-gradient-to-b to-transparent" />
      {/* A soft pool of light behind the headline, so the type has something
          to sit in rather than floating on a flat field. */}
      <div className="bg-[radial-gradient(60%_45%_at_50%_28%,var(--brand-violet)_0%,transparent_70%)] absolute inset-0 opacity-[0.10] dark:opacity-[0.18]" />
    </div>
  );
}

/**
 * The landing hero.
 *
 * Lives in the shared marketing feature rather than beside the v2 sections
 * because both the landing page at `/` and the comparison page at `/v2` render
 * it — it is the one piece of v2 that has already graduated.
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
 * animation. Three of the library's text effects were tried on this line and
 * all three are gone. BlurText ghosts: a `bg-clip-text` gradient across a row
 * of individually transformed `inline-block` words clips to glyphs that are
 * mid-flight. RotatingText had the same fault for the same reason.
 * ParticleText was worse still — it draws into a canvas, so the most important
 * sentence on the page became a field of dots that could not be selected,
 * searched or read aloud.
 *
 * A split-flap board naming the seven artefacts a run produces sat under this
 * headline for a while and has been removed at the owner's request. The
 * artefacts are still listed, in plain text, in the marquee immediately below
 * the hero and again in the features band.
 *
 * Named brands are plain text. No mark, no logo, no borrowed brand colour —
 * this domain is under a Safe Browsing review and that is exactly the signal
 * not to send.
 */
export function LandingHeroGalaxy() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden border-b">
      <HeroGround />
      <HeroGalaxy />

      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-24 pb-14 text-center sm:pt-32 sm:pb-24">
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
                Create your first video
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
