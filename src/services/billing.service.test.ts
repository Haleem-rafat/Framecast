import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentRequiredError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { billingService, type PaddleEvent } from "@/services/billing.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

const PRICES = { CREATOR: "pri_creator", PRO: "pri_pro", AGENCY: "pri_agency" };
let userId: string;

beforeEach(async () => {
  userId = await createTestUser("billing");
});
afterEach(() => deleteTestUser(userId));

function event(
  over: Partial<PaddleEvent["data"]> & { type?: string; at?: string; start?: string } = {},
): PaddleEvent {
  const start = over.start ?? "2026-11-01T00:00:00Z";
  return {
    event_id: `evt_${randomUUID()}`,
    event_type: over.type ?? "subscription.created",
    occurred_at: over.at ?? "2026-11-01T00:00:01Z",
    data: {
      id: over.id ?? `sub_${userId}`,
      status: over.status ?? "active",
      customer_id: "ctm_1",
      items: over.items ?? [{ price: { id: "pri_creator" } }],
      current_billing_period:
        over.current_billing_period === null
          ? null
          : { starts_at: start, ends_at: "2026-12-01T00:00:00Z" },
      scheduled_change: over.scheduled_change ?? null,
      custom_data: over.custom_data ?? billingService.checkoutCustomData(userId),
    },
  };
}

const charge = (videoId: string, credits: number) =>
  prisma.$transaction((tx) => billingService.charge(tx, userId, videoId, credits));

