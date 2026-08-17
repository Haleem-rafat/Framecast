"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowRight, Hand } from "lucide-react";

import GradientWaves from "@/components/react-bits/GradientWaves";
import ParticleText from "@/components/react-bits/ParticleText";
import StarBorder from "@/components/react-bits/StarBorder";
import { Button } from "@/components/ui/button";

/**
 * The marketing palette as sRGB hex, per theme.
 *
 * Both React Bits components here bind colours to a canvas or a shader
 * uniform, so neither can read `--brand-violet` and friends, which are
 * `oklch()` custom properties. These are those exact tokens converted. If
 * globals.css changes a hue, change it here too.
 */
const PALETTE = {
  light: {
    // oklch(0.55 0.2 285) / oklch(0.62 0.17 250) / oklch(0.74 0.13 205)
    violet: "#6b55df",
    blue: "#1289e7",
    cyan: "#00c2d2",
    // `--foreground` on the marketing light ground, for the particle glyphs.
    ink: "#26233a",
  },
  dark: {
    // oklch(0.68 0.18 285) / oklch(0.7 0.15 250) / oklch(0.8 0.12 205)
    violet: "#9083ff",
    blue: "#4ba3f7",
    cyan: "#44d4e2",
    ink: "#f3f2fa",
  },
} as const;

/** True when the visitor has not asked their OS for reduced motion. */
function useMotionAllowed() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAllowed(!query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return allowed;
}

/**
 * The raymarched wave field behind the hero, or nothing.
 *
 * Mounted only when motion is allowed and the theme has resolved, and masked
 * hard to the lower half. Left unmasked it is a saturated field across the
 * whole frame — the same failure Aurora had on /v2's first draft, where the
 * lead paragraph measured as grey text on teal. Here the waves roll along the
 * floor of the section and the type keeps the page's own background behind it.
 */
function HeroWaves() {
  const { resolvedTheme } = useTheme();
  const motionAllowed = useMotionAllowed();

  if (!motionAllowed) return null;

  const palette = PALETTE[resolvedTheme === "dark" ? "dark" : "light"];

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 -z-10 h-[62%] opacity-45 [mask-image:linear-gradient(to_top,black_15%,transparent_88%)] dark:opacity-65"
    >
      <GradientWaves
        horizonColor={palette.violet}
        waveColor={palette.blue}
        crestColor={palette.cyan}
        mouseInteraction={false}
      />
    </div>
  );
}

/**
 * The headline.
 *
 * ParticleText draws its words into a `<canvas>`: they are pixels, not glyphs.
 * They cannot be selected, searched, translated or read aloud, and a crawler
 * that does not run JavaScript sees an empty box — which on the one `<h1>` of
 * a page whose whole job is to be readable by Google's OAuth reviewers and a
 * Safe Browsing crawler would be indefensible.
 *
 * So the real `<h1>` is always in the markup and always the thing the machine
 * reads. When motion is allowed it is clipped to the accessible-name layer and
 * the canvas is painted over it, `aria-hidden`; otherwise the heading simply
 * shows, with the brand gradient on it exactly as v1 and v2 do it. Nothing is
 * ever said only inside the canvas.
 *
 * The gradient uses the `-ink` stops. `bg-clip-text` makes the gradient the
 * text's actual colour, and the decorative cyan measures 2.18:1 on the light
 * ground — under even the 3:1 floor large text gets.
 */
const HEADLINE = "Type a topic. Get a finished video.";

function Headline() {
  const { resolvedTheme } = useTheme();
  const motionAllowed = useMotionAllowed();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const particles = mounted && motionAllowed;
  const palette = PALETTE[resolvedTheme === "dark" ? "dark" : "light"];

  return (
    <div className="relative mt-6 w-full">
      <h1
        className={
          particles
            ? "sr-only"
            : "text-[2.25rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl"
        }
      >
        {particles ? (
          HEADLINE
        ) : (
          <>
            Type a topic. Get a{" "}
            <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
              finished video
            </span>
            .
          </>
        )}
      </h1>

      {particles ? (
        <div aria-hidden="true" className="h-[9rem] w-full sm:h-[13rem] lg:h-[15rem]">
          <ParticleText
            text={HEADLINE}
            color={palette.ink}
            highlightColor={palette.violet}
            // A string, so the canvas measures its own type against the box
            // rather than being handed a desktop pixel size that overflows a
            // 390px phone.
            fontSize="clamp(2.25rem, 7.5vw, 4.5rem)"
            fontWeight={600}
            density={2.4}
            particleSize={1.6}
            scatter={140}
            gatherDuration={1500}
            pointerRepel={26}
            repelRadius={90}
            trigger="mount"
            className="h-full w-full"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * v3's hero: the /v2 layout and copy, wearing the two components asked for.
 *
 * Two things it is not allowed to lose, both carried over from v1 and both
 * documented there:
 *
 *  - The approval-gate claim, which is the most trust-building true thing this
 *    product can say and the main line between it and "an AI posts to my
 *    channel unsupervised". It sits below the buttons, in plain text.
 *  - Both calls to action above the fold at 390px.
 *
 * Named brands are plain text. No mark, no logo, no borrowed brand colour —
 * this domain is under a Safe Browsing review and that is exactly the signal
 * not to send.
 */
export function V3Hero() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden">
      <HeroWaves />
      {/* Always painted, waves or not: the ground the hero stands on, and what
          a reduced-motion visitor sees instead. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/12 via-brand-blue/5 absolute inset-0 -z-20 bg-gradient-to-b to-transparent"
      />

      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-24">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        <Headline />

        <p className="text-muted-foreground mt-5 max-w-xl text-base text-pretty sm:text-lg">
          No writing, no recording, no editing — and nothing reaches your
          channel that you have not watched first.
        </p>

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
