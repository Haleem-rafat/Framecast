/**
 * What Framecast Studio sells. The single source for prices and allowances:
 * the landing page, the billing page and the credit checks all read this, so
 * a price changes here or nowhere. Paddle holds the same amounts as Prices;
 * the ids come from env (PADDLE_PRICE_*), never from this file.
 */
export type PlanTier = "TRIAL" | "CREATOR" | "PRO" | "AGENCY";

export interface Plan {
  tier: PlanTier;
  name: string;
  monthlyUsd: number;
  /** Granted once for TRIAL, every billing period for the paid tiers. */
  credits: number;
  watermark: boolean;
  marketing: boolean;
  seats: number;
}

export const PLANS: Record<PlanTier, Plan> = {
  TRIAL: { tier: "TRIAL", name: "Trial", monthlyUsd: 0, credits: 3, watermark: true, marketing: false, seats: 1 },
  CREATOR: { tier: "CREATOR", name: "Creator", monthlyUsd: 29, credits: 20, watermark: false, marketing: false, seats: 1 },
  PRO: { tier: "PRO", name: "Pro", monthlyUsd: 79, credits: 60, watermark: false, marketing: true, seats: 1 },
  AGENCY: { tier: "AGENCY", name: "Agency", monthlyUsd: 199, credits: 180, watermark: false, marketing: true, seats: 3 },
};

/** Drawn on trial renders; see `buildAssembleArgs`. */
export const TRIAL_WATERMARK = "Made with Framecast Studio";

export const PAID_TIERS: PlanTier[] = ["CREATOR", "PRO", "AGENCY"];

/** One credit is one Short; a long video is five. */
export function creditsFor(format: "LANDSCAPE" | "VERTICAL"): number {
  return format === "VERTICAL" ? 1 : 5;
}

/** An account's credits as the UI sees them. */
export interface Wallet {
  credits: number;
  /** Operator accounts: never charged. */
  unlimited: boolean;
}

export function outOfCredits(wallet: Wallet, cost: number): boolean {
  return !wallet.unlimited && wallet.credits < cost;
}

export function tierForPriceId(
  priceId: string,
  prices: Partial<Record<PlanTier, string>>,
): PlanTier | null {
  if (!priceId) return null;
  const hit = (Object.entries(prices) as [PlanTier, string | undefined][]).find(
    ([, id]) => id === priceId,
  );
  return hit ? hit[0] : null;
}
