"use client";

import ScrollExpand from "@/components/react-bits/ScrollExpand";

/**
 * The 16:9 master, opening to full bleed as you scroll past it.
 *
 * This is the band /v3 has that /v2 does not, and it is the one that suits a
 * video product best: the thing the software makes is a frame, and here the
 * frame is the page.
 *
 * What is inside it is drawn in CSS. It is not a screenshot and does not quote
 * a real video — the caption below says so, in the same words v1 and v2 use.
 * React Bits' ScrollExpand always renders an `<img src={src}>`, which with no
 * source is a broken image; the vendored copy takes a `mediaSlot` instead so
 * the drawn frame can go in the media layer. A mocked-up still of a video
 * nobody made would be a lie told in pictures, and this domain is under a
 * Safe Browsing review.
 *
 * `useWindowScroll` so it is driven by the page rather than by an inner
 * scroller — an inner scroller inside a long marketing page is a scroll trap
 * on a phone. Under `prefers-reduced-motion` the vendored copy pins the frame
 * fully open and attaches no listener at all.
 */

const FOOTAGE =
  "bg-gradient-to-br from-brand-violet/30 via-brand-blue/20 to-brand-cyan/30";

function DrawnFrame() {
  return (
    <div className={`relative h-full w-full ${FOOTAGE}`}>
      {/* Burned into the picture, not a subtitle track a player can switch
          off — so it is drawn inside the frame, the way the renderer does it. */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center px-4 pb-[6%]">
        <span className="bg-background/85 rounded px-3 py-1.5 text-center text-[clamp(0.6rem,1.6vw,1rem)] leading-tight font-semibold tracking-wide uppercase">
          it was a computer
        </span>
      </div>

      <span className="text-muted-foreground bg-background/60 absolute top-[4%] left-[3%] rounded px-2 py-1 font-mono text-[clamp(0.5rem,1.1vw,0.7rem)]">
        1920 × 1080
      </span>

      {/* The playhead. A still frame with a progress bar reads as a video
          paused, which is what this is a diagram of. */}
      <div aria-hidden="true" className="bg-foreground/15 absolute inset-x-0 bottom-0 h-[0.4%]">
        <div className="from-brand-violet to-brand-cyan h-full w-[38%] bg-gradient-to-r" />
      </div>
    </div>
  );
}

export function V3Expand() {
  return (
    <section id="output" aria-label="What a finished run produces" className="relative">
      <ScrollExpand
        mediaSlot={<DrawnFrame />}
        useWindowScroll
        startWidth={44}
        startHeight={52}
        startRadius={20}
        endRadius={0}
        scrollDistance={1.1}
        holdDistance={0.25}
        overlayScrim={0}
        className="h-auto"
      />

      <div className="mx-auto w-full max-w-6xl px-6 pb-20 sm:pb-28">
        <p className="text-muted-foreground font-mono text-[11px] tracking-[0.2em] uppercase">
          Output
        </p>
        <h2 className="mt-3 text-[1.75rem] leading-[1.12] font-semibold tracking-tight text-balance sm:text-4xl">
          One render,{" "}
          <span className="from-brand-violet-ink via-brand-blue-ink to-brand-cyan-ink bg-gradient-to-r bg-clip-text text-transparent">
            three things to publish
          </span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl text-base text-pretty sm:text-lg">
          A 1920 × 1080 master with narration, footage matched to every line, a
          music bed, sound effects, Ken Burns motion and captions burned into
          the frame. The vertical Shorts you choose to cut from it, reframed and
          re-captioned from that same render. And the listing — title,
          description, tags and thumbnail — written from the same script and
          uploaded with it.
        </p>
        <p className="text-muted-foreground mt-6 text-xs">
          Illustration, not a screenshot. The caption and topic shown are an
          example.
        </p>
      </div>
    </section>
  );
}
