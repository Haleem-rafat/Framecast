"use client";

import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { changePlanAction } from "@/actions/billing.action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PAID_TIERS, PLANS, type PlanTier } from "@/lib/plans";
import { cn } from "@/lib/utils";

interface PaddleGlobal {
  Environment: { set: (environment: "sandbox") => void };
  Initialize: (options: { token: string }) => void;
  Checkout: {
    open: (options: {
      items: { priceId: string; quantity: number }[];
      customer?: { email: string };
      customData?: Record<string, string>;
      settings?: { displayMode: "overlay"; variant: "one-page"; successUrl: string };
    }) => void;
  };
}

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
  }
}

const PADDLE_JS = "https://cdn.paddle.com/paddle/v2/paddle.js";

/** Loads Paddle.js once, on the first click, so the page itself stays light. */
let loading: Promise<PaddleGlobal> | null = null;
function loadPaddle(token: string, environment: "sandbox" | "production"): Promise<PaddleGlobal> {
  loading ??= new Promise<PaddleGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PADDLE_JS;
    script.async = true;
    script.onload = () => {
      const paddle = window.Paddle;
      if (!paddle) return reject(new Error("Paddle.js did not load."));
      if (environment === "sandbox") paddle.Environment.set("sandbox");
      paddle.Initialize({ token });
      resolve(paddle);
    };
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not reach Paddle. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const LINES: Record<PlanTier, string[]> = {
  TRIAL: ["3 credits to try it", "Small watermark on videos"],
  CREATOR: ["20 credits a month", "20 Shorts or 4 long videos", "No watermark", "AI costs included"],
  PRO: ["60 credits a month", "Marketing videos for brands", "No watermark", "AI costs included"],
  AGENCY: ["180 credits a month", "Client projects", "3 seats (coming soon)", "AI costs included"],
};

export function PlanCards({
  current,
  hasSubscription,
  prices,
  clientToken,
  environment,
  email,
  customData,
}: {
  current: PlanTier;
  hasSubscription: boolean;
  prices: Partial<Record<PlanTier, string>>;
  clientToken: string | null;
  environment: "sandbox" | "production";
  email: string;
  /** Signed on the server; the webhook only trusts a user id carrying it. */
  customData: { userId: string; sig: string };
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PlanTier | null>(null);

  async function switchTo(tier: PlanTier) {
    setPending(tier);
    const result = await changePlanAction(tier);
    setPending(null);
    if (!result.ok) {
      toast.error("Could not change plan", { description: result.error.message });
      return;
    }
    toast.success(`Switching to ${PLANS[tier].name}`, {
      description: "Paddle charges the difference now. Your credits update in a moment.",
    });
    // The webhook lands a moment after Paddle accepts the change.
    setTimeout(() => router.refresh(), 4000);
  }

  async function choose(tier: PlanTier) {
    const priceId = prices[tier];
    if (!clientToken || !priceId) {
      toast.error("Payments are not switched on yet.");
      return;
    }
    setPending(tier);
    try {
      const paddle = await loadPaddle(clientToken, environment);
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customer: { email },
        // The webhook maps the subscription back to this account by this id.
        customData,
        // One page instead of Paddle's multi-step form; back to this page,
        // flagged, once the payment goes through.
        settings: {
          displayMode: "overlay",
          variant: "one-page",
          successUrl: `${window.location.origin}/billing?checkout=success`,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open checkout.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PAID_TIERS.map((tier) => {
        const plan = PLANS[tier];
        const isCurrent = hasSubscription && current === tier;
        return (
          <div
            key={tier}
            className={cn(
              "bg-card flex flex-col gap-4 rounded-xl border p-5",
              isCurrent && "border-primary ring-primary ring-1",
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold">{plan.name}</h3>
              {isCurrent && <Badge>Your plan</Badge>}
            </div>
            <p>
              <span className="text-3xl font-semibold tabular-nums">${plan.monthlyUsd}</span>
              <span className="text-muted-foreground text-sm"> / month</span>
            </p>
            <ul className="text-muted-foreground flex-1 space-y-1.5 text-sm">
              {LINES[tier].map((line) => (
                <li key={line} className="flex gap-2">
                  <Check aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
                  {line}
                </li>
              ))}
            </ul>
            {/* A subscriber switches the subscription they have, which Paddle
              * prorates; a second checkout would be a second subscription. */}
            {hasSubscription ? (
              isCurrent ? (
                <p className="text-muted-foreground text-xs">Active now.</p>
              ) : (
                <Button variant="outline" onClick={() => switchTo(tier)} disabled={pending !== null}>
                  {pending === tier && <Loader2 className="animate-spin" />}
                  Switch to {plan.name}
                </Button>
              )
            ) : (
              <Button onClick={() => choose(tier)} disabled={pending !== null}>
                {pending === tier && <Loader2 className="animate-spin" />}
                Choose {plan.name}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
