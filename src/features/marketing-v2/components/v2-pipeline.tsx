import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Clapperboard,
  FileText,
  Film,
  Hand,
  PenLine,
  UploadCloud,
} from "lucide-react";

import { V2GateBorder } from "@/features/marketing-v2/components/v2-gate-border";
import { V2Reveal } from "@/features/marketing-v2/components/v2-reveal";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";
import { V2TypedTopic } from "@/features/marketing-v2/components/v2-typed-topic";

/**
 * The six stages, as a filmstrip you scroll sideways.
 *
 * v1 tells this as a vertical timeline with a sticky heading beside it — you
 * read down the page and the stages arrive one under another. This is the
 * opposite gesture: a single horizontal track with scroll-snap, so the run
 * reads left to right the way a timeline in an editor does, and on a phone it
 * is a swipe rather than four screens of scrolling. It is also the section
 * where v2 differs most in *behaviour* rather than in paint.
 *
 * Every card is in the DOM and in reading order — this is a scroll container,
 * not a carousel that mounts one slide at a time — so nothing here depends on
 * JavaScript to be read, and the keyboard can reach every card because the
 * track is focusable and scrollable.
 *
 * The two gates are the point of the section, so they are marked three times:
 * an amber rule down the card, a "Stops here" chip, and the heading itself.
 * v1's page comment asks that at least the hero and this section keep the
 * claim; both do.
 *
 * ElevenLabs and YouTube appear as plain text. No mark, no logo, no borrowed
 * brand colour.
 */
type Stage = {
  icon: LucideIcon;
  title: string;
  body: string;
  gate?: string;
};

const STAGES: Stage[] = [
  {
    icon: PenLine,
    title: "You give it a topic",
    body: "A topic, and the prompt template that shapes what gets written from it — tone, structure, length, how it opens. The template is yours to edit; the model writes inside it rather than around it.",
  },
  {
    icon: FileText,
    title: "An AI writes the script — and then stops",
    body: "The result is a sourced, spoken-word script. Nothing downstream runs until you have read it and approved it, because everything downstream costs money.",
    gate: "Gate one",
  },
  {
    icon: AudioLines,
    title: "ElevenLabs narrates it",
    body: "The approved script is read back in the voice you picked. The timing of that narration becomes the timing of the video — every cut that follows is measured against it.",
  },
  {
    icon: Film,
    title: "Footage is matched line by line",
    body: "Each line of the script gets its own stock clip, so what is on screen follows what is being said instead of looping the same montage for nine minutes.",
  },
  {
    icon: Clapperboard,
    title: "FFmpeg renders the cut",
    body: "Captions burned into the frame, a music bed under the narration, sound effects, and Ken Burns motion so a still image is never a still image.",
  },
  {
    icon: UploadCloud,
    title: "You watch it, then it publishes",
    body: "Approve the finished video and it uploads to the connected YouTube channel with a generated title, description, tags and thumbnail. Don’t approve it, and nothing leaves the machine.",
    gate: "Gate two",
  },
];

/** Illustrative only — no real run is being quoted here. */
const EXAMPLE_TOPIC = "Why the Antikythera mechanism still puzzles engineers";
const EXAMPLE_SCRIPT =
  "In 1901, sponge divers working a wreck off a Greek island hauled up a corroded lump of bronze. It took another seventy years, and an X-ray machine, before anyone accepted what it was.";

export function V2Pipeline() {
  return (
    <section id="the-run" className="py-20 sm:py-28 lg:py-32">
      <div className="mx-auto w-full max-w-6xl px-6">
        <V2BandHeading
          eyebrow="The run"
          title="Six stages."
          accent="It stops twice, on purpose."
          reveal
        >
          A run goes end to end on its own, but it is built to halt and wait for
          a person — once before it starts spending, once before it publishes.
        </V2BandHeading>
      </div>

      {/* Full-bleed track. It starts and ends flush with the 6xl measure above
          via the spacer cells, but scrolls the whole width of the viewport, so
          on a phone the next card is always visibly peeking. */}
      <div className="mt-12 sm:mt-16">
        <ol
          tabIndex={0}
          aria-label="The six stages of a run, in order"
          className="focus-visible:ring-ring/50 flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 focus-visible:ring-3 focus-visible:outline-none [scrollbar-width:thin] lg:px-[max(1.5rem,calc((100vw-72rem)/2))]"
        >
          {STAGES.map((stage, index) => (
            <li
              key={stage.title}
              className="w-[min(20rem,78vw)] shrink-0 snap-start sm:w-[22rem]"
            >
              {/* The two gates get React Bits' ElectricBorder, in amber. It is
                  the one place on the page where an effect is carrying the
                  meaning rather than decorating it: these are the stages where
                  the machine stops and waits for a person, and a card that
                  crackles is a card you look at. The other four are plain. */}
              <V2GateBorder gated={Boolean(stage.gate)}>
              <div
                className={`bg-card relative flex h-full flex-col overflow-hidden rounded-2xl border p-5 sm:p-6 ${
                  stage.gate ? "border-brand-amber-ink/40" : ""
                }`}
              >
                {stage.gate ? (
                  // The colour *is* the information — amber means "this is
                  // where it waits for you" — so it is the `-ink` stop.
                  <span
                    aria-hidden="true"
                    className="bg-brand-amber-ink absolute inset-y-0 left-0 w-[3px]"
                  />
                ) : null}

                <div className="flex items-center gap-3">
                  <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg font-mono text-xs">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <stage.icon className="text-brand-violet-ink size-5 shrink-0" />
                  {stage.gate ? (
                    <span className="text-brand-amber-ink ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                      <Hand className="size-3.5" />
                      Stops here
                    </span>
                  ) : null}
                </div>

                <h3 className="mt-4 text-base font-medium text-balance">
                  {stage.title}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm text-pretty">
                  {stage.body}
                </p>

                {stage.gate ? (
                  <p className="text-brand-amber-ink mt-auto pt-4 font-mono text-[11px] tracking-wide">
                    {stage.gate} — waits for you
                  </p>
                ) : null}
              </div>
              </V2GateBorder>
            </li>
          ))}
        </ol>

        <p className="text-muted-foreground mx-auto mt-3 w-full max-w-6xl px-6 text-xs">
          Scroll or swipe the track sideways.
        </p>
      </div>

      {/* The one artefact in this band that is quoted rather than described.
          Labelled as an example, because it is one: no real run is shown. */}
      <div className="mx-auto mt-14 w-full max-w-6xl px-6 sm:mt-16">
        <V2Reveal>
          <figure className="bg-muted/40 mx-auto max-w-2xl rounded-2xl border p-5 sm:p-6">
            <figcaption className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] tracking-wide uppercase">
              <span className="bg-background rounded border px-1.5 py-0.5">
                Example
              </span>
              topic
            </figcaption>
            <V2TypedTopic topic={EXAMPLE_TOPIC} />
            <hr className="my-3" />
            <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
              script
            </span>
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              {EXAMPLE_SCRIPT}
            </p>
          </figure>
        </V2Reveal>
      </div>
    </section>
  );
}
