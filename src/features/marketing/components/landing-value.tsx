import { Gauge, Repeat, Wallet } from "lucide-react";

import { VALUE_PROPOSITION } from "@/features/marketing/landing-copy";

/**
 * Block 2 of the landing page: three things measured and improved.
 *
 * This section is what the eight-tile feature grid used to do from the top of
 * the page, and the difference is not length. A feature grid answers "what is
 * in it"; this answers "what changes for me", which is the question a reader
 * has immediately after a hook has named their problem.
 *
 * The features grid is not gone — it sits below this, where features belong,
 * after the four blocks have done their work.
 *
 * Three icons, one per outcome, in the same order as the copy. They are
 * decoration and marked `aria-hidden`: the heading and the text carry the
 * meaning, and a screen reader gains nothing from "gauge".
 */

/** One per outcome, positionally. A fourth outcome would need a fourth icon,
 *  which is a small friction on purpose — the structure calls for three, and
 *  `landing-copy.test.ts` fails if that changes. */
const ICONS = [Gauge, Repeat, Wallet] as const;

export function LandingValue() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        {/* The mechanism sentence, which used to be the h1. It reads far
          * better here: a reader who has just been told their problem is
          * eleven hours a week is ready to hear what replaces them. */}
        <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {VALUE_PROPOSITION.lead}
        </h2>
        <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
          {VALUE_PROPOSITION.intro}
        </p>
      </div>

      <ul className="mt-12 grid gap-6 sm:grid-cols-3">
        {VALUE_PROPOSITION.outcomes.map((outcome, index) => {
          const Icon = ICONS[index] ?? Gauge;

          return (
            <li
              key={outcome.name}
              className="border-border/60 bg-background/40 flex flex-col gap-3 rounded-2xl border p-6 backdrop-blur-sm"
            >
              <Icon aria-hidden="true" className="text-brand-violet-ink size-5" />
              <h3 className="text-base font-medium">{outcome.name}</h3>
              <p className="text-muted-foreground text-sm text-pretty">{outcome.detail}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
