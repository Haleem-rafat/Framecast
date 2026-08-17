import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Captions,
  Coins,
  Crop,
  Film,
  FileSearch,
  Hammer,
  Hand,
  MonitorPlay,
  Music4,
  ServerCog,
  SlidersHorizontal,
} from "lucide-react";

import SpotlightCard from "@/components/react-bits/SpotlightCard";
import { V2Reveal } from "@/features/marketing-v2/components/v2-reveal";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";

/**
 * The same eleven features v1 lays out as a bento grid, here as one even grid
 * of React Bits SpotlightCards — a pool of light that follows the pointer
 * across whichever card it is actually over.
 *
 * A flat grid rather than a bento on purpose. v1's tiles span one or two
 * columns and each carries its own hand-drawn CSS illustration, which is where
 * most of that page's weight is; it also needs a packing invariant, because
 * CSS auto-placement leaves a hole when a two-wide tile lands in the last
 * column. Here the interest comes from the light rather than from the shape,
 * so every cell is the same size and there is no invariant to break.
 *
 * Eleven cards in three columns still leaves a ragged last row, so the twelfth
 * states the thing that is true and was otherwise only in a paragraph: the
 * list is not finished. It is copy, not filler.
 *
 * Every description names a mechanism rather than an adjective. Nothing here
 * is a promise about something that has not been built.
 */
type Feature = {
  icon: LucideIcon;
  accent: string;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: SlidersHorizontal,
    accent: "text-brand-violet-ink",
    title: "Prompt templates you own",
    body: "The template that shapes every script is a document you write, version and edit, with your own variables in it. The model fills the template in; it does not get to rewrite it.",
  },
  {
    icon: FileSearch,
    accent: "text-brand-blue-ink",
    title: "Sourced scripts",
    body: "Claims come back with the citation attached, so checking one is reading a line rather than re-researching the topic.",
  },
  {
    icon: AudioLines,
    accent: "text-brand-cyan-ink",
    title: "ElevenLabs narration",
    body: "The approved script is read back in the voice you picked, and the length of that read becomes the length of every shot after it.",
  },
  {
    icon: Film,
    accent: "text-brand-violet-ink",
    title: "Footage matched line by line",
    body: "Every line gets its own stock clip chosen for that line, so the picture changes when the subject does instead of looping one montage for nine minutes.",
  },
  {
    icon: Captions,
    accent: "text-brand-amber-ink",
    title: "Captions burned in",
    body: "Drawn into the picture rather than shipped as a subtitle track, so they survive a re-upload and are still there on silent autoplay.",
  },
  {
    icon: Music4,
    accent: "text-brand-violet-ink",
    title: "Music, effects and motion",
    body: "FFmpeg lays a music bed under the narration, drops sound effects against it, and pushes a slow Ken Burns move across every clip so a still frame is never a still frame.",
  },
  {
    icon: Hand,
    accent: "text-brand-amber-ink",
    title: "Two places it stops and waits for you",
    body: "The script is yours to approve before a single paid stage runs, and the finished cut is yours to watch before anything reaches your channel. Neither gate can be skipped, and not approving is a complete answer.",
  },
  {
    icon: Crop,
    accent: "text-brand-cyan-ink",
    title: "Shorts from the same render",
    body: "Pick a stretch of a video you have already finished and it is reframed to vertical and re-captioned from that same master.",
  },
  {
    icon: MonitorPlay,
    accent: "text-brand-amber-ink",
    title: "Publishes with its metadata",
    body: "The title, description, tags and thumbnail are written from the same script the video was, and go up to the connected channel with it.",
  },
  {
    icon: Coins,
    accent: "text-brand-blue-ink",
    title: "Every generation costed",
    body: "Each script, voice and image call is priced as it runs and totalled against the video it went into, so a video’s cost is a number you can look up rather than a provider bill you reconcile later.",
  },
  {
    icon: ServerCog,
    accent: "text-brand-violet-ink",
    title: "One machine, your keys",
    body: "App, renderer and database run on a single server you control, driven by API keys you supply and that are encrypted before they are stored.",
  },
  {
    icon: Hammer,
    accent: "text-muted-foreground",
    title: "And it is not finished",
    body: "Framecast is under active development, so this list will grow — but nothing above is a promise about something that has not been built.",
  },
];

export function V2Features() {
  return (
    <section id="features" className="border-t py-20 sm:py-28 lg:py-32">
      <div className="mx-auto w-full max-w-6xl px-6">
        <V2BandHeading
          eyebrow="Features"
          title="What is actually"
          accent="in the box"
        >
          Eleven things Framecast does today, described by what they do rather
          than by how good they are.
        </V2BandHeading>

        <V2Reveal className="mt-12 sm:mt-16">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <SpotlightCard
                key={feature.title}
                className="h-full"
                // The pool is the same token CardSpotlight uses in v1, so both
                // pages light a card with the same colour in both themes.
                spotlightColor="var(--card-spotlight-wash)"
              >
                <div className="flex h-full flex-col p-5 sm:p-6">
                  <feature.icon className={`size-5 shrink-0 ${feature.accent}`} />
                  <h3 className="mt-4 text-base font-medium text-balance">
                    {feature.title}
                  </h3>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">
                    {feature.body}
                  </p>
                </div>
              </SpotlightCard>
            ))}
          </div>
        </V2Reveal>
      </div>
    </section>
  );
}
