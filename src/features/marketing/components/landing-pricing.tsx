import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CardSpotlight } from "@/components/ui/card-spotlight";
import { LampSection } from "@/components/ui/lamp";
import { PLANS, type PlanTier } from "@/lib/plans";

/**
 * The plans Framecast Studio sells. Prices and credit allowances come from
 * `@/lib/plans`, the same source the billing page and the credit checks read,
 * so this section cannot advertise a number the app does not charge.
 *
 * Every call to action goes to /sign-up: a new account starts on the trial,
 * and a paid plan is chosen from /billing once signed in, where checkout runs.
 */
const ORDER: PlanTier[] = ["TRIAL", "CREATOR", "PRO", "AGENCY"];

const COPY: Record<PlanTier, { summary: string; lines: string[]; featured?: boolean }> = {
  TRIAL: {
    summary: "Make your first videos and see what Framecast Studio does before paying anything.",
    lines: ["3 credits to try it", "Every format and footage style", "Small watermark on videos"],
  },
  CREATOR: {
    summary: "For one channel posting every week.",
    lines: ["20 credits a month", "20 Shorts or 4 long videos", "No watermark", "AI costs included"],
  },
  PRO: {
    summary: "For creators posting daily, and for marketing videos made from a brand's website.",
    lines: ["60 credits a month", "Marketing videos for brands (coming soon)", "No watermark", "AI costs included"],
    featured: true,
  },
  AGENCY: {
    summary: "For teams making videos for several clients.",
    lines: ["180 credits a month", "Client projects (coming soon)", "3 seats (coming soon)", "AI costs included"],
  },
};

/**
 * Every colour here is a token, so the cards follow the theme switch: the lamp
 * sits on `--background`, and `CardSpotlight`'s own `--card-spotlight-*`
 * tokens are theme-aware.
 */
function PlanCard({ tier }: { tier: PlanTier }) {
  const plan = PLANS[tier];
  const copy = COPY[tier];

  return (
    <CardSpotlight
      // Smaller than the 350px default: a pool wider than the card lights the
      // whole thing uniformly, which is a hover state, not a spotlight.
      radius={240}
      contentClassName="flex flex-col p-6"
      className={`h-full ${copy.featured ? "ring-brand-violet/50 bg-card ring-1" : "bg-card/60"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">{plan.name}</h3>
        {copy.featured && (
          <span className="bg-brand-cyan/20 text-brand-cyan-ink rounded-full px-2 py-0.5 text-[11px]">
            Most picked
          </span>
        )}
      </div>

      <p className="mt-4 text-3xl font-semibold tracking-tight">
        {plan.monthlyUsd === 0 ? "Free" : `$${plan.monthlyUsd}`}
        {plan.monthlyUsd > 0 && (
          <span className="text-muted-foreground text-base font-normal"> / month</span>
        )}
      </p>

      <p className="text-muted-foreground mt-3 text-sm text-pretty">{copy.summary}</p>

      <ul className="mt-6 space-y-3">
        {copy.lines.map((line) => (
          <li key={line} className="flex gap-3 text-sm">
            <Check className="text-brand-cyan-ink mt-0.5 size-4 shrink-0" />
            <span className="text-pretty">{line}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex-1 content-end">
        <Button asChild size="lg" variant={copy.featured ? "default" : "outline"} className="w-full">
          <Link href="/sign-up">
            {tier === "TRIAL" ? "Start free" : `Start with ${plan.name}`}
            <ArrowRight />
          </Link>
        </Button>
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
              One price a month, with the AI included. A credit is one Short; a long video is
              five.
            </p>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {ORDER.map((tier) => (
              <PlanCard key={tier} tier={tier} />
            ))}
          </div>

          <p className="text-muted-foreground mx-auto mt-8 max-w-2xl text-center text-xs text-pretty">
            1 credit = one Short up to 60 seconds. A long video = 5 credits. Unused credits
            don&apos;t roll over, and a video that fails to render gives its credits back. Prices
            in USD; Paddle, our reseller, adds any sales tax at checkout. See the{" "}
            <Link href="/terms" className="text-foreground underline underline-offset-4">
              terms
            </Link>
            .
          </p>
        </div>
      </LampSection>
    </section>
  );
}