describe("billingService credits", () => {
  it("grants the trial once", async () => {
    await billingService.grantTrial(userId);
    await billingService.grantTrial(userId);
    expect(await billingService.balance(userId)).toBe(3);
    const summary = await billingService.summary(userId);
    expect(summary.tier).toBe("TRIAL");
    expect(summary.watermark).toBe(true);
  });

  it("charges, refuses when short, and refunds once", async () => {
    await billingService.grantTrial(userId);
    const v1 = randomUUID();
    await charge(v1, 1);
    await charge(v1, 1); // same video, still paid for: idempotent
    expect(await billingService.balance(userId)).toBe(2);
    await expect(charge(randomUUID(), 5)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(await billingService.refund(userId, v1)).toBe(true);
    expect(await billingService.refund(userId, v1)).toBe(false);
    expect(await billingService.refund(userId, randomUUID())).toBe(false); // never charged
    expect(await billingService.balance(userId)).toBe(3);
  });

  it("a refunded video is charged again when it runs again, and refunded again if it fails", async () => {
    await billingService.grantTrial(userId);
    const video = randomUUID();
    await charge(video, 1);
    await billingService.refund(userId, video);
    await charge(video, 1);
    expect(await billingService.balance(userId)).toBe(2);
    expect(await billingService.refund(userId, video)).toBe(true);
    expect(await billingService.balance(userId)).toBe(3);
  });

  it("two approvals racing for the last credit: one wins", async () => {
    await prisma.creditLedger.create({ data: { userId, delta: 1, reason: "GRANT", ref: "trial" } });
    const results = await Promise.allSettled([charge(randomUUID(), 1), charge(randomUUID(), 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await billingService.balance(userId)).toBe(0);
  });

  it("canAfford respects the balance and unlimited accounts", async () => {
    await billingService.grantTrial(userId);
    expect(await billingService.canAfford(userId, 3)).toBe(true);
    expect(await billingService.canAfford(userId, 5)).toBe(false);
    await prisma.user.update({ where: { id: userId }, data: { role: "OPERATOR" } });
    expect(await billingService.canAfford(userId, 500)).toBe(true);
  });

  it("operators are never charged and never watermarked", async () => {
    await prisma.user.update({ where: { id: userId }, data: { role: "OPERATOR" } });
    await charge(randomUUID(), 5); // no credits at all, still fine
    expect(await billingService.balance(userId)).toBe(0);
    const summary = await billingService.summary(userId);
    expect(summary.unlimited).toBe(true);
    expect(summary.watermark).toBe(false);
    expect(await billingService.usesPlatformKeys(userId)).toBe(true);
  });
});

describe("billingService.applyPaddleEvent", () => {
  it("grants a period's credits once, even when Paddle repeats itself", async () => {
    await billingService.grantTrial(userId);
    expect(await billingService.applyPaddleEvent(event(), PRICES)).toBe("applied");
    await billingService.applyPaddleEvent(
      event({ type: "subscription.updated", at: "2026-11-01T00:00:02Z" }),
      PRICES,
    );
    // trial credits stay; the plan's 20 are added once
    expect(await billingService.balance(userId)).toBe(23);
    expect((await billingService.summary(userId)).tier).toBe("CREATOR");
    expect(await billingService.usesPlatformKeys(userId)).toBe(true);
  });

  it("a new period expires the old plan credits and grants the new allowance", async () => {
    await billingService.applyPaddleEvent(event(), PRICES);
    await charge(randomUUID(), 5); // 15 left
    await billingService.applyPaddleEvent(
      event({ type: "subscription.updated", start: "2026-12-01T00:00:00Z", at: "2026-12-01T00:00:01Z" }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(20);
  });

  it("an upgrade in the middle of a period adds the difference", async () => {
    await billingService.applyPaddleEvent(event(), PRICES); // Creator: 20
    await charge(randomUUID(), 5); // 15
    await billingService.applyPaddleEvent(
      event({ type: "subscription.updated", items: [{ price: { id: "pri_pro" } }], at: "2026-11-10T00:00:00Z" }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(55); // + (60 - 20)
    // the next month is a plain Pro month, and the old credits expire
    await billingService.applyPaddleEvent(
      event({
        type: "subscription.updated",
        items: [{ price: { id: "pri_pro" } }],
        start: "2026-12-01T00:00:00Z",
        at: "2026-12-01T00:00:01Z",
      }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(60);
  });

  it("cancelling expires what is left of the plan; trial credits stay", async () => {
    await billingService.grantTrial(userId); // 3
    await billingService.applyPaddleEvent(event(), PRICES); // +20
    await billingService.applyPaddleEvent(
      event({
        type: "subscription.canceled",
        status: "canceled",
        current_billing_period: null,
        at: "2026-12-01T00:00:05Z",
      }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(3);
    expect((await billingService.summary(userId)).tier).toBe("TRIAL");
  });

  it("a cancelled user with nothing left loses the platform keys", async () => {
    await billingService.applyPaddleEvent(event(), PRICES);
    await billingService.applyPaddleEvent(
      event({ type: "subscription.canceled", status: "canceled", current_billing_period: null, at: "2026-12-01T00:00:05Z" }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(0);
    expect(await billingService.usesPlatformKeys(userId)).toBe(false);
  });

  it("a new subscription does not stack on the old one's leftover", async () => {
    await billingService.applyPaddleEvent(event({ id: "sub_a" }), PRICES); // 20
    await billingService.applyPaddleEvent(
      event({ id: "sub_b", items: [{ price: { id: "pri_pro" } }], start: "2026-11-15T00:00:00Z", at: "2026-11-15T00:00:00Z" }),
      PRICES,
    );
    expect(await billingService.balance(userId)).toBe(60);
  });

  it("ignores an event older than the one already applied, whatever its subscription", async () => {
    await billingService.applyPaddleEvent(
      event({ items: [{ price: { id: "pri_pro" } }], at: "2026-11-02T00:00:00Z" }),
      PRICES,
    );
    expect(
      await billingService.applyPaddleEvent(event({ type: "subscription.updated", at: "2026-11-01T12:00:00Z" }), PRICES),
    ).toBe("ignored");
    expect(
      await billingService.applyPaddleEvent(event({ id: "sub_old", at: "2026-10-01T00:00:00Z" }), PRICES),
    ).toBe("ignored");
    expect((await billingService.summary(userId)).tier).toBe("PRO");
  });

  it("a cancel for a subscription that is not the current one leaves the live plan alone", async () => {
    await billingService.applyPaddleEvent(event({ id: "sub_live", items: [{ price: { id: "pri_pro" } }] }), PRICES);
    expect(
      await billingService.applyPaddleEvent(
        event({ id: "sub_dead", type: "subscription.canceled", status: "canceled", current_billing_period: null, at: "2026-11-05T00:00:00Z" }),
        PRICES,
      ),
    ).toBe("ignored");
    const summary = await billingService.summary(userId);
    expect(summary.tier).toBe("PRO");
    expect(summary.status).toBe("ACTIVE");
  });

  it("refuses custom data that was not signed by this server", async () => {
    expect(
      await billingService.applyPaddleEvent(event({ custom_data: { userId, sig: "0".repeat(64) } }), PRICES),
    ).toBe("ignored");
    expect(await billingService.applyPaddleEvent(event({ custom_data: { userId } }), PRICES)).toBe("ignored");
    expect(await prisma.subscription.findUnique({ where: { userId } })).toBeNull();
  });

  it("an event for an unknown price or user is ignored", async () => {
    expect(
      await billingService.applyPaddleEvent(event({ items: [{ price: { id: "pri_x" } }] }), PRICES),
    ).toBe("ignored");
    const strangerId = randomUUID();
    expect(
      await billingService.applyPaddleEvent(
        event({ custom_data: billingService.checkoutCustomData(strangerId) }),
        PRICES,
      ),
    ).toBe("ignored");
  });
});

describe("billingService.usage", () => {
  it("adds up credits spent per day, net of refunds, with empty days kept", async () => {
    await prisma.creditLedger.create({ data: { userId, delta: 50, reason: "GRANT", ref: "g" } });
    const day = (offset: number) => new Date(Date.UTC(2026, 9, 19 - offset, 12));
    await prisma.creditLedger.createMany({
      data: [
        { userId, delta: -1, reason: "CHARGE", ref: "c1", createdAt: day(0) },
        { userId, delta: -5, reason: "CHARGE", ref: "c2", createdAt: day(0) },
        { userId, delta: -1, reason: "CHARGE", ref: "c3", createdAt: day(2) },
        { userId, delta: 1, reason: "REFUND", ref: "r3", createdAt: day(2) },
        { userId, delta: -1, reason: "CHARGE", ref: "c4", createdAt: day(40) },
      ],
    });

    const usage = await billingService.usage(userId, 7, day(0));

    expect(usage.days).toHaveLength(7);
    expect(usage.days.at(-1)).toEqual({ date: "2026-10-19", spent: 6 });
    expect(usage.days.at(-3)).toEqual({ date: "2026-10-17", spent: 0 }); // refunded
    expect(usage.days[0]).toEqual({ date: "2026-10-13", spent: 0 });
    expect(usage.spentInWindow).toBe(6);
    // Every video still paid for, by size: refunded runs do not count.
    expect(usage.shorts).toBe(2);
    expect(usage.longVideos).toBe(1);
  });
});

