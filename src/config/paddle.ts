import "server-only";

import { env } from "@/config/env";
import type { PlanTier } from "@/lib/plans";

/** The Paddle Price id for each paid tier, from env. */
export function paddlePrices(): Partial<Record<PlanTier, string>> {
  return {
    CREATOR: env.PADDLE_PRICE_CREATOR,
    PRO: env.PADDLE_PRICE_PRO,
    AGENCY: env.PADDLE_PRICE_AGENCY,
  };
}
