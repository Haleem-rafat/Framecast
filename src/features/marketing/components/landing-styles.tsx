"use client";

import { useState } from "react";

import FlexCarousel from "@/components/react-bits/FlexCarousel";
import { StylePreview } from "@/components/shared/style-preview";
import { ART_STYLES } from "@/lib/art-styles";
import { FOOTAGE_STYLES } from "@/lib/footage-styles";
import { cn } from "@/lib/utils";

interface LandingStyle {
  key: string;
  name: string;
  line: string;
  bestFor: string;
  /** File under public/looks: a real 6-second clip and its still. */
  preview: string;
  available: boolean;
}

/**
 * Every look, shown with something it really made. The animated looks are
 * 6-second clips cut from real finished videos; the footage styles from real
 * channel uploads and from sample renders made by the app itself. Nothing
 * here is a mock-up.
 *
 * The animated looks are built in the studio and still being moved into
 * Framecast Studio, so they say "Coming soon" until they can be ordered.
 */
const ANIMATED: LandingStyle[] = [
  { key: "motion", name: "Motion graphics", line: "Full-frame pictures, animated numbers and captions.", bestFor: "Finance and history Shorts", preview: "motion", available: false },
  { key: "whiteboard", name: "Whiteboard", line: "A hand draws each picture and writes the key words.", bestFor: "Lessons and book summaries", preview: "whiteboard", available: false },
  { key: "explainer", name: "Explainer", line: "Each scene as an app screen on a phone, with karaoke captions.", bestFor: "How-tos and step-by-step tips", preview: "explainer", available: false },
  { key: "mixed-look", name: "Studio mix", line: "Each scene picks its look: drawing for ideas, screens for steps.", bestFor: "Developer and tech explainers", preview: "mixed", available: false },
  { key: "versus", name: "Versus", line: "Two products face off: spec tables, winners and a live score.", bestFor: "Tech comparisons", preview: "versus", available: false },
  { key: "arena", name: "Arena", line: "Versus as a fighting game: health bars, rounds and a winner.", bestFor: "Exciting product battles", preview: "arena", available: false },
  { key: "deepdive", name: "Deep dive", line: "A researched explainer with real photos, chip maps and tables.", bestFor: "Long reviews and explainers", preview: "deepdive", available: false },
];

const FOOTAGE: LandingStyle[] = FOOTAGE_STYLES.flatMap((style) =>
  style.preview
    ? [{ key: style.value, name: style.label, line: style.summary, bestFor: style.bestFor, preview: style.preview, available: true }]
    : [],
);

/** Available styles first: they are what can be made today. */
const STYLES = [...FOOTAGE, ...ANIMATED];

const ITEMS = STYLES.map((style) => ({
  src: `/looks/${style.preview}.jpg`,
  alt: `${style.name}: a still from a real video`,
  title: style.name,
  subtitle: style.available ? "Available now" : "Coming soon",
}));

export function LandingStyles() {
  const [active, setActive] = useState(0);
  const style = STYLES[active] ?? STYLES[0]!;

  return (
    <section id="styles" className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
      <div className="max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Pick a look. These are real videos.
        </h2>
        <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
          Every picture and clip below comes from a finished video, not from a design file. Drag
          through them; the one in the middle plays beside them.
        </p>
      </div>

      <div className="mt-10 grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="h-[420px] sm:h-[520px]">
          <FlexCarousel
            items={ITEMS}
            preset="liquid"
            intro="rise"
            cardHeight={0.62}
            gap={14}
            radius={14}
            fit="portrait"
            squeeze={0.2}
            focusOnClick={false}
            captions
            onChange={(index: number) => setActive(index)}
          />
        </div>

        <aside aria-live="polite" className="mx-auto w-full max-w-[280px]">
          <StylePreview key={style.key} name={style.preview} label={`A real ${style.name} video, playing without sound`} />
          <div className="mt-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold">{style.name}</h3>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                style.available ? "bg-brand-cyan/20 text-brand-cyan-ink" : "bg-muted text-muted-foreground",
              )}
            >
              {style.available ? "Available now" : "Coming soon"}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm text-pretty">{style.line}</p>
          <p className="text-muted-foreground/80 mt-1 text-xs">Best for: {style.bestFor}</p>
        </aside>
      </div>

      {/* The same list as buttons: for keyboards, for anyone without WebGL
        * (where the carousel draws nothing), and to jump straight to one. */}
      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Choose a style to preview">
        {STYLES.map((one, index) => (
          <button
            key={one.key}
            type="button"
            onClick={() => setActive(index)}
            aria-pressed={index === active}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              index === active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {one.name}
          </button>
        ))}
      </div>

      <h3 className="mt-16 text-lg font-semibold">Illustration styles</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        For illustrated channels: the same scene drawn in each style.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {ART_STYLES.map((art) => (
          <li key={art.id} className="min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static samples, already sized */}
            <img
              src={`/art-styles/${art.id}.webp`}
              alt={`${art.name}: the sample scene drawn in this style`}
              loading="lazy"
              className="aspect-square w-full rounded-lg object-cover"
            />
            <p className="mt-2 text-sm font-medium">{art.name}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
