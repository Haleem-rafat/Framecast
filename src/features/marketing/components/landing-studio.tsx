import type { LucideIcon } from "lucide-react";
import { Activity, Coins, FileCheck2, MonitorPlay } from "lucide-react";

import { CardSpotlight } from "@/components/ui/card-spotlight";

/**
 * The sections above this one describe what a run produces. This one is about
 * where you sit while it happens, which is the half of the product a pipeline
 * diagram never shows.
 *
 * Every card names a screen that exists — the approval view on a video, the
 * activity log, the analytics page and the channels page. Nothing here is a
 * roadmap item dressed up as a feature, and nothing here is a number: there are
 * no counts, no averages and no "trusted by", because this product has no users
 * to count yet and inventing some is the single fastest way to fail the review
 * this domain is currently under.
 */
const SURFACES: {
  icon: LucideIcon;
  accent: string;
  chip: string;
  title: string;
  body: string;
  detail: string;
}[] = [
  {
    icon: FileCheck2,
    accent: "text-brand-violet-ink",
    chip: "from-brand-violet/20 to-brand-violet/5",
    title: "Read the script before it spends",
    body: "The draft arrives on the video's own page, with every earlier version kept beside it. Approving is a deliberate click, and it is the click that unlocks the paid stages.",
    detail: "Gate one",
  },
  {
    icon: Activity,
    accent: "text-brand-blue-ink",
    chip: "from-brand-blue/20 to-brand-blue/5",
    title: "Watch the run as it happens",
    body: "Each stage reports in as it starts, finishes or fails, and the log streams into the page rather than making you reload it. When a render breaks you get the reason, not a red badge.",
    detail: "Activity",
  },
  {
    icon: Coins,
    accent: "text-brand-amber-ink",
    chip: "from-brand-amber/20 to-brand-amber/5",
    title: "See what it cost, per video",
    body: "Script, voice and image generations are priced as they run and totalled against the video they went into. Render times and failures are on the same page.",
    detail: "Analytics",
  },
  {
    icon: MonitorPlay,
    accent: "text-brand-cyan-ink",
    chip: "from-brand-cyan/20 to-brand-cyan/5",
    title: "Connect a channel, or take it back",
    body: "A YouTube channel is connected through Google's own consent screen and can be disconnected from the same page at any time, which deletes the stored tokens then and there.",
    detail: "Channels",
  },
];

export function LandingStudio() {
  return (
    <section id="studio" className="relative isolate overflow-hidden border-b">
      {/* A static wash, not an animation: it gives the section its own light
          without adding a third moving thing to the page. */}
      <div
        aria-hidden="true"
        className="from-brand-violet/8 via-brand-blue/4 absolute inset-0 -z-10 bg-gradient-to-br to-transparent"
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-36">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
            And a room to watch it from
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
            Automation you cannot see is just something going wrong quietly.
            Four screens carry the parts of a run you actually need in front of
            you.
          </p>
        </div>

        <div className="mt-14 grid gap-6 sm:mt-16 sm:grid-cols-2">
          {SURFACES.map((surface) => (
            <CardSpotlight
              key={surface.title}
              radius={320}
              contentClassName="flex h-full flex-col p-6 sm:p-7"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${surface.chip}`}
                >
                  <surface.icon className={`size-5 ${surface.accent}`} />
                </span>
                <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
                  {surface.detail}
                </span>
              </div>

              <h3 className="mt-5 text-lg font-medium text-balance">
                {surface.title}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm text-pretty">
                {surface.body}
              </p>
            </CardSpotlight>
          ))}
        </div>
      </div>
    </section>
  );
}
