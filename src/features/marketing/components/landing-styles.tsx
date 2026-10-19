"use client";

import { useEffect, useRef } from "react";

import { ART_STYLES } from "@/lib/art-styles";
import { cn } from "@/lib/utils";

/**
 * Every look, shown with something it really made. The animated looks are
 * 6-second clips cut from real finished videos (public/looks); the
 * illustration styles are the app's own style samples (public/art-styles).
 * Nothing here is a mock-up.
 *
 * The animated looks are built in the studio and still being moved into
 * Framecast Studio, so they say "Coming soon" until they can be ordered.
 */
const LOOKS = [
  { id: "motion", name: "Motion graphics", line: "Full-frame pictures, animated numbers and captions.", from: "Money Mechanics" },
  { id: "whiteboard", name: "Whiteboard", line: "A hand draws each picture and writes the key words.", from: "Money Mechanics" },
  { id: "explainer", name: "Explainer", line: "Each scene as an app screen on a phone, with karaoke captions.", from: "Money Mechanics" },
  { id: "mixed", name: "Mixed", line: "Each scene picks its look: drawing for ideas, screens for steps.", from: "Dev Pixel" },
  { id: "versus", name: "Versus", line: "Two products face off: spec tables, winners and a live score.", from: "Haleem Rafat" },
  { id: "arena", name: "Arena", line: "Versus as a fighting game: health bars, rounds and a winner.", from: "Haleem Rafat" },
  { id: "deepdive", name: "Deep dive", line: "A researched explainer with real photos, chip maps and tables.", from: "Haleem Rafat" },
] as const;

/** Plays while on screen, pauses off it, and never moves for reduced motion. */
function Clip({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      ([entry]) => (entry?.isIntersecting ? void video.play().catch(() => {}) : video.pause()),
      { threshold: 0.4 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      src={`/looks/${id}.mp4`}
      poster={`/looks/${id}.jpg`}
      muted
      loop
      playsInline
      preload="none"
      aria-label={`A real ${name} video, playing without sound`}
      className="aspect-[9/16] w-full rounded-lg bg-black object-cover"
    />
  );
}

export function LandingStyles() {
  return (
    <section id="styles" className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
      <div className="max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Pick a look. These are real videos.
        </h2>
        <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
          Every clip below was cut from a finished video, not designed for this page. Choose the
          look once for a channel or a series, and every video after that is made in it.
        </p>
      </div>

      <h3 className="mt-12 text-lg font-semibold">Animated looks</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Moving into Framecast Studio now. Each works as a Short or a long video.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {LOOKS.map((look) => (
          <li key={look.id} className="flex min-w-0 flex-col gap-2">
            <Clip id={look.id} name={look.name} />
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{look.name}</span>
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px]">
                Coming soon
              </span>
            </div>
            <p className="text-muted-foreground text-sm text-pretty">{look.line}</p>
            <p className="text-muted-foreground/80 text-xs">From {look.from}</p>
          </li>
        ))}
        <li className="flex min-w-0 flex-col gap-2">
          <div className="border-border text-muted-foreground flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm">
            Marketing example coming soon
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Marketing</span>
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px]">
              Coming soon
            </span>
          </div>
          <p className="text-muted-foreground text-sm text-pretty">
            Paste a brand&apos;s website, answer a few questions, get a branded ad for social.
          </p>
        </li>
      </ul>

      <h3 className="mt-16 text-lg font-semibold">Illustration styles</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Available now for illustrated channels: the same scene drawn in each style.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {ART_STYLES.map((style) => (
          <li key={style.id} className="min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static samples, already sized */}
            <img
              src={`/art-styles/${style.id}.webp`}
              alt={`${style.name}: the sample scene drawn in this style`}
              loading="lazy"
              className={cn("aspect-square w-full rounded-lg object-cover")}
            />
            <p className="mt-2 text-sm font-medium">{style.name}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
