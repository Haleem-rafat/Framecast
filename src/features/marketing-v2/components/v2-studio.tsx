import type { LucideIcon } from "lucide-react";
import { Activity, Coins, FileCheck2, MonitorPlay } from "lucide-react";

import { V2Reveal } from "@/features/marketing-v2/components/v2-reveal";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";

/**
 * Where you sit while a run happens.
 *
 * v1 puts these four in a 2×2 grid of spotlight cards. Here they are a ledger:
 * four full-width rows, each one a label, a heading and a line, with a rule
 * between them and the screen's name pinned to the left column. It reads like
 * a list of instruments rather than a set of tiles, which is what four screens
 * of one studio actually are — and it means the features band above is the
 * only place on the page using cards, instead of the third.
 *
 * Every row names a screen that exists — the approval view on a video, the
 * activity log, the analytics page and the channels page.
 *
 * Nothing here is a number. No counts, no averages and no "trusted by",
 * because this product has no users to count yet and inventing some is the
 * single fastest way to fail the review this domain is currently under.
 */
const SURFACES: {
  icon: LucideIcon;
  accent: string;
  detail: string;
  title: string;
  body: string;
}[] = [
  {
    icon: FileCheck2,
    accent: "text-brand-amber-ink",
    detail: "Gate one",
    title: "Read the script before it spends",
    body: "The draft arrives on the video’s own page, with every earlier version kept beside it. Approving is a deliberate click, and it is the click that unlocks the paid stages.",
  },
  {
    icon: Activity,
    accent: "text-brand-blue-ink",
    detail: "Activity",
    title: "Watch the run as it happens",
    body: "Each stage reports in as it starts, finishes or fails, and the log streams into the page rather than making you reload it. When a render breaks you get the reason, not a red badge.",
  },
  {
    icon: Coins,
    accent: "text-brand-violet-ink",
    detail: "Analytics",
    title: "See what it cost, per video",
    body: "Script, voice and image generations are priced as they run and totalled against the video they went into. Render times and failures are on the same page.",
  },
  {
    icon: MonitorPlay,
    accent: "text-brand-cyan-ink",
    detail: "Channels",
    title: "Connect a channel, or take it back",
    body: "A YouTube channel is connected through Google’s own consent screen and can be disconnected from the same page at any time, which deletes the stored tokens then and there.",
  },
];

export function V2Studio() {
  return (
    <section id="studio" className="relative isolate overflow-hidden border-t py-20 sm:py-28 lg:py-32">
      {/* A static wash, not an animation: the band gets its own light without
          adding another moving thing to the page. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/8 via-brand-blue/4 absolute inset-0 -z-10 bg-gradient-to-br to-transparent"
      />

      <div className="mx-auto w-full max-w-6xl px-6">
        <V2BandHeading
          eyebrow="The studio"
          title="And a room"
          accent="to watch it from"
        >
          Automation you cannot see is just something going wrong quietly. Four
          screens carry the parts of a run you actually need in front of you.
        </V2BandHeading>

        <V2Reveal className="mt-12 sm:mt-16">
          <dl className="border-t">
            {SURFACES.map((surface) => (
              <div
                key={surface.title}
                className="group hover:bg-accent/40 grid gap-3 border-b py-7 transition-colors sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-8 sm:px-4"
              >
                <div className="flex items-center gap-2.5 sm:items-start sm:pt-1">
                  <surface.icon className={`size-5 shrink-0 ${surface.accent}`} />
                  <span className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
                    {surface.detail}
                  </span>
                </div>

                <div className="min-w-0">
                  <dt className="text-lg font-medium text-balance sm:text-xl">
                    {surface.title}
                  </dt>
                  <dd className="text-muted-foreground mt-2 max-w-2xl text-sm text-pretty">
                    {surface.body}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </V2Reveal>
      </div>
    </section>
  );
}
