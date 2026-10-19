"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { run, type ActionResult } from "@/actions/action-result";
import { env } from "@/config/env";
import { paddlePrices } from "@/config/paddle";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/session";
import { PaddleClient } from "@/services/paddle.client";

/** A one-time link into Paddle's customer portal: card, plan, invoices, cancel. */
export async function openBillingPortalAction(): Promise<ActionResult<{ url: string }>> {
  return run(async () => {
    const user = await requireUser();
    if (!env.PADDLE_API_KEY) throw new ValidationError("Billing is not configured yet.");

    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { paddleCustomerId: true, paddleSubscriptionId: true },
    });
    if (!subscription) throw new NotFoundError("Subscription");

    const client = new PaddleClient({ apiKey: env.PADDLE_API_KEY, environment: env.PADDLE_ENV });
    return {
      url: await client.createPortalUrl(
        subscription.paddleCustomerId,
        subscription.paddleSubscriptionId,
      ),
    };
  });
}

const planSchema = z.enum(["CREATOR", "PRO", "AGENCY"]);

/**
 * Moves a subscriber to another paid plan. Paddle bills the difference now
 * and its webhook tops up the credits; nothing here writes a plan itself.
 */
export async function changePlanAction(input: unknown): Promise<ActionResult<null>> {
  return run(async () => {
    const user = await requireUser();
    const tier = planSchema.parse(input);
    const priceId = paddlePrices()[tier];
    if (!env.PADDLE_API_KEY || !priceId) throw new ValidationError("Billing is not configured yet.");

    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { paddleSubscriptionId: true, status: true, tier: true },
    });
    if (!subscription || subscription.status === "CANCELED") throw new NotFoundError("Subscription");
    if (subscription.tier === tier) throw new ValidationError(`You are already on ${tier.toLowerCase()}.`);

    const client = new PaddleClient({ apiKey: env.PADDLE_API_KEY, environment: env.PADDLE_ENV });
    await client.changePlan(subscription.paddleSubscriptionId, priceId);
    revalidatePath("/billing");
    return null;
  });
}
