import Link from "next/link";
import { ArrowRight, Check, KeyRound, Minus } from "lucide-react";

import { BackgroundGradient } from "@/components/ui/background-gradient";
import { Button } from "@/components/ui/button";
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

function PlanCard({ plan }: { plan: (typeof PLANS)[number] }) {
  return (
    <div
      className={`flex h-full flex-col rounded-2xl border p-6 ${
        plan.featured
          ? "border-white/20 bg-white/10"
          : plan.available
            ? "border-white/10 bg-white/[0.04]"
            : "border-white/10 bg-transparent"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-white">{plan.name}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            plan.available
              ? "bg-brand-cyan/20 text-brand-cyan"
              : "bg-white/10 text-neutral-400"
          }`}
        >
          {plan.note}
        </span>
      </div>

      <p
        className={`mt-4 text-3xl font-semibold tracking-tight ${
          plan.available ? "text-white" : "text-neutral-500"
        }`}
      >
        {plan.price}
      </p>

      <p className="mt-3 text-sm text-pretty text-neutral-400">{plan.summary}</p>

      <ul className="mt-6 space-y-3">
        {plan.lines.map((line) => (
          <li key={line.text} className="flex gap-3 text-sm text-neutral-300">
            <line.icon
              className={`mt-0.5 size-4 shrink-0 ${
                plan.available ? "text-brand-cyan" : "text-neutral-600"
              }`}
            />
            <span className="text-pretty">{line.text}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex-1 content-end">
        {plan.featured ? (
          // The lamp's ground is dark in both themes, so this one button cannot
          // use `--primary`: in the light theme that is near-black, and a
          // near-black button on a near-black section is an invisible button.
          <Button
            asChild
            size="lg"
            className="w-full bg-white text-neutral-900 hover:bg-neutral-200"
          >
            <Link href="/sign-up">
              Create an account
              <ArrowRight />
            </Link>
          </Button>
        ) : (
          <p className="text-xs text-neutral-500">
            {plan.available ? (
              <>
                See the{" "}
                <Link href="/terms" className="text-neutral-300 underline underline-offset-4">
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

export function LandingPricing() {
  return (
    <section id="pricing">
      <LampSection>
        <div className="mx-auto w-full max-w-6xl px-6 pb-20 sm:pb-28 lg:pb-36">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]">
              What it costs
            </h2>
            <p className="mt-4 text-base text-pretty text-neutral-400 sm:text-lg">
              Framecast cannot charge you. There is no payment system in it —
              the section below is the whole truth about money, including the
              part where there is nothing to sell.
            </p>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((plan) =>
              plan.featured ? (
                <BackgroundGradient
                  key={plan.name}
                  containerClassName="rounded-2xl h-full"
                  className="h-full"
                >
                  <PlanCard plan={plan} />
                </BackgroundGradient>
              ) : (
                <div key={plan.name} className="p-1">
                  <PlanCard plan={plan} />
                </div>
              ),
            )}
          </div>
        </div>
      </LampSection>
    </section>
  );
}
