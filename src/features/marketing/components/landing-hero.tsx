"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Hand } from "lucide-react";
import { useTheme } from "next-themes";

import StarBorder from "@/components/react-bits/StarBorder";
import TextCursor from "@/components/react-bits/TextCursor";
import { Button } from "@/components/ui/button";
import { useAmbientEffectsAllowed } from "@/hooks/use-ambient-effects-allowed";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * Both WebGL pieces are loaded on demand rather than imported outright,
 * because they drag `ogl` in behind them. Neither mounts on a phone or under
 * reduced motion, and a static import would have shipped the library to those
 * visitors anyway, to sit in the bundle unused. They share the one chunk.
 */
const LightTunnel = dynamic(
  () => import("@/components/react-bits/LightTunnel"),
  { ssr: false },
);

const WarpText = dynamic(() => import("@/components/react-bits/WarpText"), {
  ssr: false,
});

/**
 * React Bits' TextCursor, over the hero's title area.
 *
 * It trails small copies of a word behind the pointer as it crosses the
 * heading. Everything it draws is absolutely positioned inside this box, so it
 * cannot move the headline, the buttons or anything else — which matters,
 * because the mobile work on this page exists to keep both calls to action
 * above the fold at 390px.
 *
 * It is decoration and is marked as such. The `<h1>` below it is a real
 * heading with the real sentence in it; this layer is `aria-hidden` and adds
 * no text to the accessible tree. The word it trails is "topic", which is the
 * thing the visitor is about to type — the same idea the headline states.
 *
 * Not mounted at all under reduced motion or on a coarse pointer; see
 * `useAmbientEffectsAllowed`, which the tunnel behind it is gated on too.
 */
function TitleCursorTrail() {
  const enabled = useAmbientEffectsAllowed();

  if (!enabled) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 text-[0.7rem] font-medium tracking-[0.2em] uppercase opacity-45"
    >
      <TextCursor
        text="topic"
        spacing={64}
        followMouseDirection
        randomFloat={false}
        exitDuration={0.5}
        removalInterval={40}
        maxPoints={10}
      />
    </div>
  );
}

/**
 * The wash the hero stands on, drawn in CSS and always painted.
 *
 * This layer exists whether or not the tunnel above it does, and it is the
 * reason the hero still looks finished on a phone, under reduced motion, and
 * in the moment before the WebGL chunk arrives. It costs one composite, needs
 * no dependency, and follows the theme through the tokens directly rather than
 * through a hand-copied palette.
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
 * React Bits' LightTunnel, behind the hero.
 *
 * A radial field of fibre-optic cables running away into the centre, with
 * pulses racing along them. `flowDirection="outward"` sends the pulses towards
 * the viewer, which reads as arrival rather than departure — the right verb for
 * a page whose promise is that something comes back finished.
 *
 * Four things about this component are load-bearing and should survive edits:
 *
 *  - **It is not mounted at all on a phone or under reduced motion.** Not
 *    paused — absent, along with its WebGL context and, because of the
 *    `dynamic()` above, its download. See `useAmbientEffectsAllowed`.
 *  - **It reads the brand tokens off its own host, not off `:root`.** The
 *    shader binds sRGB to uniforms and cannot resolve a CSS variable itself, so
 *    the ramp is read here and handed over. It used to be a hand-maintained
 *    copy of the *dark* theme's hexes, dimmed on light — which is why the light
 *    theme looked wrong: violet tuned for near-black was being laid on white.
 *
 *    The token lookup has one trap, and it is the reason the copy existed.
 *    These tokens are scoped to `.marketing` (`globals.css`), not to `:root` —
 *    `.marketing` carries the light ramp and `.dark .marketing` the lighter
 *    one. Reading them from `document.documentElement` returns the empty
 *    string, so the read MUST happen on an element inside the marketing scope;
 *    the host div below is one, which is why it renders before the canvas does.
 *    Custom properties inherit, so any descendant would do.
 *
 *    Violet cables carrying cyan pulses is the headline's own gradient, moving.
 *    (`tunnelColor` is inert while `tunnelOpacity` is 0 — the shader multiplies
 *    the two — but it is passed for the day someone raises the opacity.)
 *  - **The middle is masked out.** This is the contrast fix, and it is the
 *    reason an animated background is survivable here at all. An earlier
 *    attempt in this slot put a saturated field across the whole frame and the
 *    lead paragraph measured as grey text on teal. The radial mask keeps the
 *    canvas away from the column the type occupies, so the cables read as a
 *    rim of light around the content rather than a wash under it; the light
 *    theme is dimmed further, because dark violet on white is a far harder
 *    ground for `text-muted-foreground` than the same violet on near-black.
 *
 *    The horizontal radius is `48rem` — a length, not a percentage — and that
 *    is deliberate. A percentage scales the hole with the viewport, so it
 *    shrinks exactly when it is needed most: the text column stays about as
 *    wide as it was while the clear area closes in around it. Measured in a
 *    browser, a 75%-wide hole let the cables back under the lead paragraph at
 *    390px and it fell to 2.2:1 on the dark theme. Pinned to a length a little
 *    wider than the `max-w-xl` the prose sits in, the hole stops tracking the
 *    viewport: on a narrow window it covers the whole frame and the tunnel
 *    simply fades out, and it only opens into a visible rim once the window is
 *    wider than the text. The vertical radius stays a percentage because the
 *    hero's height is what it needs to track.
 *  - **It is decorative.** `aria-hidden`, no text, and it sits at `-z-10`
 *    inside the section's own stacking context, so it can neither reorder nor
 *    displace anything. Nothing here participates in layout.
 *
 * Pointer events are deliberately *not* disabled. `mouseStrength` is small
 * enough to read as parallax rather than as a toy, and the canvas is behind
 * everything, so it only ever sees the pointer where no content is — the
 * headline stays selectable and the buttons stay clickable.
 */
