import Link from "next/link";
import { ArrowRight, Check, KeyRound, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { V2Reveal } from "@/features/marketing-v2/components/v2-reveal";
import StarBorder from "@/components/react-bits/StarBorder";
import { V2BandHeading } from "@/features/marketing-v2/components/v2-shell";

/**
 * Pricing, written against a codebase that has no payment system in it.
 *
 * There is no Stripe, no Paddle, no checkout, no subscription and no card on
 * file anywhere in this repository, so this section must not imply that
 * anything can be bought. That rules out a price, a "Buy now", a struck-through
 * "was", a countdown, a plan comparison implying a paid tier exists, and a
 * button that collects anything. The only call to action here goes to /sign-up.
 *
 * The third card is the important one. A page that says plainly "we cannot
 * take your money" is doing the opposite of what a deceptive page does, and it
 * costs nothing to say because it is true.
 *
 * v1 stands these cards inside an animated lamp that sweeps a beam across the
 * whole band on entry. v2 does not: this is the section a reviewer reads most
 * carefully, and a searchlight travelling over the words "there is nothing to
 * buy" is the wrong instinct entirely. The only motion here is React Bits'
 * StarBorder around the one button that does anything — the same treatment
 * the hero's primary action gets, and nowhere else on the page.
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
      {
        icon: Check,
        text: "The whole pipeline: script, narration, footage, render, publish",
      },
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

function PlanCard({ plan }: { plan: (typeof PLANS)[number] }) {
  return (
    <div
      className={`flex h-full flex-col rounded-2xl border p-6 ${
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
            {/* Full `--muted-foreground`, and the `-ink` cyan rather than the
                decorative one: an icon has a 3:1 floor and both of the values
                this replaced were under it on the light ground. */}
            <line.icon
              className={`mt-0.5 size-4 shrink-0 ${
                plan.available ? "text-brand-cyan-ink" : "text-muted-foreground"
              }`}
            />
            <span className="text-pretty">{line.text}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex-1 content-end">
        {plan.featured ? (
          // The same travelling light the hero puts around its primary
          // action, so the page has exactly two of them and they are the two
          // places it asks for the same thing.
          <StarBorder
            color="var(--brand-violet)"
            speed="5s"
            thickness={2}
            className="w-full"
            contentClassName="p-[2px]"
          >
            <Button asChild size="lg" className="w-full rounded-full">
              <Link href="/sign-up">
                Create an account
                <ArrowRight />
              </Link>
            </Button>
          </StarBorder>
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
    </div>
  );
}

export function V2Pricing() {
  return (
    <section id="pricing" className="border-t py-20 sm:py-28 lg:py-32">
      <div className="mx-auto w-full max-w-6xl px-6">
        <V2BandHeading
          eyebrow="Pricing"
          title="What it"
          accent="costs"
          align="center"
        >
          Framecast cannot charge you. There is no payment system in it — the
          section below is the whole truth about money, including the part
          where there is nothing to sell.
        </V2BandHeading>

        <V2Reveal className="mt-12 sm:mt-16">
          <div className="grid gap-4 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard key={plan.name} plan={plan} />
            ))}
          </div>
        </V2Reveal>
      </div>
    </section>
  );
}
