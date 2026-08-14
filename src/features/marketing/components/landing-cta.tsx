import Link from "next/link";
import { KeyRound, ServerCog, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Meteors } from "@/components/ui/meteors";
import { Spotlight } from "@/components/ui/spotlight-new";

/**
 * Every claim on this page has to be true of the thing that actually exists, so
 * the closing section is the operational truth rather than a testimonial wall:
 * what it runs on, whose keys pay for it, and what state the project is in.
 */
const FACTS = [
  {
    icon: ServerCog,
    title: "One machine",
    body: "Framecast is self-hosted. The app, the renderer and the database all run on a single server, and that database accepts no connections from the internet.",
  },
  {
    icon: KeyRound,
    title: "Your keys",
    body: "The AI providers are configured with keys you supply, and each generation's cost is recorded against the video it produced.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing posts itself",
    body: "A connected channel is only ever written to for a cut you approved. Framecast asks for no Google permission beyond reading that channel and uploading to it.",
  },
];

export function LandingCta() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* The page's second and last piece of continuous motion, at the very
          bottom where it is the only thing on screen. The hero's aurora and
          this are deliberately kept apart so neither is ever composited while
          the other is. */}
      <Spotlight />
      <Meteors number={10} />

      <div className="relative mx-auto w-full max-w-6xl px-6 py-20 sm:py-28 lg:py-36">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
              Your channel, your keys, your machine.
            </h2>
            <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
              Framecast is a private studio tool under active development, not a
              public service. Create an account and an operator will review it
              before it can be used.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/sign-up">Create an account</Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link href="/privacy">How your data is used</Link>
              </Button>
            </div>
          </div>

          <dl className="space-y-6">
            {FACTS.map((fact) => (
              <div key={fact.title} className="flex gap-4">
                <fact.icon className="text-brand-violet-ink mt-0.5 size-5 shrink-0" />
                <div className="min-w-0">
                  <dt className="text-sm font-medium">{fact.title}</dt>
                  <dd className="text-muted-foreground mt-1 text-sm text-pretty">
                    {fact.body}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
