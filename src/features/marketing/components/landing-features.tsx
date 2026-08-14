import type { ReactNode } from "react";
import {
  AudioLines,
  Captions,
  Coins,
  Crop,
  FileSearch,
  Music4,
  ServerCog,
  SlidersHorizontal,
  MonitorPlay,
} from "lucide-react";

import { BentoGrid, BentoGridItem } from "@/components/ui/bento-grid";

/**
 * A pure-CSS visual for each tile. No canvas, no per-frame work: the only
 * movement is a colour or transform transition on hover, which costs nothing
 * until a pointer is actually over the tile.
 */
function Tile({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`from-brand-violet/15 via-brand-blue/10 to-brand-cyan/15 relative flex min-h-24 flex-1 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

/** Waveform bars, for the narration tile. */
const BAR_HEIGHTS = [30, 62, 44, 88, 56, 100, 40, 72, 34, 84, 48, 66, 28];

const FEATURES = [
  {
    icon: <SlidersHorizontal className="text-brand-violet size-5" />,
    title: "Prompt templates you own",
    description:
      "The template that shapes every script is a document you write and edit. The model works inside it.",
    className: "md:col-span-2",
    header: (
      <Tile className="items-start p-4">
        <div className="w-full space-y-2 font-mono text-[10px] sm:text-[11px]">
          <p className="text-muted-foreground">You are writing a {"{{style}}"} script about {"{{topic}}"}.</p>
          <p className="text-muted-foreground">Open on a concrete image, never a definition.</p>
          <p className="text-brand-violet">Cite a source for every claim you make.</p>
        </div>
      </Tile>
    ),
  },
  {
    icon: <FileSearch className="text-brand-blue size-5" />,
    title: "Sourced scripts",
    description: "Claims come back with citations, so you can check them before you approve.",
    header: (
      <Tile>
        <div className="space-y-1.5">
          {[100, 78, 92, 60].map((w, i) => (
            <div
              key={w}
              className={`h-1.5 rounded-full ${i === 3 ? "bg-brand-blue" : "bg-foreground/20"}`}
              style={{ width: `${w * 0.9}px` }}
            />
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <AudioLines className="text-brand-cyan size-5" />,
    title: "ElevenLabs narration",
    description: "The approved script is voiced, and its timing drives every cut that follows.",
    header: (
      <Tile>
        <div className="flex h-14 items-center gap-[3px]">
          {BAR_HEIGHTS.map((h, i) => (
            <div
              key={i}
              className="from-brand-cyan to-brand-violet w-[3px] rounded-full bg-gradient-to-t"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <Captions className="text-brand-amber size-5" />,
    title: "Captions burned in",
    description:
      "Part of the picture, not a subtitle track — they survive re-uploads and silent autoplay.",
    header: (
      <Tile>
        <span className="bg-background/85 rounded px-2 py-1 text-[10px] font-semibold tracking-wide uppercase">
          it was a computer
        </span>
      </Tile>
    ),
  },
  {
    icon: <Music4 className="text-brand-violet size-5" />,
    title: "Music, effects and motion",
    description:
      "A music bed under the narration, sound effects, and Ken Burns motion so a still is never static.",
    className: "md:col-span-2",
    header: (
      <Tile className="items-end justify-start gap-0 p-4">
        <div className="w-full space-y-1.5">
          {[
            { label: "narration", w: "92%", cls: "bg-brand-violet/70" },
            { label: "music", w: "100%", cls: "bg-brand-blue/60" },
            { label: "sfx", w: "46%", cls: "bg-brand-amber/70" },
          ].map((track) => (
            <div key={track.label} className="flex items-center gap-2">
              <span className="text-muted-foreground w-14 shrink-0 font-mono text-[9px]">
                {track.label}
              </span>
              <div className={`h-2 rounded-sm ${track.cls}`} style={{ width: track.w }} />
            </div>
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <Crop className="text-brand-cyan size-5" />,
    title: "Shorts from the same render",
    description: "Cut vertical clips out of a video you have already finished.",
    header: (
      <Tile>
        <div className="flex items-end gap-2">
          <div className="border-foreground/25 h-10 w-16 rounded border-2" />
          <div className="border-brand-cyan h-14 w-8 rounded border-2" />
        </div>
      </Tile>
    ),
  },
  {
    icon: <MonitorPlay className="text-brand-amber size-5" />,
    title: "Publishes with its metadata",
    description:
      "Title, description, tags and thumbnail are generated with the video and go up with it.",
    header: (
      <Tile className="p-4">
        <div className="flex flex-wrap justify-center gap-1.5">
          {["title", "description", "tags", "thumbnail"].map((chip) => (
            <span
              key={chip}
              className="bg-background/70 rounded border px-1.5 py-0.5 text-[10px]"
            >
              {chip}
            </span>
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <Coins className="text-brand-blue size-5" />,
    title: "Every generation costed",
    description:
      "What each script, voice and image cost is recorded against the video it went into.",
    header: (
      <Tile>
        <span className="text-brand-blue font-mono text-2xl font-semibold">$0.00</span>
      </Tile>
    ),
  },
  {
    icon: <ServerCog className="text-brand-violet size-5" />,
    title: "One machine, your keys",
    description:
      "App, renderer and database run on a single server, with the API keys you supply.",
    header: (
      <Tile>
        <div className="border-brand-violet/40 flex size-14 items-center justify-center rounded-lg border-2 border-dashed">
          <ServerCog className="text-brand-violet/70 size-6" />
        </div>
      </Tile>
    ),
  },
];

export function LandingFeatures() {
  return (
    <section id="features" className="border-b">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-36">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            What is actually in the box
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            Nine things Framecast does today. It is under active development,
            so the list will grow — but nothing here is a promise about
            something that has not been built.
          </p>
        </div>

        <BentoGrid className="mt-14 sm:mt-16">
          {FEATURES.map((feature) => (
            <BentoGridItem
              key={feature.title}
              title={feature.title}
              description={feature.description}
              header={feature.header}
              icon={feature.icon}
              className={feature.className}
            />
          ))}
        </BentoGrid>
      </div>
    </section>
  );
}
