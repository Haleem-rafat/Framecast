import { FocusCards, type FocusCard } from "@/components/ui/focus-cards";

/**
 * Every frame below is drawn in CSS. None of it is a screenshot, and none of it
 * quotes a real video: these are diagrams of the artefacts a finished run
 * leaves behind, labelled as such, because a mocked-up screenshot of a video
 * nobody made would be a lie told in pictures.
 */

/** The soft wash that stands in for footage inside each frame. */
const FOOTAGE =
  "bg-gradient-to-br from-foreground/10 via-foreground/5 to-foreground/10";

function Frame({
  className,
  caption,
  size,
  progress,
}: {
  className: string;
  caption: string;
  /** Pixel dimensions, shown in the corner the way a monitor would. */
  size: string;
  /** Playhead position, 0–1. */
  progress: number;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border ${FOOTAGE} ${className}`}
    >
      {/* A raking sheen, so the frame reads as a lit picture rather than a
          placeholder rectangle. */}
      <div
        aria-hidden="true"
        className="via-foreground/8 absolute -inset-x-1/3 -top-1/3 h-[170%] rotate-12 bg-gradient-to-r from-transparent to-transparent"
      />

      <span className="text-muted-foreground bg-background/60 absolute top-2 left-2 rounded px-1.5 py-0.5 font-mono text-[9px]">
        {size}
      </span>

      {/* Burned-in caption: part of the picture, not a subtitle track the
          player can switch off, so it is drawn inside the frame. */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-4">
        <span className="bg-background/85 rounded px-2 py-1 text-center text-[10px] leading-tight font-semibold tracking-wide uppercase">
          {caption}
        </span>
      </div>

      <div
        aria-hidden="true"
        className="bg-foreground/10 absolute inset-x-0 bottom-0 h-0.5"
      >
        <div
          className="bg-foreground/50 h-full"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

const TAGS = ["antikythera", "ancient technology", "archaeology"];

const CARDS: FocusCard[] = [
  {
    title: "A 16:9 video",
    caption:
      "Narration, matched footage, a music bed, sound effects, Ken Burns motion, and captions burned into the frame.",
    children: (
      <Frame
        className="aspect-video w-full"
        caption="it was a computer"
        size="1920 × 1080"
        progress={0.38}
      />
    ),
  },
  {
    title: "A vertical Short",
    caption:
      "Framecast can cut vertical Shorts out of a video it has already finished, reframed and re-captioned from the same render.",
    children: (
      <div className="flex h-full items-center justify-center">
        <Frame
          className="aspect-[9/16] w-28 sm:w-32"
          caption="70 years to notice"
          size="1080 × 1920"
          progress={0.62}
        />
      </div>
    ),
  },
  {
    title: "The YouTube listing",
    caption:
      "Title, description, tags and thumbnail are generated with the video and travel with it to the channel.",
    children: (
      <div className="space-y-3">
        <div
          className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border p-3 ${FOOTAGE}`}
        >
          <span className="text-center text-sm leading-tight font-black tracking-tight uppercase">
            A 2,000-year-old computer
          </span>
        </div>
        <p className="text-sm leading-snug font-medium text-pretty">
          Why the Antikythera mechanism still puzzles engineers
        </p>
        <div className="flex flex-wrap gap-1.5">
          {TAGS.map((tag) => (
            <span
              key={tag}
              className="text-muted-foreground rounded border px-1.5 py-0.5 text-[11px]"
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>
    ),
  },
];

export function LandingOutput() {
  return (
    <section className="border-b">
      <div className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-24">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            What a finished run leaves behind
          </h2>
          <p className="text-muted-foreground mt-3 text-base text-pretty">
            One long video, the Shorts you choose to cut from it, and the
            listing that goes up with it — all from the same script.
          </p>
        </div>

        <FocusCards cards={CARDS} className="mt-12" />

        <p className="text-muted-foreground mt-6 text-xs">
          Illustrations, not screenshots. The topic and copy above are an
          example.
        </p>
      </div>
    </section>
  );
}