/**
 * The ramp the shader is given, resolved from the marketing scope's tokens.
 *
 * Falls back to the dark theme's hexes only if a token is missing entirely —
 * `toCanvasColor` cannot report failure (an unparseable `fillStyle` is silently
 * ignored, leaving opaque black), so an empty token has to be caught before it
 * gets there rather than after.
 */
interface TunnelRamp {
  cable: string;
  pulse: string;
  tunnel: string;
}

const TUNNEL_FALLBACK: TunnelRamp = {
  cable: "#9083FF",
  pulse: "#44D4E2",
  tunnel: "#6B55DF",
};

function HeroTunnel() {
  const enabled = useAmbientEffectsAllowed();
  const hostRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const [ramp, setRamp] = useState<TunnelRamp | null>(null);

  useEffect(() => {
    if (!enabled || !hostRef.current) return;

    const styles = window.getComputedStyle(hostRef.current);
    const read = (token: string, fallback: string) => {
      const raw = styles.getPropertyValue(token).trim();
      return raw ? toCanvasColor(raw) : fallback;
    };

    setRamp({
      cable: read("--brand-violet", TUNNEL_FALLBACK.cable),
      pulse: read("--brand-cyan", TUNNEL_FALLBACK.pulse),
      tunnel: read("--brand-blue", TUNNEL_FALLBACK.tunnel),
    });
  }, [enabled, resolvedTheme]);

  if (!enabled) return null;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(48rem_60%_at_50%_45%,transparent_0%,transparent_45%,black_100%)] dark:opacity-75"
    >
      {ramp ? (
        <LightTunnel
          cableColor={ramp.cable}
          pulseColor={ramp.pulse}
          tunnelColor={ramp.tunnel}
          tunnelOpacity={0}
          speed={0.1}
          flowDirection="outward"
          pulseSpeed={2}
          pulseLength={0.28}
          cableCount={20}
          thickness={0.35}
          rimWidth={0.15}
          waviness={0.3}
          sway={0.5}
          glow={1}
          grain
          grainIntensity={0.03}
          mouseInteraction
          mouseStrength={0.1}
        />
      ) : null}
    </div>
  );
}

/**
 * Put a CSS colour through a 1×1 canvas and read back what landed, as
 * `rgb(r, g, b)`.
 *
 * This exists because of a trap. The brand tokens are `oklch()`, and Chromium
 * resolves `getComputedStyle().color` on them to a *`lab()`* string — not
 * `rgb()`. Handing that straight to a 2D context's `fillStyle` works in a
 * browser new enough to parse `lab()` and silently does nothing in one that is
 * not: `fillStyle` rejects values it cannot parse without throwing, leaving
 * whatever was set before, which for a fresh context is opaque black. The
 * failure mode is therefore a black headline on the dark theme — invisible,
 * and only on the browsers that are hardest to notice it on.
 *
 * The same assignment happens here, where a wrong answer is harmless, and the
 * result is read back as bytes. Whatever the browser understood, it now says
 * in the one syntax every canvas has understood since canvas existed.
 */
