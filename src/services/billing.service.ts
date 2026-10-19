import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/config/env";
import type { Prisma } from "@/generated/prisma/client";
import type { SubscriptionStatus } from "@/generated/prisma/enums";
import { PaymentRequiredError } from "@/lib/errors";
import { PLANS, type PlanTier, tierForPriceId } from "@/lib/plans";
import { prisma } from "@/lib/prisma";

export interface CheckoutCustomData {
  userId?: string;
  sig?: string;
}

export interface PaddleSubscriptionData {
  id: string;
  status: string;
  customer_id: string;
  items: { price: { id: string } }[];
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: string } | null;
  custom_data: CheckoutCustomData | null;
}

export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: PaddleSubscriptionData;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  paused: "PAUSED",
  canceled: "CANCELED",
};

const isLive = (status: SubscriptionStatus) => status !== "CANCELED" && status !== "PAUSED";

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

/** Serialises every credit movement for one user: charges, refunds, grants. */
const lockUser = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

const signUser = (userId: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`paddle-checkout:${userId}`).digest("hex");

/**
 * Credits and plans. Every credit movement is a row in `credit_entry`, keyed
 * by `(userId, ref)`, and every write for one user runs under one advisory
 * lock — so Paddle repeating a webhook, two approvals at once or a double
 * click can never move credits twice.
 *
 * A video is "paid for" while the sum of its CHARGE and REFUND rows is below
 * zero. A failed render refunds it; running it again charges it again. Refs
 * carry a counter (`charge:<videoId>:<n>`) so that cycle can repeat.
 */
export class BillingService {
  async balance(userId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
    const { _sum } = await db.creditLedger.aggregate({ where: { userId }, _sum: { delta: true } });
    return _sum.delta ?? 0;
  }

  /**
   * Operators run the platform and its own channels; billing them would put
   * a trial watermark on the owner's videos and stop their automations after
   * three credits. They are never charged and never watermarked.
   */
  async isUnlimited(userId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === "OPERATOR";
  }

  /** Whether `credits` could be spent right now. Checked before paid work starts. */
  async canAfford(userId: string, credits: number): Promise<boolean> {
    return (await this.isUnlimited(userId)) || (await this.balance(userId)) >= credits;
  }

  async summary(userId: string) {
    const [subscription, balance, unlimited] = await Promise.all([
      prisma.subscription.findUnique({ where: { userId } }),
      this.balance(userId),
      this.isUnlimited(userId),
    ]);
    const tier: PlanTier = subscription && isLive(subscription.status) ? subscription.tier : "TRIAL";
    return {
      tier,
      status: subscription?.status ?? null,
      balance,
      periodEnd: subscription?.periodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      paddleSubscriptionId: subscription?.paddleSubscriptionId ?? null,
      unlimited,
      watermark: !unlimited && PLANS[tier].watermark,
    };
  }

  /**
   * What the browser sends to Paddle as `customData`. Paddle.js runs in the
   * buyer's browser, so a bare user id there could be anyone's; the signature
   * is what lets the webhook trust it.
   */
  checkoutCustomData(userId: string): { userId: string; sig: string } {
    return { userId, sig: signUser(userId) };
  }

