import "server-only";

import { InternalError } from "@/lib/errors";

const API_BASE = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
} as const;

export interface PaddleConfig {
  apiKey: string;
  environment: keyof typeof API_BASE;
}

/**
 * The one place Framecast Studio calls Paddle's REST API. Checkout itself
 * happens in the browser through Paddle.js, and plan changes arrive by
 * webhook, so the server only ever needs this: a link into the customer
 * portal (card, invoices, cancel), and a plan change.
 */
export class PaddleClient {
  constructor(
    private readonly config: PaddleConfig,
    private readonly fetchClient: typeof fetch = fetch,
  ) {}

  /**
   * Moves a subscription to another plan's price. Paddle charges (or
   * credits) the difference straight away and sends `subscription.updated`,
   * which is what tops up the credits — see BillingService.applyPaddleEvent.
   * The hosted portal cannot change plans, so this is the only way to.
   */
  async changePlan(subscriptionId: string, priceId: string): Promise<void> {
    const response = await this.fetchClient(
      `${API_BASE[this.config.environment]}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          items: [{ price_id: priceId, quantity: 1 }],
          proration_billing_mode: "prorated_immediately",
        }),
      },
    );

    if (!response.ok) {
      throw new InternalError(`Paddle refused the plan change (HTTP ${response.status}).`);
    }
  }

  async createPortalUrl(customerId: string, subscriptionId: string): Promise<string> {
    const response = await this.fetchClient(
      `${API_BASE[this.config.environment]}/customers/${encodeURIComponent(customerId)}/portal-sessions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ subscription_ids: [subscriptionId] }),
      },
    );

    if (!response.ok) {
      throw new InternalError(`Paddle refused the portal session (HTTP ${response.status}).`);
    }

    const body = (await response.json()) as {
      data?: { urls?: { general?: { overview?: string } } };
    };
    const url = body.data?.urls?.general?.overview;
    if (!url) throw new InternalError("Paddle returned no portal link.");
    return url;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}
