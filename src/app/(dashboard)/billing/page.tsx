import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { env } from "@/config/env";
import { paddlePrices } from "@/config/paddle";
import { CreditHistory } from "@/features/billing/components/credit-history";
import { ManageBillingButton } from "@/features/billing/components/manage-billing-button";
import { PlanCards } from "@/features/billing/components/plan-cards";
import { PLANS } from "@/lib/plans";
import { requireUser } from "@/server/session";
import { billingService } from "@/services/billing.service";

export const metadata: Metadata = { title: "Billing" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export default async function BillingPage() {
  const user = await requireUser();
  const [summary, history] = await Promise.all([
    billingService.summary(user.id),
    billingService.history(user.id),
  ]);
  const hasSubscription = summary.status !== null && summary.status !== "CANCELED";

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan and credits. A Short uses 1 credit, a long video 5."
        actions={hasSubscription ? <ManageBillingButton /> : undefined}
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="bg-card rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">Plan</p>
          <p className="text-2xl font-semibold">
            {summary.unlimited ? "Unlimited" : PLANS[summary.tier].name}
          </p>
          {summary.unlimited && (
            <p className="text-muted-foreground text-sm">Operator accounts are never charged.</p>
          )}
          {summary.status === "PAST_DUE" && (
            <p className="text-destructive text-sm">Payment failed. Update your card in Manage billing.</p>
          )}
        </div>
        <div className="bg-card rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">Credits left</p>
          <p className="text-2xl font-semibold tabular-nums">{summary.balance}</p>
        </div>
        <div className="bg-card rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">
            {summary.cancelAtPeriodEnd ? "Cancels on" : hasSubscription ? "Renews on" : "Renews"}
          </p>
          <p className="text-2xl font-semibold">
            {hasSubscription && summary.periodEnd ? dateFormat.format(summary.periodEnd) : "—"}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Plans</h2>
        <PlanCards
          current={summary.tier}
          hasSubscription={hasSubscription}
          prices={paddlePrices()}
          clientToken={env.PADDLE_CLIENT_TOKEN ?? null}
          environment={env.PADDLE_ENV}
          email={user.email}
          customData={billingService.checkoutCustomData(user.id)}
        />
        <p className="text-muted-foreground text-xs">
          Prices in USD. Unused credits don&apos;t roll over to the next month. If a video fails
          to render, its credits come back. Payments are handled by Paddle, our reseller, which
          adds any sales tax at checkout.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Credit history</h2>
        <CreditHistory rows={history} />
      </section>
    </>
  );
}
