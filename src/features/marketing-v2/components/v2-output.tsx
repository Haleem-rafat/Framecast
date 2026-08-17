"use client";

import CardSwap, { Card } from "@/components/react-bits/CardSwap";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";

/**
 * What a finished run leaves behind, as a deck that deals itself.
 *
 * v1 shows the same three artefacts as a row of focus cards that dim their
 * neighbours on hover. This is React Bits' CardSwap: a 3D stack that promotes
 * the back card to the front on a timer. It suits the content — these are
 * three things that come out of one render, not three options to choose
 * between — and it is the single most obviously different thing about v2.
 *
 * The words live in the list on the left, permanently, in reading order. The
 * deck on the right is the picture and is hidden below `lg`, where a 3D stack
 * with a fixed pixel width has nowhere to stand. Nothing is said only inside
 * the deck, so nothing is lost when it is not there — and there is no
 * duplicated copy for a crawler to find twice.
 *
 * Every frame is drawn in CSS. None of it is a screenshot and none of it
 * quotes a real video: these are diagrams of the artefacts a finished run
 * leaves behind, labelled as such, because a mocked-up screenshot of a video
 * nobody made would be a lie told in pictures. The listing card is plain text
 * over CSS rectangles — no player chrome, no red, no mark.
 */

const FOOTAGE =
  "bg-gradient-to-br from-brand-violet/25 via-brand-blue/15 to-brand-cyan/25";

const ARTEFACTS = [
  {
    name: "A 16:9 video",
    body: "Narration, matched footage, a music bed, sound effects, Ken Burns motion, and captions burned into the frame.",
    meta: "1920 × 1080",
  },
  {
    name: "A vertical Short",
    body: "Framecast can cut vertical Shorts out of a video it has already finished, reframed and re-captioned from the same render.",
    meta: "1080 × 1920",
  },
  {
    name: "The YouTube listing",
    body: "Title, description, tags and thumbnail are generated with the video and travel with it to the channel.",
    meta: "title · description · tags · thumbnail",
  },
];

function Frame({
  className,
  caption,
  size,
  progress,
}: {
  className: string;
  caption: string;
  size: string;
  /** Playhead position, 0–1. */
  progress: number;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg border ${FOOTAGE} ${className}`}
    >
      <span className="text-muted-foreground bg-background/60 absolute top-2 left-2 rounded px-1.5 py-0.5 font-mono text-[9px]">
        {size}
      </span>

      {/* Burned into the picture, not a subtitle track the player can switch
          off — so it is drawn inside the frame. */}
      <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-4">
        <span className="bg-background/85 rounded px-2 py-1 text-center text-[10px] leading-tight font-semibold tracking-wide uppercase">
          {caption}
        </span>
      </div>

      <div
        aria-hidden="true"
        className="bg-foreground/15 absolute inset-x-0 bottom-0 h-0.5"
      >
        <div
          className="from-brand-violet to-brand-cyan h-full bg-gradient-to-r"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

function CardChrome({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col p-4">
      <p className="text-muted-foreground shrink-0 font-mono text-[11px] tracking-[0.18em] uppercase">
        {label}
      </p>
      <div className="mt-3 flex min-h-0 flex-1 items-center justify-center">
        {children}
      </div>
    </div>
  );
}

export function V2Output() {
  return (
    <section id="output" className="border-t py-20 sm:py-28 lg:py-32">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-8">
        <div>
          <V2BandHeading
            eyebrow="Output"
            title="What a finished run"
            accent="leaves behind"
          >
            One long video, the Shorts you choose to cut from it, and the
            listing that goes up with it — all from the same script.
          </V2BandHeading>

          <dl className="mt-10 space-y-6">
            {ARTEFACTS.map((artefact) => (
              <div key={artefact.name} className="border-l-2 pl-4">
                <dt className="flex flex-wrap items-baseline gap-x-3 text-base font-medium">
                  {artefact.name}
                  <span className="text-muted-foreground font-mono text-[11px] font-normal tracking-wide">
                    {artefact.meta}
                  </span>
                </dt>
                <dd className="text-muted-foreground mt-1.5 max-w-lg text-sm text-pretty">
                  {artefact.body}
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-muted-foreground mt-8 text-xs">
            Illustrations, not screenshots. The topic and copy shown are an
            example.
          </p>
        </div>

        {/* CardSwap positions itself `absolute bottom-0 right-0` with a
            positive X translate — it overflows its parent on purpose — so this
            box is `relative overflow-hidden` with a reserved height. Without
            both, the deck would put a horizontal scrollbar on the page. */}
        <div className="relative hidden h-[26rem] overflow-hidden lg:block">
          <CardSwap
            width={340}
            height={260}
            cardDistance={44}
            verticalDistance={52}
            delay={3600}
            pauseOnHover
            skewAmount={5}
            easing="linear"
          >
            <Card>
              <CardChrome label="16:9 master">
                <Frame
                  className="aspect-video w-full"
                  caption="it was a computer"
                  size="1920 × 1080"
                  progress={0.38}
                />
              </CardChrome>
            </Card>

            <Card>
              <CardChrome label="Vertical Short">
                <Frame
                  className="aspect-[9/16] h-full"
                  caption="70 years to notice"
                  size="1080 × 1920"
                  progress={0.62}
                />
              </CardChrome>
            </Card>

            <Card>
              <CardChrome label="The listing">
                <div className="w-full">
                  <div
                    className={`relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border p-3 ${FOOTAGE}`}
                  >
                    <span className="text-center text-sm leading-tight font-black tracking-tight uppercase">
                      A 2,000-year-old computer
                    </span>
                  </div>
                  <p className="mt-2 truncate text-xs font-medium">
                    Why the Antikythera mechanism still puzzles engineers
                  </p>
                </div>
              </CardChrome>
            </Card>
          </CardSwap>
        </div>
      </div>
    </section>
  );
}