  async grantTrial(userId: string): Promise<void> {
    try {
      await prisma.creditLedger.create({
        data: { userId, delta: PLANS.TRIAL.credits, reason: "GRANT", ref: "trial", note: "Trial" },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /**
   * Spends credits for a video inside the caller's transaction, so the status
   * change and the charge commit or roll back together. Nothing happens when
   * the video is already paid for.
   */
  async charge(
    tx: Prisma.TransactionClient,
    userId: string,
    videoId: string,
    credits: number,
  ): Promise<void> {
    if (await this.isUnlimited(userId, tx)) return;
    await lockUser(tx, userId);
    if ((await this.videoNet(tx, userId, videoId)) < 0) return;

    const balance = await this.balance(userId, tx);
    if (balance < credits) {
      throw new PaymentRequiredError(
        `This needs ${credits} credit${credits === 1 ? "" : "s"} and you have ${balance}. Choose a plan on the Billing page.`,
      );
    }
    const n = await tx.creditLedger.count({ where: { userId, videoId, reason: "CHARGE" } });
    await tx.creditLedger.create({
      data: { userId, videoId, delta: -credits, reason: "CHARGE", ref: `charge:${videoId}:${n}` },
    });
  }

  /** Gives back what the video is currently paid for. False when there is nothing to give back. */
  async refund(userId: string, videoId: string, note = "Render failed"): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const net = await this.videoNet(tx, userId, videoId);
      if (net >= 0) return false;
      const n = await tx.creditLedger.count({ where: { userId, videoId, reason: "REFUND" } });
      await tx.creditLedger.create({
        data: { userId, videoId, delta: -net, reason: "REFUND", ref: `refund:${videoId}:${n}`, note },
      });
      return true;
    });
  }

  async applyPaddleEvent(
    event: PaddleEvent,
    prices: Partial<Record<PlanTier, string>>,
  ): Promise<"applied" | "ignored"> {
    if (!event.event_type.startsWith("subscription.")) return "ignored";
    const data = event.data;
    const userId = this.trustedUserId(data.custom_data);
    const tier = tierForPriceId(data.items[0]?.price.id ?? "", prices);
    const status = STATUS[data.status];
    if (!userId || !tier || !status) return "ignored";
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return "ignored";

    const at = new Date(event.occurred_at);
    const period = data.current_billing_period;

    return prisma.$transaction(async (tx) => {
      // Under the user's lock, so two events for one user apply one at a
      // time and the newest `occurred_at` always ends up stored.
      await lockUser(tx, userId);
      const existing = await tx.subscription.findUnique({ where: { userId } });
      if (existing && existing.lastEventAt >= at) return "ignored";
      // A late cancel for a subscription the user has already replaced must
      // not take down the one they are paying for now.
      if (
        existing &&
        existing.paddleSubscriptionId !== data.id &&
        isLive(existing.status) &&
        !isLive(status)
      ) {
        return "ignored";
      }

      const fields = {
        tier,
        status,
        paddleSubscriptionId: data.id,
        paddleCustomerId: data.customer_id,
        periodStart: period ? new Date(period.starts_at) : (existing?.periodStart ?? null),
        periodEnd: period ? new Date(period.ends_at) : (existing?.periodEnd ?? null),
        cancelAtPeriodEnd: data.scheduled_change?.action === "cancel",
        lastEventAt: at,
      };
      await tx.subscription.upsert({
        where: { userId },
        create: { userId, ...fields },
        update: fields,
      });

      if (!isLive(status)) {
        await this.expirePlanLeftover(tx, userId, `expire:${data.id}:end`);
        return "applied";
      }
      if (!period || (status !== "ACTIVE" && status !== "TRIALING")) return "applied";

      const key = `${data.id}:${period.starts_at}`;
      const grantRef = `period:${key}`;
      const granted = await tx.creditLedger.findUnique({
        where: { userId_ref: { userId, ref: grantRef } },
      });

      if (granted) {
        // Same billing period, new price: an upgrade tops the period up to
        // the new plan's allowance. A downgrade takes nothing back.
        const periodGrants = await tx.creditLedger.aggregate({
          where: {
            userId,
            reason: "GRANT",
            OR: [{ ref: grantRef }, { ref: { startsWith: `upgrade:${key}:` } }],
          },
          _sum: { delta: true },
        });
        const difference = PLANS[tier].credits - (periodGrants._sum.delta ?? 0);
        const upgradeRef = `upgrade:${key}:${tier}`;
        const upgraded = await tx.creditLedger.findUnique({
          where: { userId_ref: { userId, ref: upgradeRef } },
        });
        if (difference > 0 && !upgraded) {
          await tx.creditLedger.create({
            data: { userId, delta: difference, reason: "GRANT", ref: upgradeRef, note: `Upgraded to ${PLANS[tier].name}` },
          });
        }
        return "applied";
      }

      // A new billing period, or a new subscription: what is left of the
      // previous plan's credits expires, then the new allowance arrives.
      await this.expirePlanLeftover(tx, userId, `expire:${key}`);
      await tx.creditLedger.create({
        data: { userId, delta: PLANS[tier].credits, reason: "GRANT", ref: grantRef, note: `${PLANS[tier].name} plan` },
      });
      return "applied";
    });
  }

  /** Platform AI keys are for people who are paying, or still have credits to spend. */
  async usesPlatformKeys(userId: string): Promise<boolean> {
    if ((await this.balance(userId)) > 0 || (await this.isUnlimited(userId))) return true;
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: { status: true },
    });
    return subscription?.status === "ACTIVE" || subscription?.status === "TRIALING";
  }

  /**
   * What the Billing page charts: credits spent per day over the last `days`
   * (UTC days, net of refunds, empty days included so the chart has no
   * gaps), and how many Shorts and long videos are currently paid for.
   */
  async usage(userId: string, days = 30, now = new Date()) {
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = new Date(end - (days - 1) * 86_400_000);
    const [inWindow, bySize] = await Promise.all([
      prisma.creditLedger.findMany({
        where: { userId, reason: { in: ["CHARGE", "REFUND"] }, createdAt: { gte: start } },
        select: { delta: true, createdAt: true },
      }),
      prisma.creditLedger.groupBy({
        by: ["reason", "delta"],
        where: { userId, reason: { in: ["CHARGE", "REFUND"] } },
        _count: { _all: true },
      }),
    ]);

    const spentByDay = new Map<string, number>();
    for (const row of inWindow) {
      const date = row.createdAt.toISOString().slice(0, 10);
      spentByDay.set(date, (spentByDay.get(date) ?? 0) - row.delta);
    }
    const series = Array.from({ length: days }, (_, i) => {
      const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return { date, spent: Math.max(0, spentByDay.get(date) ?? 0) };
    });

    // A charge of 1 is a Short and of 5 a long video; each refund cancels one.
    const count = (size: number) =>
      bySize
        .filter((group) => Math.abs(group.delta) === size)
        .reduce((sum, group) => sum + (group.reason === "CHARGE" ? 1 : -1) * group._count._all, 0);

    return {
      days: series,
      spentInWindow: series.reduce((sum, day) => sum + day.spent, 0),
      shorts: Math.max(0, count(1)),
      longVideos: Math.max(0, count(5)),
    };
  }

  history(userId: string, limit = 30) {
    return prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, delta: true, reason: true, note: true, videoId: true, createdAt: true },
    });
  }

  private trustedUserId(custom: CheckoutCustomData | null): string | null {
    if (!custom?.userId || !custom.sig || !/^[0-9a-f]{64}$/i.test(custom.sig)) return null;
    const expected = Buffer.from(signUser(custom.userId), "hex");
    const given = Buffer.from(custom.sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected) ? custom.userId : null;
  }

  /** CHARGE + REFUND for one video: negative while the video is paid for. */
  private async videoNet(tx: Prisma.TransactionClient, userId: string, videoId: string) {
    const { _sum } = await tx.creditLedger.aggregate({
      where: { userId, videoId, reason: { in: ["CHARGE", "REFUND"] } },
      _sum: { delta: true },
    });
    return _sum.delta ?? 0;
  }

  /**
   * Expires what is left of the most recent plan grant (and any upgrade on
   * top of it). Trial credits and refunds of older charges are not plan
   * credits, so the amount is capped at what the plan granted.
   */
  private async expirePlanLeftover(
    tx: Prisma.TransactionClient,
    userId: string,
    ref: string,
  ): Promise<void> {
    if (await tx.creditLedger.findUnique({ where: { userId_ref: { userId, ref } } })) return;
    const previous = await tx.creditLedger.findFirst({
      where: { userId, reason: "GRANT", ref: { startsWith: "period:" } },
      orderBy: { createdAt: "desc" },
    });
    if (!previous) return;

    const since = { userId, createdAt: { gte: previous.createdAt } };
    const key = previous.ref.slice("period:".length);
    const [planned, movements] = await Promise.all([
      tx.creditLedger.aggregate({
        where: {
          ...since,
          reason: "GRANT",
          OR: [{ ref: previous.ref }, { ref: { startsWith: `upgrade:${key}:` } }],
        },
        _sum: { delta: true },
      }),
      tx.creditLedger.aggregate({
        // The EXPIRE written just before `previous` (ref `expire:<key>`) can
        // share its timestamp and belongs to the period before, not this one.
        where: {
          ...since,
          reason: { in: ["CHARGE", "REFUND", "EXPIRE"] },
          NOT: { ref: `expire:${key}` },
        },
        _sum: { delta: true },
      }),
    ]);
    const plan = planned._sum.delta ?? 0;
    const leftover = Math.max(
      0,
      Math.min(plan + (movements._sum.delta ?? 0), plan, await this.balance(userId, tx)),
    );
    if (leftover > 0) {
      await tx.creditLedger.create({
        data: { userId, delta: -leftover, reason: "EXPIRE", ref, note: "Unused plan credits" },
      });
    }
  }
}

export const billingService = new BillingService();

