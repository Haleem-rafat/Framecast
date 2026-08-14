import Link from "next/link";
import { ArrowRight, Check, KeyRound, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CardSpotlight } from "@/components/ui/card-spotlight";
import { LampSection } from "@/components/ui/lamp";

/**
 * Pricing, written against a codebase that has no payment system in it.
 *
 * There is no Stripe, no Paddle, no checkout, no subscription and no card on
 * file anywhere in this repository, so this section must not imply that
 * anything can be bought. That rules out a price, a "Buy now", a struck-through
 * "was", a countdown, a plan comparison implying a paid tier exists, and a
 * button that collects anything. What is left is the truth, which is short:
 * it is free while it is in beta, the third-party bills are yours and go to the
 * providers directly, and there is nothing to pay us because there is no way to.
 *
 * That last card is the important one. A page that says plainly "we cannot take
 * your money" is doing the opposite of what a deceptive page does, and it costs
 * nothing to say because it is true.
 *
 * The only call to action in this section goes to /sign-up.
 */
const PLANS = [
  {
    name: "Beta",
    price: "Free",
    note: "Available now",
    available: true,
    featured: true,
    summary:
      "Framecast is free to use while it is in beta. Create an account and an operator reviews it before it is activated.",
    lines: [
      { icon: Check, text: "The whole pipeline: script, narration, footage, render, publish" },
      { icon: Check, text: "Shorts cut from any video you have finished" },
      { icon: Check, text: "Per-generation cost recorded against each video" },
      { icon: KeyRound, text: "You supply the AI provider keys" },
    ],
  },
  {
    name: "Self-hosted",
    price: "Your server",
    note: "Available now",
    available: true,
    featured: false,
    summary:
      "Framecast runs on one machine. Host it yourself and there is nobody to pay for the software — you pay your VPS and your API providers, directly.",
    lines: [
      { icon: Check, text: "App, renderer and database on a single server" },
      { icon: Check, text: "Database reachable only from that machine" },
      { icon: Check, text: "Tokens and keys encrypted at rest" },
    ],
  },
  {
    name: "Paid plans",
    price: "None",
    note: "Not available",
    available: false,
    featured: false,
    summary:
      "Framecast has no payment system: no checkout, no subscription, no card on file, no invoice. There is nothing on this page you can buy, and no button here takes payment.",
    lines: [
      { icon: Minus, text: "No pricing tiers to compare" },
      { icon: Minus, text: "No trial that converts into a charge" },
      { icon: Minus, text: "If this ever changes, it will change here first" },
    ],
  },
];

/**
 * Every colour here is a token. It used to be whites and neutrals, because the
 * lamp behind these cards was pinned dark in both themes and a card on it had
 * to be hand-painted to stay legible. That pinning was the bug — the section
 * ignored the theme switch entirely — and with the lamp on `--background` the
 * hand-painting is not just unnecessary, it is what would break the light
 * theme: `text-white` on a near-white ground is an invisible heading.
 *
 * `CardSpotlight`'s own `--card-spotlight-*` tokens are theme-aware, so the
 * override that used to sit here is gone too.
 */
function PlanCard({ plan }: { plan: (typeof PLANS)[number] }) {
  return (
    <CardSpotlight
      // Smaller than the 350px default: these cards are ~340px wide at
      // `lg:grid-cols-3`, and a pool wider than the card lights the whole thing
      // uniformly, which is a hover state, not a spotlight.
      radius={260}
      contentClassName="flex flex-col p-6"
      className={`h-full ${
        plan.featured
          ? "ring-brand-violet/50 bg-card ring-1"
          : plan.available
            ? "bg-card/60"
            : "bg-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">{plan.name}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            plan.available
              ? "bg-brand-cyan/20 text-brand-cyan-ink"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {plan.note}
        </span>
      </div>

      <p
        className={`mt-4 text-3xl font-semibold tracking-tight ${
          plan.available ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {plan.price}
      </p>

      <p className="text-muted-foreground mt-3 text-sm text-pretty">
        {plan.summary}
      </p>

      <ul className="mt-6 space-y-3">
        {plan.lines.map((line) => (
          <li key={line.text} className="flex gap-3 text-sm">
            <line.icon
              className={`mt-0.5 size-4 shrink-0 ${
                // Full `--muted-foreground`, not `/60`: faded to 60% it scored
                // 2.61:1 on the light ground, under the 3:1 an icon needs.
                plan.available ? "text-brand-cyan-ink" : "text-muted-foreground"
              }`}
            />
            <span className="text-pretty">{line.text}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex-1 content-end">
        {plan.featured ? (
          // Plain `--primary` again. The white-on-dark override this used to
          // carry only existed because the ground was pinned dark; on a ground
          // that follows the theme it would be a white button on a white page.
          <Button asChild size="lg" className="w-full">
            <Link href="/sign-up">
              Create an account
              <ArrowRight />
            </Link>
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">
            {plan.available ? (
              <>
                See the{" "}
                <Link
                  href="/terms"
                  className="text-foreground underline underline-offset-4"
                >
                  terms
                </Link>{" "}
                for how third-party costs are handled.
              </>
            ) : (
              "Nothing to do here — there is nothing to buy."
            )}
          </p>
        )}
      </div>
    </CardSpotlight>
  );
}

export function LandingPricing() {
  return (
    <section id="pricing">
      <LampSection>
        <div className="mx-auto w-full max-w-6xl px-6 pb-20 sm:pb-28 lg:pb-36">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
              What it costs
            </h2>
            <p className="text-muted-foreground mt-4 text-base text-pretty sm:text-lg">
              Framecast cannot charge you. There is no payment system in it —
              the section below is the whole truth about money, including the
              part where there is nothing to sell.
            </p>
          </div>

          {/* The featured card used to sit inside a `BackgroundGradient`, whose
              conic border spins continuously. With CardSpotlight now tracking
              the pointer in this same section, that is two moving things
              competing over three cards on a 2-vCPU box — and the spinning
              border was doing the weaker job of the two. It is replaced by a
              static brand ring, so the only motion here is the lamp's one-shot
              entrance and the pool of light under whichever card you are
              actually pointing at. */}
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.name} plan={plan} />
            ))}
          </div>
        </div>
      </LampSection>
    </section>
  );
}
