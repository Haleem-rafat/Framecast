import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { billingService } from "@/services/billing.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

import { POST } from "./route";

// The route reads `env` at request time, so the test sets the Paddle values
// on the parsed object directly and restores them afterwards.
const SECRET = "whsec_test";
const saved = { ...env };
let userId: string;

beforeEach(async () => {
  Object.assign(env, {
    PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_PRICE_CREATOR: "pri_creator",
    PADDLE_PRICE_PRO: "pri_pro",
    PADDLE_PRICE_AGENCY: "pri_agency",
  });
  userId = await createTestUser("paddle-webhook");
});

afterEach(async () => {
  Object.assign(env, {
    PADDLE_WEBHOOK_SECRET: saved.PADDLE_WEBHOOK_SECRET,
    PADDLE_PRICE_CREATOR: saved.PADDLE_PRICE_CREATOR,
    PADDLE_PRICE_PRO: saved.PADDLE_PRICE_PRO,
    PADDLE_PRICE_AGENCY: saved.PADDLE_PRICE_AGENCY,
  });
  await deleteTestUser(userId);
});

function created(forUser: string) {
  return JSON.stringify({
    event_id: "evt_webhook_test",
    event_type: "subscription.created",
    occurred_at: new Date().toISOString(),
    data: {
      id: `sub_${forUser}`,
      status: "active",
      customer_id: "ctm_1",
      items: [{ price: { id: "pri_creator" } }],
      current_billing_period: { starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-12-01T00:00:00Z" },
      scheduled_change: null,
      custom_data: billingService.checkoutCustomData(forUser),
    },
  });
}

function post(body: string, signature: string | null) {
  return POST(
    new Request("http://localhost/api/billing/paddle", {
      method: "POST",
      body,
      headers: signature ? { "paddle-signature": signature } : {},
    }),
  );
}

const sign = (body: string, ts = Math.floor(Date.now() / 1000)) =>
  `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}`;

describe("POST /api/billing/paddle", () => {
  it("rejects a bad or missing signature without touching the database", async () => {
    const body = created(userId);
    expect((await post(body, "ts=1;h1=00")).status).toBe(401);
    expect((await post(body, null)).status).toBe(401);
    expect(await prisma.subscription.findUnique({ where: { userId } })).toBeNull();
  });

  it("rejects a correctly signed but stale event", async () => {
    const body = created(userId);
    const res = await post(body, sign(body, Math.floor(Date.now() / 1000) - 600));
    expect(res.status).toBe(401);
  });

  it("applies a signed subscription.created", async () => {
    const body = created(userId);
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "applied" });
    expect(await billingService.balance(userId)).toBe(20);
  });

  it("answers 503 when billing is not configured", async () => {
    Object.assign(env, { PADDLE_WEBHOOK_SECRET: undefined });
    const body = created(userId);
    expect((await post(body, sign(body))).status).toBe(503);
  });
});
