import {
  AudioLines,
  Clapperboard,
  FileText,
  Film,
  PenLine,
  UploadCloud,
} from "lucide-react";

import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { Timeline, type TimelineEntry } from "@/components/ui/timeline";

/** Illustrative only — no real run is being quoted here. */
const EXAMPLE_TOPIC = "Why the Antikythera mechanism still puzzles engineers";
const EXAMPLE_SCRIPT =
  "In 1901, sponge divers working a wreck off a Greek island hauled up a corroded lump of bronze. It took another seventy years, and an X-ray machine, before anyone accepted what it was.";

function Body({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground max-w-xl text-sm text-pretty">
      {children}
    </p>
  );
}

const STAGES: TimelineEntry[] = [
  {
    title: "You give it a topic",
    icon: <PenLine />,
    content: (
      <Body>
        A topic, and the prompt template that shapes what gets written from it —
        tone, structure, length, how it opens. The template is yours to edit;
        the model writes inside it rather than around it.
      </Body>
    ),
  },
  {
    title: "An AI writes the script — and then stops",
    icon: <FileText />,
    content: (
      <div className="space-y-4">
        <Body>
          The result is a sourced, spoken-word script. Nothing downstream runs
          until you have read it and approved it, because everything downstream
          costs money.
        </Body>

        <figure className="bg-muted/40 max-w-xl rounded-xl border p-4">
          <figcaption className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] tracking-wide uppercase">
            <span className="bg-background rounded border px-1.5 py-0.5">
              Example
            </span>
            topic
          </figcaption>
          <p className="mt-2 text-sm font-medium text-pretty">
            {EXAMPLE_TOPIC}
          </p>

          <hr className="my-3" />

          <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
            script
          </span>
          <p className="mt-2 text-sm text-pretty">
            <TextGenerateEffect words={EXAMPLE_SCRIPT} />
          </p>
        </figure>
      </div>
    ),
  },
  {
    title: "ElevenLabs narrates it",
    icon: <AudioLines />,
    content: (
      <Body>
        The approved script is read back in the voice you picked. The timing of
        that narration becomes the timing of the video — every cut that follows
        is measured against it.
      </Body>
    ),
  },
  {
    title: "Footage is matched line by line",
    icon: <Film />,
    content: (
      <Body>
        Each line of the script gets its own stock clip, so what is on screen
        follows what is being said instead of looping the same montage for nine
        minutes.
      </Body>
    ),
  },
  {
    title: "FFmpeg renders the cut",
    icon: <Clapperboard />,
    content: (
      <Body>
        Captions burned into the frame, a music bed under the narration, sound
        effects, and Ken Burns motion so a still image is never a still image.
      </Body>
    ),
  },
  {
    title: "You watch it, then it publishes",
    icon: <UploadCloud />,
    content: (
      <Body>
        Approve the finished video and it uploads to the connected YouTube
        channel with a generated title, description, tags and thumbnail. Don&apos;t
        approve it, and nothing leaves the machine.
      </Body>
    ),
  },
];

export function LandingPipeline() {
  return (
    <section id="pipeline" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-16 sm:py-24 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16">
        {/* Pinned beside the rail on wide screens, so the claim the section is
            making stays on screen while you read the stages that back it up. */}
        <div className="lg:sticky lg:top-28 lg:self-start">
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Six stages. It stops twice, on purpose.
          </h2>
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            A run goes end to end on its own, but it is built to halt and wait
            for a person — once before it starts spending, once before it
            publishes.
          </p>
        </div>

        <Timeline data={STAGES} />
      </div>
    </section>
  );
}