function toCanvasColor(color: string): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

  // Hex, not `rgb()`, and the difference is the whole hero.
  //
  // Both consumers take this string, but they do not parse alike. `WarpText`
  // hands it to a 2D context's `fillStyle`, which understands either. The
  // shader does not: `LightTunnel`'s `hexToRgb` matches an anchored hex-only
  // pattern and returns [1, 1, 1] — pure WHITE — for anything else, without
  // throwing. An `rgb()` string therefore painted white cables on both themes:
  // invisible on light at `opacity-40`, and a hot desaturated wash on dark.
  //
  // Two failure modes that cannot report themselves, on either side of one
  // function, so the safe output is the narrower syntax that both accept.
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The hero's headline, and — on a big enough screen — React Bits' WarpText
 * drawn over it.
 *
 * The `<h1>` is always here, always a real `<h1>`, always containing the real
 * sentence, and it is always what defines the height of this block. That last
 * point is the whole trick: the canvas is laid over the heading rather than
 * put in place of it, so it cannot change the box, and the buttons below
 * cannot move. There is no state in which this component reflows.
 *
 * WarpText rasterises text into a canvas, and this repo has been here before —
 * ParticleText was pulled from this exact line because it turned the most
 * important sentence on the page into pixels that could not be selected,
 * searched or read aloud. So the canvas is a *skin*, not a replacement:
 *
 *  - The heading keeps its text. It goes to `opacity-0` under the canvas,
 *    which hides it from the eye and from nothing else — it stays in the
 *    accessible tree, stays selectable, stays in the HTML a crawler sees.
 *    (`visibility: hidden` or `display: none` would have taken it out of the
 *    accessible tree, which is why neither is used.)
 *  - The canvas is `aria-hidden`, so the sentence is announced once.
 *  - Server-rendered HTML never has the canvas in it. Both gates below are
 *    false until hydration, so the first paint, every crawler and every
 *    reader-mode pass get the plain gradient heading.
 *
 * Two gates, and both have to open:
 *
 *  - `useAmbientEffectsAllowed` — no canvas under reduced motion, none on a
 *    touchscreen. WarpText freezes its own clock under reduced motion, which
 *    is not enough: a frozen canvas is still a WebGL context and still a
 *    download.
 *  - `lg` and up. This one is not taste. WarpText does not wrap text — it
 *    splits on `\n` and scales whatever it gets down to fit the box — so a
 *    narrow window would shrink the whole headline to a strip. Above `lg` the
 *    heading sets in two lines, so the canvas is given those two lines
 *    explicitly and matches.
 *
 * What this costs, and it is a real cost: the `-ink` gradient on "finished
 * video" cannot survive the trip. The canvas rasterises with a single
 * `fillStyle`, so a `bg-clip-text` gradient has nowhere to go. Above `lg` with
 * motion on, the headline is one flat foreground colour. Everywhere else —
 * every phone, every reduced-motion visitor, every narrow window, and the
 * server HTML — the gradient is exactly as it was.
 *
 * The colour is read off the live heading rather than hard-coded, so it
 * follows the theme through the tokens instead of through a second
 * hand-maintained copy of the palette. `getComputedStyle().color` resolves the
 * `oklch()` token to an `rgb()` string, which is something a 2D canvas
 * `fillStyle` understands.
 */
function HeroHeadline() {
  const ambient = useAmbientEffectsAllowed();
  const roomToSet = useMediaQuery("(min-width: 64rem)");
  const warped = ambient && roomToSet;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const { resolvedTheme } = useTheme();
  const [ink, setInk] = useState<string | null>(null);

  useEffect(() => {
    if (!warped || !headingRef.current) return;
    setInk(toCanvasColor(window.getComputedStyle(headingRef.current).color));
  }, [warped, resolvedTheme]);

  return (
    <div className="relative">
      <h1
        ref={headingRef}
        className={cn(
          "text-[2.25rem] leading-[1.06] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl",
          warped && ink && "opacity-0",
        )}
      >
        Type a topic. Get a{" "}
        <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
          finished video
        </span>
        .
      </h1>

      {warped && ink ? (
        <div aria-hidden="true" className="absolute inset-0">
          <WarpText
            text={"Type a topic.\nGet a finished video."}
            color={ink}
            fontSize="4.5rem"
            fontWeight={600}
            letterSpacing="-0.025em"
            lineHeight={1.06}
            warpStrength={0.08}
            warpScale={1.7}
            speed={0.55}
            pointerInfluence={0.42}
            pointerStrength={0.38}
            refraction={0.018}
            ripple
            className="h-full"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The landing hero.
 *
 * Lives in the shared marketing feature rather than beside a set of numbered
 * variants because there are none left: `/` is the only landing page, and this
 * is its hero.
 *
 * Three layers, back to front: `HeroGround` (CSS, always painted),
 * `HeroTunnel` (WebGL, desktop and full-motion only), then the content below.
 * Only the third is in the accessible tree.
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
export function LandingHero() {
  return (
    <section className="relative isolate flex min-h-svh flex-col justify-center overflow-hidden border-b">
      <HeroGround />
      <HeroTunnel />

      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-24 pb-14 text-center sm:pt-32 sm:pb-24">
        <p className="text-muted-foreground bg-background/60 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs backdrop-blur-sm">
          <span className="from-brand-violet to-brand-cyan size-1.5 rounded-full bg-gradient-to-r" />
          Self-hosted video production. Free while in beta.
        </p>

        {/* `relative isolate` so the trail is clipped to the title block and
            sits behind the type rather than over it. */}
        <div className="relative isolate mt-6 w-full">
          <TitleCursorTrail />
          <HeroHeadline />
        </div>

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
