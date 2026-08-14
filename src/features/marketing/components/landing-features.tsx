import type { ReactNode } from "react";
import {
  AudioLines,
  Captions,
  Coins,
  Crop,
  Film,
  FileSearch,
  Hand,
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

/**
 * Eleven tiles, four of them two columns wide: fifteen column-units into the
 * three columns this grid has at `md`.
 *
 * Fifteen dividing by three is necessary but nowhere near sufficient, and
 * believing otherwise is what put a hole in this grid. CSS auto-placement fills
 * row by row and **a two-wide tile can never start in column 3** — when one
 * lands there the browser bumps it to the next row and leaves the cell behind
 * it empty, which then shifts every later tile and frays the last row too. Two
 * two-wide tiles in a row is the trigger.
 *
 * So the real invariant is stronger than the arithmetic: reading in order, the
 * spans must fall into consecutive groups that each total exactly three —
 * (2,1), (1,2) or (1,1,1). Here that is:
 *
 *   (2,1) (1,2) (1,2) (2,1) (1,1,1)
 *
 * `assertRowsPack` below checks it on every dev render, because this is a bug
 * you cannot see in the data and can only see on the page.
 *
 * The order itself is the pipeline order — template, script, narration,
 * footage, captions, music, the gates, publish, shorts, cost, hosting — and it
 * is doing explanatory work, so the spans were chosen to fit the order rather
 * than the order rearranged to fit the spans. `grid-auto-flow: dense` would
 * also fill the holes, but it fills them by reordering, which would break that.
 *
 * Every description names a mechanism rather than an adjective. "Fast",
 * "powerful" and "seamless" are the words you reach for when you cannot say
 * what the thing does; this section is the one that has to actually convince
 * someone, so it says what the thing does.
 */
type Feature = {
  icon: ReactNode;
  title: string;
  description: string;
  /** Columns at `md` and up. Below that the grid is single-column. */
  span?: 1 | 2;
  header: ReactNode;
};

/**
 * Walks the tiles the way CSS auto-placement does and returns the index of the
 * first tile that would leave a hole, or -1 if the grid packs solid.
 */
function findPackingBreak(features: Feature[], columns = 3): number {
  let filled = 0;
  for (const [index, feature] of features.entries()) {
    const span = feature.span ?? 1;
    // A tile that does not fit in the columns left over wraps, and everything
    // between here and the end of the row stays empty.
    if (filled + span > columns) return index;
    filled = (filled + span) % columns;
  }
  // A part-filled final row is the same defect, seen at the bottom.
  return filled === 0 ? -1 : features.length - 1;
}

const FEATURES: Feature[] = [
  {
    icon: <SlidersHorizontal className="text-brand-violet-ink size-5" />,
    title: "Prompt templates you own",
    description:
      "The template that shapes every script is a document you write, version and edit, with your own variables in it. The model fills the template in; it does not get to rewrite it.",
    span: 2,
    header: (
      <Tile className="items-start p-4">
        <div className="w-full space-y-2 font-mono text-[10px] sm:text-[11px]">
          <p className="text-muted-foreground">You are writing a {"{{style}}"} script about {"{{topic}}"}.</p>
          <p className="text-muted-foreground">Open on a concrete image, never a definition.</p>
          <p className="text-brand-violet-ink">Cite a source for every claim you make.</p>
        </div>
      </Tile>
    ),
  },
  {
    icon: <FileSearch className="text-brand-blue-ink size-5" />,
    title: "Sourced scripts",
    description:
      "Claims come back with the citation attached, so checking one is reading a line rather than re-researching the topic.",
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
    icon: <AudioLines className="text-brand-cyan-ink size-5" />,
    title: "ElevenLabs narration",
    description:
      "The approved script is read back in the voice you picked, and the length of that read becomes the length of every shot after it.",
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
    icon: <Film className="text-brand-violet-ink size-5" />,
    title: "Footage matched line by line",
    description:
      "Every line gets its own stock clip chosen for that line, so the picture changes when the subject does instead of looping one montage for nine minutes.",
    span: 2,
    header: (
      <Tile className="p-4">
        <div className="w-full space-y-1.5">
          {[
            { w: "72%", cls: "bg-brand-violet/70" },
            { w: "48%", cls: "bg-brand-blue/70" },
            { w: "88%", cls: "bg-brand-cyan/70" },
          ].map((clip) => (
            <div key={clip.w} className="flex items-center gap-1.5">
              <div className={`h-4 rounded-sm ${clip.cls}`} style={{ width: clip.w }} />
              <div className="bg-foreground/15 h-4 flex-1 rounded-sm" />
            </div>
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <Captions className="text-brand-amber-ink size-5" />,
    title: "Captions burned in",
    description:
      "Drawn into the picture rather than shipped as a subtitle track, so they survive a re-upload and are still there on silent autoplay.",
    header: (
      <Tile>
        <span className="bg-background/85 rounded px-2 py-1 text-[10px] font-semibold tracking-wide uppercase">
          it was a computer
        </span>
      </Tile>
    ),
  },
  {
    icon: <Music4 className="text-brand-violet-ink size-5" />,
    title: "Music, effects and motion",
    description:
      "FFmpeg lays a music bed under the narration, drops sound effects against it, and pushes a slow Ken Burns move across every clip so a still frame is never a still frame.",
    span: 2,
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
    // The approval gates are a feature of the product, not a disclaimer about
    // it, so they get a tile in the box rather than a footnote under it.
    icon: <Hand className="text-brand-amber-ink size-5" />,
    title: "Two places it stops and waits for you",
    description:
      "The script is yours to approve before a single paid stage runs, and the finished cut is yours to watch before anything reaches your channel. Neither gate can be skipped, and not approving is a complete answer.",
    span: 2,
    header: (
      <Tile className="p-4">
        <div className="flex w-full items-center gap-2">
          {[
            { label: "script", gated: true },
            { label: "voice", gated: false },
            { label: "footage", gated: false },
            { label: "render", gated: false },
            { label: "publish", gated: true },
          ].map((step) => (
            <div key={step.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={`h-1.5 w-full rounded-full ${
                  // `-ink`: on these two bars the colour *is* the information
                  // — amber means "this is where it waits for you" — so it has
                  // to clear 3:1 rather than merely look warm.
                  step.gated ? "bg-brand-amber-ink" : "bg-foreground/20"
                }`}
              />
              <span
                className={`font-mono text-[9px] ${
                  step.gated ? "text-brand-amber-ink" : "text-muted-foreground"
                }`}
              >
                {step.label}
              </span>
              {/* A non-breaking space on the ungated steps, so all five labels
                  keep one baseline instead of the two "you" columns growing. */}
              <span className="text-brand-amber-ink text-[9px] tracking-wide uppercase">
                {step.gated ? "you" : " "}
              </span>
            </div>
          ))}
        </div>
      </Tile>
    ),
  },
  {
    icon: <Crop className="text-brand-cyan-ink size-5" />,
    title: "Shorts from the same render",
    description:
      "Pick a stretch of a video you have already finished and it is reframed to vertical and re-captioned from that same master.",
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
    icon: <MonitorPlay className="text-brand-amber-ink size-5" />,
    title: "Publishes with its metadata",
    description:
      "The title, description, tags and thumbnail are written from the same script the video was, and go up to the connected channel with it.",
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
    icon: <Coins className="text-brand-blue-ink size-5" />,
    title: "Every generation costed",
    description:
      "Each script, voice and image call is priced as it runs and totalled against the video it went into, so a video's cost is a number you can look up rather than a provider bill you reconcile later.",
    header: (
      <Tile>
        <span className="text-brand-blue-ink font-mono text-2xl font-semibold">$0.00</span>
      </Tile>
    ),
  },
  {
    icon: <ServerCog className="text-brand-violet-ink size-5" />,
    title: "One machine, your keys",
    description:
      "App, renderer and database run on a single server you control, driven by API keys you supply and that are encrypted before they are stored.",
    header: (
      <Tile>
        <div className="border-brand-violet/40 flex size-14 items-center justify-center rounded-lg border-2 border-dashed">
          <ServerCog className="text-brand-violet-ink/70 size-6" />
        </div>
      </Tile>
    ),
  },
];

/**
 * The inventory, borrowed from the grid rhythm of a logo cloud — an eyebrow, a
 * line, and a bordered grid of equal cells — with the logos left out.
 *
 * Deliberately left out. A logo cloud on this page could only be third-party
 * marks (YouTube, Google, ElevenLabs, a stock provider) or customer logos.
 * The first implies an endorsement nobody has given us, on a domain currently
 * under a Google Safe Browsing review where misuse of a third-party mark is the
 * leading suspicion — a redrawn Google "G" on the sign-in button was removed
 * days ago for exactly that. The second would have to be invented, because
 * there are no customers yet.
 *
 * So the cells hold the one thing that is both true and worth showing at this
 * density: everything a single finished run actually contains.
 *
 * Twelve of them, not the fourteen or eighteen this list could be padded to,
 * because twelve divides by 1, 2, 3 and 4 — every column count this grid takes
 * between 375px and a desktop. Any other number leaves a half-empty last row,
 * and with `gap-px` over a tinted ground an empty cell is a visible grey block
 * rather than whitespace.
 */
const INCLUDED = [
  { label: "A script from your template", accent: "bg-brand-violet" },
  { label: "Sources for its claims", accent: "bg-brand-violet" },
  { label: "Your approval of that script", accent: "bg-brand-amber-ink" },
  { label: "ElevenLabs narration", accent: "bg-brand-cyan" },
  { label: "Footage matched per line", accent: "bg-brand-violet" },
  { label: "Captions burned into frame", accent: "bg-brand-cyan" },
  { label: "A music bed and sound effects", accent: "bg-brand-blue" },
  { label: "Ken Burns motion on every clip", accent: "bg-brand-blue" },
  { label: "A 1920 × 1080 master", accent: "bg-brand-blue" },
  { label: "Title, description, tags, thumbnail", accent: "bg-brand-cyan" },
  { label: "Your approval of the finished cut", accent: "bg-brand-amber-ink" },
  { label: "The upload to your channel", accent: "bg-brand-cyan" },
];

export function LandingFeatures() {
  // Dev-only, and deliberately loud. The hole this catches is invisible in the
  // data — the spans still sum to a multiple of three — and only shows up as an
  // empty tile on the rendered page, which is exactly the kind of defect that
  // ships. Production is untouched: this is a layout guard, not a reason to
  // fail a build.
  if (process.env.NODE_ENV !== "production") {
    const broken = findPackingBreak(FEATURES);
    if (broken !== -1) {
      console.error(
        `[landing-features] The bento grid does not pack solid at md: "${FEATURES[broken]?.title}" leaves a hole. ` +
          "Reading in order, spans must fall into consecutive groups of exactly three columns — (2,1), (1,2) or (1,1,1).",
      );
    }
  }

  return (
    <section id="features" className="border-b">
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-36">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            What is actually in the box
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            Eleven things Framecast does today, described by what they do rather
            than by how good they are. It is under active development, so the
            list will grow — but nothing here is a promise about something that
            has not been built.
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
              className={feature.span === 2 ? "md:col-span-2" : undefined}
            />
          ))}
        </BentoGrid>

        <div className="mt-16 sm:mt-20">
          <p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
            In every finished run
          </p>
          <h3 className="mt-3 text-xl font-medium text-balance sm:text-2xl">
            Twelve things, and you do two of them
          </h3>

          {/* One-pixel gaps over a tinted ground draw the grid's rules, so the
              cells read as a table without eighteen separate borders. */}
          <ul className="bg-border mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-xl border min-[420px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {INCLUDED.map((item) => (
              <li
                key={item.label}
                className="bg-background hover:bg-accent/50 flex items-center gap-2.5 px-4 py-4 text-sm transition-colors"
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full ${item.accent}`}
                />
                <span className="text-pretty">{item.label}</span>
              </li>
            ))}
          </ul>

          <p className="text-muted-foreground mt-4 text-xs text-pretty">
            The two amber ones are yours: the run halts at each of them until you
            say so.
          </p>
        </div>
      </div>
    </section>
  );
}
