# Plans, Credits and Paddle Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Framecast Studio can sell monthly plans through Paddle. Each plan gives credits, making a video spends them, and the platform pays the AI bills.

**Architecture:**
- **Data:** one `Subscription` row per user mirrors Paddle's subscription. An append-only `CreditLedger` holds every credit grant, charge, refund and expiry; the balance is the sum of its rows, and a unique `(userId, ref)` key makes every write idempotent.
- **Charging:** credits are charged inside the existing `approveScript` transaction (DRAFT → QUEUED). They are refunded only when a render fails for the last time.
- **Paddle:** Paddle's webhooks are the only thing that changes a plan. Checkout is Paddle.js overlay on a new `/billing` page.

**Tech Stack:** Next.js 15.5 App Router, Prisma 7 / Postgres, Better Auth 1.6.28, vitest against the real tunnelled test DB, Paddle Billing (REST + Paddle.js v2, no SDK), `node:crypto` HMAC.

**Spec:** the decisions taken on 2026-10-19 (chat), which are:
- Paddle.
- Trial: 3 credits, with a watermark.
- Creator: $29/mo for 20 credits.
- Pro: $79/mo for 60 credits, plus marketing mode.
- Agency: $199/mo for 180 credits, plus client projects and 3 seats.
- A Short (VERTICAL) costs 1 credit and a long video (LANDSCAPE) costs 5.
- The platform pays for AI.
- Background: review artifact https://claude.ai/artifact/KTPeXzSRRKKcMwD9QPyb8J.

## Global Constraints

- **Product name:** "Framecast Studio" in all user-facing text this plan adds or changes.
- **Plans:** TRIAL 3 credits once, CREATOR 20/mo $29, PRO 60/mo $79, AGENCY 180/mo $199.
- **Credits:** do not roll over. At each new billing period, the remaining plan credits expire and the new allowance is granted.
- **Credit cost:** `VERTICAL` = 1 credit, `LANDSCAPE` = 5 credits. Shorts cut from an existing video cost 0 credits.
- **Not charged twice:**
  - A retry of a failed render (by the worker or by the user) never charges again.
  - A refund happens only when `release(..., "failed")` leaves a video FAILED with `attempts >= MAX_ATTEMPTS`.
- **Platform keys:** a user's own stored key always wins. Platform keys are used only when the user has no key of their own AND their balance is above 0, or their subscription is active.
- **Migrations:** run by hand: staging first, then production. The folder name must sort after `20260919090000_add_topic_queue_auto_refill`; use `20260920090000_add_billing`.
- **Tests:** never run two vitest processes at once. Tests use `createTestUser` / `deleteTestUser` from `src/test/fixtures.ts`.
- **Formatting:** no prettier. `pnpm lint` (eslint) is the only formatter.
- **Secrets:** never log or print Paddle keys or the webhook secret.
- **Safety:** nothing goes to production, and Paddle is not switched from sandbox to live, without the user's explicit OK.
- **Plans not covered here:** Agency seats and client projects come with the marketing-mode plan. This plan only stores the Agency tier and its credits.

## Review Focus

1. **Paddle sends the same webhook twice or out of order** (an `updated` before a `created`): credits must be granted exactly once per billing period, and the stored status must reflect the newest `occurred_at`. Task 3 adds tests for both.
2. **Two approvals at the same moment with 1 credit left:** exactly one succeeds, the other gets a 402, and the balance never goes below 0. Task 3 adds a concurrency test.
3. **A failed render that the worker retries automatically:** no refund at attempt 1 or 2, one refund at the final failure, and no extra charge when the retry runs. Task 4 adds tests.
4. **A webhook with a bad or old signature** (more than 5 minutes off): rejected with 401 and no database write. Task 2 and Task 5 add tests.
5. **A user who cancels:** they keep their credits until the period ends, then fall back to a zero balance without platform keys. Their own stored keys still work. Task 3 and Task 6 add tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/plans.ts` (new) | Pure plan catalog: tiers, prices, credits, `creditsFor(format)`, `tierForPriceId` |
| `src/lib/paddle-signature.ts` (new) | Pure: verify the `Paddle-Signature` header |
| `prisma/schema.prisma` + migration (modify/new) | `PlanTier`, `SubscriptionStatus`, `Subscription`, `CreditLedger` |
| `src/services/billing.service.ts` (new) | Balance, trial grant, charge, refund, apply Paddle event, platform eligibility |
| `src/services/paddle.client.ts` (new) | The only place that calls Paddle's REST API (portal session) |
| `src/app/api/billing/paddle/route.ts` (new) | Webhook endpoint |
| `src/app/api/billing/portal/route.ts` (new) | Returns a customer-portal URL |
| `src/app/(dashboard)/billing/page.tsx` + `src/features/billing/*` (new) | Plan, credits, history, checkout buttons |
| `src/services/video.service.ts` (modify) | Charge in `approveScript` |
| `src/services/job.service.ts` (modify) | Refund on final failure |
| `src/services/account.service.ts`, `src/lib/auth.ts` (modify) | Trial grant on approval / auto-approval |
| `src/services/provider-credential.service.ts` (modify) | Platform-key fallback |
| `src/lib/ffmpeg-command.ts`, `src/services/render.service.ts` (modify) | Trial watermark |
| `src/features/marketing/components/landing-pricing.tsx` (modify) | Real plans on the landing page |
| `src/config/env.ts`, `src/config/navigation.ts` (modify) | Paddle env, Billing nav item |

---

### Task 1: Plan catalog

**Files:**
- Create: `src/lib/plans.ts`
- Test: `src/lib/plans.test.ts`

**Interfaces:**
- Produces:
  - `type PlanTier = "TRIAL" | "CREATOR" | "PRO" | "AGENCY"`. This matches the Prisma enum in Task 3.
  - `PLANS: Record<PlanTier, Plan>`.
  - `creditsFor(format: "LANDSCAPE" | "VERTICAL"): number`.
  - `tierForPriceId(priceId: string, prices: Partial<Record<PlanTier, string>>): PlanTier | null`.
  - `PAID_TIERS: PlanTier[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { PAID_TIERS, PLANS, creditsFor, tierForPriceId } from "@/lib/plans";

describe("plans", () => {
  it("prices and credits match what the site sells", () => {
    expect(PLANS.TRIAL).toMatchObject({ monthlyUsd: 0, credits: 3, watermark: true });
    expect(PLANS.CREATOR).toMatchObject({ monthlyUsd: 29, credits: 20, watermark: false });
    expect(PLANS.PRO).toMatchObject({ monthlyUsd: 79, credits: 60, marketing: true });
    expect(PLANS.AGENCY).toMatchObject({ monthlyUsd: 199, credits: 180, seats: 3, marketing: true });
    expect(PAID_TIERS).toEqual(["CREATOR", "PRO", "AGENCY"]);
  });

  it("a Short costs 1 credit and a long video 5", () => {
    expect(creditsFor("VERTICAL")).toBe(1);
    expect(creditsFor("LANDSCAPE")).toBe(5);
  });

  it("maps a Paddle price id to its tier and nothing else", () => {
    const prices = { CREATOR: "pri_c", PRO: "pri_p", AGENCY: "pri_a" };
    expect(tierForPriceId("pri_p", prices)).toBe("PRO");
    expect(tierForPriceId("pri_unknown", prices)).toBeNull();
    expect(tierForPriceId("", {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run src/lib/plans.test.ts`
Expected: FAIL, "Cannot find module '@/lib/plans'".

- [ ] **Step 3: Implement**

```ts
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

export const PAID_TIERS: PlanTier[] = ["CREATOR", "PRO", "AGENCY"];

/** One credit is one Short; a long video is five. */
export function creditsFor(format: "LANDSCAPE" | "VERTICAL"): number {
  return format === "VERTICAL" ? 1 : 5;
}

export function tierForPriceId(
  priceId: string,
  prices: Partial<Record<PlanTier, string>>,
): PlanTier | null {
  if (!priceId) return null;
  const hit = (Object.entries(prices) as [PlanTier, string | undefined][]).find(([, id]) => id === priceId);
  return hit ? hit[0] : null;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm vitest run src/lib/plans.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (ask the user first; commits need approval in this repo)

```bash
git add src/lib/plans.ts src/lib/plans.test.ts
git commit -m "feat: the plan catalog Framecast Studio sells"
```

---

### Task 2: Paddle signature check

**Files:**
- Create: `src/lib/paddle-signature.ts`
- Test: `src/lib/paddle-signature.test.ts`

**Interfaces:**
- Produces: `verifyPaddleSignature(header: string | null, rawBody: string, secret: string, nowSeconds?: number): boolean`.
- How Paddle signs: the header looks like `ts=1700000000;h1=<hex>`, and `h1` is `HMAC-SHA256(secret, ts + ":" + rawBody)` in hex. The check rejects a `ts` more than 300 s from now, and compares in constant time.

- [ ] **Step 1: Write the failing test**

```ts
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyPaddleSignature } from "@/lib/paddle-signature";

const SECRET = "pdl_ntfset_test_secret";
const BODY = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created" });
const sign = (ts: number, body = BODY, secret = SECRET) =>
  `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex")}`;

describe("verifyPaddleSignature", () => {
  const now = 1_800_000_000;

  it("accepts a fresh, correct signature", () => {
    expect(verifyPaddleSignature(sign(now), BODY, SECRET, now)).toBe(true);
  });

  it("rejects a changed body, a wrong secret, a missing header and junk", () => {
    expect(verifyPaddleSignature(sign(now), BODY + " ", SECRET, now)).toBe(false);
    expect(verifyPaddleSignature(sign(now, BODY, "other"), BODY, SECRET, now)).toBe(false);
    expect(verifyPaddleSignature(null, BODY, SECRET, now)).toBe(false);
    expect(verifyPaddleSignature("nonsense", BODY, SECRET, now)).toBe(false);
    expect(verifyPaddleSignature(`ts=${now};h1=zz`, BODY, SECRET, now)).toBe(false);
  });

  it("rejects a signature older or newer than five minutes", () => {
    expect(verifyPaddleSignature(sign(now - 301), BODY, SECRET, now)).toBe(false);
    expect(verifyPaddleSignature(sign(now + 301), BODY, SECRET, now)).toBe(false);
    expect(verifyPaddleSignature(sign(now - 299), BODY, SECRET, now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run src/lib/paddle-signature.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** Paddle retries for days; a replay older than this is refused outright. */
const MAX_SKEW_SECONDS = 300;

/**
 * Checks Paddle's `Paddle-Signature` header (`ts=…;h1=…`): h1 is the hex
 * HMAC-SHA256 of `${ts}:${rawBody}` under the notification secret. The body
 * must be the exact bytes received — parse after verifying, never before.
 */
export function verifyPaddleSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(";").map((part) => part.split("=", 2) as [string, string]),
  );
  const ts = Number(parts.ts);
  const h1 = parts.h1;
  if (!Number.isInteger(ts) || !h1 || !/^[0-9a-f]+$/i.test(h1)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest();
  const given = Buffer.from(h1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm vitest run src/lib/paddle-signature.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (with approval)

```bash
git add src/lib/paddle-signature.ts src/lib/paddle-signature.test.ts
git commit -m "feat: verify Paddle webhook signatures"
```

---

### Task 3: Billing data and the billing service

**Files:**
- Modify: `prisma/schema.prisma`: add enums and models, plus two relations on `User`.
- Create: `prisma/migrations/20260920090000_add_billing/migration.sql`
- Modify: `src/lib/errors.ts`: add a `PAYMENT_REQUIRED` code and `PaymentRequiredError` (status 402).
- Create: `src/services/billing.service.ts`
- Test: `src/services/billing.service.test.ts`

**Interfaces:**
- Consumes: `PLANS`, `PAID_TIERS`, `PlanTier`, `tierForPriceId` (Task 1).
- Produces `billingService` with:
  - `balance(userId): Promise<number>`
  - `summary(userId): Promise<{ tier: PlanTier; status: SubscriptionStatus | null; balance: number; periodEnd: Date | null; cancelAtPeriodEnd: boolean; watermark: boolean }>`
  - `grantTrial(userId): Promise<void>`: idempotent, uses ref `trial`.
  - `charge(tx: Prisma.TransactionClient, userId, videoId, credits): Promise<void>`: throws `PaymentRequiredError`; idempotent, uses ref `charge:<videoId>`.
  - `refund(userId, videoId): Promise<boolean>`: only when a charge exists; idempotent, uses ref `refund:<videoId>`.
  - `applyPaddleEvent(event: PaddleEvent, prices: Partial<Record<PlanTier, string>>): Promise<"applied" | "ignored">`
  - `usesPlatformKeys(userId): Promise<boolean>`
  - `history(userId, limit = 30)`
- Also produces the type `PaddleEvent = { event_id: string; event_type: string; occurred_at: string; data: PaddleSubscriptionData }`, where:
  - `PaddleSubscriptionData = { id: string; status: string; customer_id: string; items: { price: { id: string } }[]; current_billing_period: { starts_at: string; ends_at: string } | null; scheduled_change: { action: string } | null; custom_data: { userId?: string } | null }`.

- [ ] **Step 1: Schema.** Add to `prisma/schema.prisma`:

```prisma
enum PlanTier {
  TRIAL
  CREATOR
  PRO
  AGENCY
}

/// Mirrors Paddle's subscription status, lower-cased there.
enum SubscriptionStatus {
  ACTIVE
  TRIALING
  PAST_DUE
  PAUSED
  CANCELED
}

/// The user's Paddle subscription. Written only by Paddle webhooks.
model Subscription {
  id                   String             @id @default(uuid()) @db.Uuid
  tier                 PlanTier
  status               SubscriptionStatus
  paddleSubscriptionId String             @unique
  paddleCustomerId     String
  periodStart          DateTime?
  periodEnd            DateTime?
  cancelAtPeriodEnd    Boolean            @default(false)
  /// `occurred_at` of the newest event applied; older events are ignored.
  lastEventAt          DateTime
  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt

  userId String @unique @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("subscription")
}

enum CreditReason {
  GRANT
  CHARGE
  REFUND
  EXPIRE
}

/// Append-only. The balance is SUM(delta). `ref` makes every write idempotent:
/// `trial`, `period:<subId>:<startsAt>`, `expire:<subId>:<startsAt>`,
/// `charge:<videoId>`, `refund:<videoId>`.
model CreditLedger {
  id        String       @id @default(uuid()) @db.Uuid
  delta     Int
  reason    CreditReason
  ref       String
  note      String?
  createdAt DateTime     @default(now())

  userId  String  @db.Uuid
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  videoId String? @db.Uuid

  @@unique([userId, ref])
  @@index([userId, createdAt])
  @@map("credit_ledger")
}
```

In `model User`, add:

```prisma
  subscription        Subscription?
  creditLedger        CreditLedger[]
```

- [ ] **Step 2: Migration.** Run `pnpm prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/billing.sql`. Read the output; it must contain only the statements for these 3 enums, 2 tables, their indexes and their foreign keys. Then save it as `prisma/migrations/20260920090000_add_billing/migration.sql`. Do NOT run `prisma migrate dev` against the shared DB. Apply it to the test DB through the SSH tunnel with `pnpm db:deploy` only when the tunnel is open (see memory "Running Framecast's tests"). Then run `pnpm db:generate`.

- [ ] **Step 3: Error class.** In `src/lib/errors.ts`, add `| "PAYMENT_REQUIRED"` to `AppErrorCode`, and:

```ts
/** The account has no credits left for this action. */
export class PaymentRequiredError extends AppError {
  readonly code = "PAYMENT_REQUIRED" as const;
  readonly httpStatus = 402;
}
```

- [ ] **Step 4: Write the failing tests** (`src/services/billing.service.test.ts`)

```ts
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

function event(over: Partial<PaddleEvent["data"]> & { type?: string; at?: string; start?: string } = {}): PaddleEvent {
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
      current_billing_period: { starts_at: start, ends_at: "2026-12-01T00:00:00Z" },
      scheduled_change: over.scheduled_change ?? null,
      custom_data: { userId },
    },
  };
}

const charge = (videoId: string, credits: number) =>
  prisma.$transaction((tx) => billingService.charge(tx, userId, videoId, credits));

describe("billingService", () => {
  it("grants the trial once", async () => {
    await billingService.grantTrial(userId);
    await billingService.grantTrial(userId);
    expect(await billingService.balance(userId)).toBe(3);
    expect((await billingService.summary(userId)).tier).toBe("TRIAL");
    expect((await billingService.summary(userId)).watermark).toBe(true);
  });

  it("charges, refuses when short, and refunds once", async () => {
    await billingService.grantTrial(userId);
    const v1 = randomUUID();
    await charge(v1, 1);
    await charge(v1, 1); // same video: idempotent
    expect(await billingService.balance(userId)).toBe(2);
    await expect(charge(randomUUID(), 5)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(await billingService.refund(userId, v1)).toBe(true);
    expect(await billingService.refund(userId, v1)).toBe(false);
    expect(await billingService.refund(userId, randomUUID())).toBe(false); // never charged
    expect(await billingService.balance(userId)).toBe(3);
  });

  it("two approvals racing for the last credit: one wins", async () => {
    await prisma.creditLedger.create({ data: { userId, delta: 1, reason: "GRANT", ref: "trial" } });
    const results = await Promise.allSettled([charge(randomUUID(), 1), charge(randomUUID(), 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await billingService.balance(userId)).toBe(0);
  });

  it("a subscription grants its credits once per period, even when Paddle repeats itself", async () => {
    await billingService.grantTrial(userId);
    expect(await billingService.applyPaddleEvent(event(), PRICES)).toBe("applied");
    await billingService.applyPaddleEvent(event({ type: "subscription.updated", at: "2026-11-01T00:00:02Z" }), PRICES);
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

  it("ignores an event older than the one already applied", async () => {
    await billingService.applyPaddleEvent(event({ items: [{ price: { id: "pri_pro" } }], at: "2026-11-02T00:00:00Z" }), PRICES);
    const old = event({ type: "subscription.updated", at: "2026-11-01T12:00:00Z" });
    expect(await billingService.applyPaddleEvent(old, PRICES)).toBe("ignored");
    expect((await billingService.summary(userId)).tier).toBe("PRO");
  });

  it("an event for an unknown price or user is ignored", async () => {
    expect(await billingService.applyPaddleEvent(event({ items: [{ price: { id: "pri_x" } }] }), PRICES)).toBe("ignored");
    const stranger = event();
    stranger.data.custom_data = { userId: randomUUID() };
    expect(await billingService.applyPaddleEvent(stranger, PRICES)).toBe("ignored");
  });

  it("a cancelled subscription stops platform keys once credits are gone", async () => {
    await billingService.applyPaddleEvent(event(), PRICES);
    await billingService.applyPaddleEvent(
      event({ type: "subscription.canceled", status: "canceled", at: "2026-12-01T00:00:05Z" }),
      PRICES,
    );
    // remaining credits are still spendable
    expect(await billingService.usesPlatformKeys(userId)).toBe(true);
    await prisma.creditLedger.create({ data: { userId, delta: -20, reason: "CHARGE", ref: "drain" } });
    expect(await billingService.usesPlatformKeys(userId)).toBe(false);
  });
});
```

- [ ] **Step 5: Run them and see them fail**

Run: `pnpm vitest run src/services/billing.service.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 6: Implement `src/services/billing.service.ts`**

```ts
import type { Prisma, SubscriptionStatus } from "@/generated/prisma/client";

import { PaymentRequiredError } from "@/lib/errors";
import { PLANS, type PlanTier, tierForPriceId } from "@/lib/plans";
import { prisma } from "@/lib/prisma";

export interface PaddleSubscriptionData {
  id: string;
  status: string;
  customer_id: string;
  items: { price: { id: string } }[];
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: string } | null;
  custom_data: { userId?: string } | null;
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

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

/**
 * Credits and plans. Every credit movement is a row in `credit_ledger`, keyed
 * by `(userId, ref)` so that Paddle repeating a webhook, a worker retrying a
 * render or a double-clicked Approve can never move credits twice.
 */
export class BillingService {
  async balance(userId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
    const { _sum } = await db.creditLedger.aggregate({ where: { userId }, _sum: { delta: true } });
    return _sum.delta ?? 0;
  }

  async summary(userId: string) {
    const [subscription, balance] = await Promise.all([
      prisma.subscription.findUnique({ where: { userId } }),
      this.balance(userId),
    ]);
    const live = subscription && subscription.status !== "CANCELED" && subscription.status !== "PAUSED";
    const tier: PlanTier = live ? subscription.tier : "TRIAL";
    return {
      tier,
      status: subscription?.status ?? null,
      balance,
      periodEnd: subscription?.periodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      watermark: PLANS[tier].watermark,
    };
  }

  async grantTrial(userId: string): Promise<void> {
    await this.write(prisma, { userId, delta: PLANS.TRIAL.credits, reason: "GRANT", ref: "trial", note: "Trial" });
  }

  /**
   * Spends credits inside the caller's transaction, so the approval and the
   * charge commit or roll back together. The advisory lock serialises two
   * approvals by the same user; without it both could read the same balance.
   */
  async charge(tx: Prisma.TransactionClient, userId: string, videoId: string, credits: number): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
    const ref = `charge:${videoId}`;
    if (await tx.creditLedger.findUnique({ where: { userId_ref: { userId, ref } } })) return;
    const balance = await this.balance(userId, tx);
    if (balance < credits) {
      throw new PaymentRequiredError(
        `This needs ${credits} credit${credits === 1 ? "" : "s"} and you have ${balance}. Choose a plan on the Billing page.`,
      );
    }
    await tx.creditLedger.create({ data: { userId, videoId, delta: -credits, reason: "CHARGE", ref } });
  }

  /** Gives back what `charge` took for this video. False when there is nothing to give back. */
  async refund(userId: string, videoId: string): Promise<boolean> {
    const charged = await prisma.creditLedger.findUnique({
      where: { userId_ref: { userId, ref: `charge:${videoId}` } },
    });
    if (!charged) return false;
    return this.write(prisma, {
      userId,
      videoId,
      delta: -charged.delta,
      reason: "REFUND",
      ref: `refund:${videoId}`,
      note: "Render failed",
    });
  }

  async applyPaddleEvent(
    event: PaddleEvent,
    prices: Partial<Record<PlanTier, string>>,
  ): Promise<"applied" | "ignored"> {
    if (!event.event_type.startsWith("subscription.")) return "ignored";
    const data = event.data;
    const userId = data.custom_data?.userId;
    const tier = tierForPriceId(data.items[0]?.price.id ?? "", prices);
    const status = STATUS[data.status];
    if (!userId || !tier || !status) return "ignored";
    if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) return "ignored";

    const at = new Date(event.occurred_at);
    const existing = await prisma.subscription.findUnique({ where: { userId } });
    if (existing && existing.paddleSubscriptionId === data.id && existing.lastEventAt >= at) return "ignored";

    const period = data.current_billing_period;
    const fields = {
      tier,
      status,
      paddleSubscriptionId: data.id,
      paddleCustomerId: data.customer_id,
      periodStart: period ? new Date(period.starts_at) : null,
      periodEnd: period ? new Date(period.ends_at) : null,
      cancelAtPeriodEnd: data.scheduled_change?.action === "cancel",
      lastEventAt: at,
    };

    await prisma.$transaction(async (tx) => {
      await tx.subscription.upsert({ where: { userId }, create: { userId, ...fields }, update: fields });
      if (!period || (status !== "ACTIVE" && status !== "TRIALING")) return;

      // A new billing period: what is left of the previous period's plan
      // credits expires, then the new allowance arrives. Trial credits and
      // refunds are not plan credits and never expire.
      const start = period.starts_at;
      const grantRef = `period:${data.id}:${start}`;
      if (await tx.creditLedger.findUnique({ where: { userId_ref: { userId, ref: grantRef } } })) return;
      const previous = await tx.creditLedger.findFirst({
        where: { userId, reason: "GRANT", ref: { startsWith: `period:${data.id}:` } },
        orderBy: { createdAt: "desc" },
      });
      if (previous) {
        const spentSince = await tx.creditLedger.aggregate({
          where: { userId, reason: { in: ["CHARGE", "REFUND"] }, createdAt: { gte: previous.createdAt } },
          _sum: { delta: true },
        });
        const leftover = Math.max(0, Math.min(previous.delta + (spentSince._sum.delta ?? 0), await this.balance(userId, tx)));
        if (leftover > 0) {
          await this.write(tx, { userId, delta: -leftover, reason: "EXPIRE", ref: `expire:${data.id}:${start}`, note: "Unused credits from last month" });
        }
      }
      await this.write(tx, { userId, delta: PLANS[tier].credits, reason: "GRANT", ref: grantRef, note: `${PLANS[tier].name} plan` });
    });
    return "applied";
  }

  /** Platform AI keys are for people who are paying, or still have credits to spend. */
  async usesPlatformKeys(userId: string): Promise<boolean> {
    if ((await this.balance(userId)) > 0) return true;
    const subscription = await prisma.subscription.findUnique({ where: { userId }, select: { status: true } });
    return subscription?.status === "ACTIVE" || subscription?.status === "TRIALING";
  }

  history(userId: string, limit = 30) {
    return prisma.creditLedger.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, delta: true, reason: true, note: true, videoId: true, createdAt: true },
    });
  }

  /** Inserts one ledger row; false when that ref was already written. */
  private async write(
    db: Prisma.TransactionClient,
    row: { userId: string; delta: number; reason: "GRANT" | "REFUND" | "EXPIRE"; ref: string; note?: string; videoId?: string },
  ): Promise<boolean> {
    try {
      await db.creditLedger.create({ data: row });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

export const billingService = new BillingService();
```

Notes:
- Check the import path of the generated Prisma types against how `src/lib/prisma.ts` imports them, and use the same path.
- Inside the `$transaction` in `applyPaddleEvent`, a unique violation aborts the Postgres transaction. That's why the grant-ref check runs before `write` there. Keep `write`'s catch only for the non-transaction callers (`grantTrial`, `refund`).

- [ ] **Step 7: Run them and see them pass**

Run: `pnpm vitest run src/services/billing.service.test.ts`
Expected: PASS (8 tests). Then run `pnpm typecheck`.

- [ ] **Step 8: Commit** (with approval)

```bash
git add prisma/schema.prisma prisma/migrations/20260920090000_add_billing src/lib/errors.ts src/services/billing.service.ts src/services/billing.service.test.ts
git commit -m "feat: credits ledger, subscriptions and the billing service"
```

---

### Task 4: Charge on approval, refund on final failure, trial on approval

**Files:**
- Modify: `src/services/video.service.ts`: `approveScript` (around line 232), inside its existing `prisma.$transaction`.
- Modify: `src/services/job.service.ts`: `release()`, the `outcome === "failed"` branch (around line 216), and the read at line 154.
- Modify: `src/services/account.service.ts`: `decide()`. Call `grantTrial` when the decision is APPROVED.
- Modify: `src/lib/auth.ts`: the hook that auto-approves `autoApprovedEmails` accounts. Find it with `grep -n "autoApprovedEmails" src/lib/auth.ts`, then call `billingService.grantTrial(user.id)` after the user is created APPROVED.
- Test: `src/services/video.service.test.ts` (add cases), `src/services/job.service.test.ts` (add cases), `src/services/account.service.test.ts` (add a case).

**Interfaces:**
- Consumes: `billingService.charge`, `refund` and `grantTrial` (Task 3), `creditsFor` (Task 1), `MAX_ATTEMPTS` (job.service.ts:14).

- [ ] **Step 1: Write the failing tests.** Copy the fixture helpers each file already uses to make a DRAFT video with an active script version (read the top of `video.service.test.ts`). Then add:

```ts
it("approving charges credits by format and refuses with no credits", async () => {
  await billingService.grantTrial(userId); // 3 credits
  const short = await makeDraftVideo(userId); // existing helper in this file
  await videoService.approveScript(userId, short.id, "VERTICAL");
  expect(await billingService.balance(userId)).toBe(2);

  const long = await makeDraftVideo(userId);
  await expect(videoService.approveScript(userId, long.id, "LANDSCAPE")).rejects.toBeInstanceOf(PaymentRequiredError);
  // the refused video stayed a draft
  expect((await prisma.video.findUniqueOrThrow({ where: { id: long.id } })).status).toBe("DRAFT");
});
```

In `job.service.test.ts`:

```ts
it("refunds only at the final failure", async () => {
  await billingService.grantTrial(userId);
  const video = await makeDraftVideo(userId);
  await videoService.approveScript(userId, video.id, "VERTICAL"); // 2 left
  await prisma.video.update({ where: { id: video.id }, data: { status: "GENERATING", attempts: 1 } });
  await jobService.release(video.id, "failed", "boom");
  expect(await billingService.balance(userId)).toBe(2); // will be retried, no refund

  await prisma.video.update({ where: { id: video.id }, data: { status: "GENERATING", attempts: MAX_ATTEMPTS } });
  await jobService.release(video.id, "failed", "boom");
  expect(await billingService.balance(userId)).toBe(3); // refunded once
});
```

In `account.service.test.ts`:

```ts
it("approving an account grants the 3 trial credits", async () => {
  // use this file's existing pattern for a PENDING user + an operator approver
  await accountService.approve(operatorId, pendingId);
  expect(await billingService.balance(pendingId)).toBe(3);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run src/services/video.service.test.ts src/services/job.service.test.ts src/services/account.service.test.ts`. That's one vitest process with three files.
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**
  - **`approveScript`:** as the first statement inside the existing `prisma.$transaction(async (tx) => {`, add:

```ts
      // Spent here, in the same transaction as DRAFT -> QUEUED, so a refused
      // charge leaves the draft untouched and a failed approval spends nothing.
      await billingService.charge(tx, userId, id, creditsFor(format));
```

  - **`release()`:** change the select at line 154 to `select: { id: true, status: true, attempts: true, userId: true }`. In the `outcome === "failed"` branch, after `videoStatusEvent.create(...)` and before `return`, add:

```ts
      // The worker retries a failed render on its own until MAX_ATTEMPTS;
      // only the last failure gives the credits back.
      if (video.attempts >= MAX_ATTEMPTS) {
        await billingService.refund(video.userId, videoId);
      }
```

  - **`decide()`:** after the approval write succeeds and only for `"APPROVED"`, add `await billingService.grantTrial(userId);`.
  - **`src/lib/auth.ts`:** in the auto-approve path, add `await billingService.grantTrial(user.id);`.

- [ ] **Step 4: Run them and see them pass.** Use the same single command as Step 2. Then run `pnpm typecheck`.

- [ ] **Step 5: Backfill the trial for existing approved accounts.** The 41 approved accounts would otherwise start at 0 credits. Create `scripts/grant-trial-backfill.ts`, which calls `billingService.grantTrial` for every `approval: "APPROVED"` user. `grantTrial` is idempotent, so running it twice is safe. Run it on staging, then production, after the migration. Production needs the user's OK.

```ts
import { prisma } from "@/lib/prisma";
import { billingService } from "@/services/billing.service";

const users = await prisma.user.findMany({ where: { approval: "APPROVED" }, select: { id: true } });
for (const { id } of users) await billingService.grantTrial(id);
console.log(`Trial credits checked for ${users.length} approved accounts.`);
await prisma.$disconnect();
```

- [ ] **Step 6: Commit** (with approval)

```bash
git add src/services/video.service.ts src/services/job.service.ts src/services/account.service.ts src/lib/auth.ts src/services/*.test.ts scripts/grant-trial-backfill.ts
git commit -m "feat: approving a video spends credits; a final failure refunds them"
```

---

### Task 5: Paddle webhook endpoint and env

**Files:**
- Modify: `src/config/env.ts`. Add these, all optional so dev and test still boot:
  - `PADDLE_ENV: z.enum(["sandbox","production"]).default("sandbox")`
  - `PADDLE_API_KEY`
  - `PADDLE_WEBHOOK_SECRET`
  - `PADDLE_PRICE_CREATOR`, `PADDLE_PRICE_PRO`, `PADDLE_PRICE_AGENCY`
  - `PLATFORM_ELEVENLABS_API_KEY`
  - Client side: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_ENV`.
- Create: `src/config/paddle.ts`, which exports `paddlePrices(): Partial<Record<PlanTier, string>>` built from env.
- Create: `src/app/api/billing/paddle/route.ts`
- Test: `src/app/api/billing/paddle/route.test.ts`

**Interfaces:**
- Consumes: `verifyPaddleSignature` (Task 2), `billingService.applyPaddleEvent` (Task 3).
- Produces: `POST /api/billing/paddle` returns 401 for a bad signature, 503 when the secret is unset, and 200 `{ result }` otherwise. That includes "ignored", so Paddle doesn't retry events it will never apply.

- [ ] **Step 1: Write the failing test.** Read how other route tests in the repo mock `env`; if none do, use `vi.mock("@/config/env", ...)` with `PADDLE_WEBHOOK_SECRET: "whsec_test"` and the three price ids.

```ts
it("rejects a bad signature without touching the database", async () => {
  const res = await POST(new Request("http://x/api/billing/paddle", {
    method: "POST", body: "{}", headers: { "paddle-signature": "ts=1;h1=00" },
  }));
  expect(res.status).toBe(401);
});

it("applies a signed subscription.created", async () => {
  const body = JSON.stringify(eventFor(userId)); // same shape as Task 3's event()
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac("sha256", "whsec_test").update(`${ts}:${body}`).digest("hex");
  const res = await POST(new Request("http://x/api/billing/paddle", {
    method: "POST", body, headers: { "paddle-signature": `ts=${ts};h1=${h1}` },
  }));
  expect(res.status).toBe(200);
  expect(await billingService.balance(userId)).toBe(20);
});
```

- [ ] **Step 2: Run it and see it fail.** Run `pnpm vitest run src/app/api/billing/paddle/route.test.ts`.

- [ ] **Step 3: Implement the route**

```ts
import { NextResponse } from "next/server";

import { env } from "@/config/env";
import { paddlePrices } from "@/config/paddle";
import { verifyPaddleSignature } from "@/lib/paddle-signature";
import { billingService, type PaddleEvent } from "@/services/billing.service";

/** Paddle → Framecast Studio. The only writer of plans. */
export async function POST(request: Request) {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }
  const raw = await request.text();
  if (!verifyPaddleSignature(request.headers.get("paddle-signature"), raw, env.PADDLE_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }
  const result = await billingService.applyPaddleEvent(JSON.parse(raw) as PaddleEvent, paddlePrices());
  return NextResponse.json({ result });
}
```

`src/config/paddle.ts`:

```ts
import { env } from "@/config/env";
import type { PlanTier } from "@/lib/plans";

export function paddlePrices(): Partial<Record<PlanTier, string>> {
  return {
    CREATOR: env.PADDLE_PRICE_CREATOR,
    PRO: env.PADDLE_PRICE_PRO,
    AGENCY: env.PADDLE_PRICE_AGENCY,
  };
}
```

Check that `src/middleware.ts` (if present) doesn't require a session on `/api/billing/paddle`. If it does, add this path to its public list, just as `/api/auth` is.

- [ ] **Step 4: Run it and see it pass.** Then run `pnpm typecheck`.

- [ ] **Step 5: Commit** (with approval): `git commit -m "feat: Paddle webhook keeps plans and credits in step"`

---

### Task 6: Platform AI keys for paying users

**Files:**
- Modify: `src/services/provider-credential.service.ts:189` (`resolveKey`)
- Test: `src/services/provider-credential.service.test.ts` (add cases)

**Interfaces:**
- Consumes: `billingService.usesPlatformKeys` (Task 3), `env.PLATFORM_ELEVENLABS_API_KEY` (Task 5).
- Behaviour:
  - The user's own key wins.
  - Otherwise, ELEVENLABS falls back to `PLATFORM_ELEVENLABS_API_KEY` when `usesPlatformKeys` is true.
  - ANTHROPIC returns null as today, because the callers already fall back to the AI Gateway (`?? undefined`).
  - The gateway itself (`AI_GATEWAY_API_KEY`) is already platform-level.

- [ ] **Step 1: Write the failing tests**

```ts
it("falls back to the platform ElevenLabs key only for users with credits", async () => {
  vi.spyOn(env, "PLATFORM_ELEVENLABS_API_KEY", "get").mockReturnValue("platform-key"); // or vi.mock, matching this file
  expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBeNull();
  await billingService.grantTrial(userId);
  expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe("platform-key");
});

it("a user's own key still wins over the platform key", async () => {
  await billingService.grantTrial(userId);
  await providerCredentialService.upsert(userId, { provider: "ELEVENLABS", apiKey: "sk-own-1234", label: RUN });
  expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe("sk-own-1234");
});
```

- [ ] **Step 2: Run them and see them fail.** Then implement, replacing the final `return` of `resolveKey`:

```ts
    if (credential) return decryptSecret(credential.encryptedKey);
    // Paying users (or anyone with credits left) use the platform's keys, so
    // a customer never has to open an ElevenLabs account. Own keys win.
    const platform: Partial<Record<AiProviderType, string | undefined>> = {
      ELEVENLABS: env.PLATFORM_ELEVENLABS_API_KEY,
    };
    const key = platform[provider];
    return key && (await billingService.usesPlatformKeys(userId)) ? key : null;
```

- [ ] **Step 3: Run them and see them pass.** Run the whole `provider-credential.service.test.ts`; the existing cases must still pass.

- [ ] **Step 4: Commit** (with approval): `git commit -m "feat: paying users run on the platform's AI keys"`

---

### Task 7: Billing page, checkout and portal

**Files:**
- Create: `src/services/paddle.client.ts`. It holds `createPortalUrl(customerId, subscriptionId): Promise<string>`, which calls `POST {base}/customers/{customerId}/portal-sessions` with body `{ subscription_ids: [subscriptionId] }` and `Authorization: Bearer PADDLE_API_KEY`. It returns `data.urls.general.overview`. The base is `https://sandbox-api.paddle.com` for sandbox and `https://api.paddle.com` for production.
- Create: `src/app/api/billing/portal/route.ts`. `POST` takes the session user, reads their `Subscription`, and returns `{ url }`. It returns 404 when there's no subscription.
- Create: `src/app/(dashboard)/billing/page.tsx`. This server component reads `billingService.summary` and `history` for the session user.
- Create: `src/features/billing/components/plan-cards.tsx` (client). Lines come from `PLANS`. The buttons load Paddle.js from `https://cdn.paddle.com/paddle/v2/paddle.js`, then:
  - `Paddle.Environment.set(NEXT_PUBLIC_PADDLE_ENV)` when it's sandbox.
  - `Paddle.Initialize({ token: NEXT_PUBLIC_PADDLE_CLIENT_TOKEN })`.
  - `Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customer: { email }, customData: { userId } })`.
  - The price ids are passed in from the server page via `paddlePrices()`.
- Create: `src/features/billing/components/credit-history.tsx`, a table of ledger rows. It shows the reason, signed delta, note, a video link when `videoId` is set, and the date.
- Modify: `src/config/navigation.ts`. Add a `Billing` item (`href: "/billing"`, icon `CreditCard`) next to Settings.
- Modify: the approve dialog, which you can find with `grep -rn "approveScript\|/approve" src/features/videos`. Show "Uses N credit(s) · you have B". When the API answers 402, show its message with a link to `/billing`.
- Test: `src/services/paddle.client.test.ts`. Inject `fetch`, as `provider-credential.service.ts` does with `FetchLike`, and assert the URL, method and bearer header, and the returned overview URL.

- [ ] **Step 1:** Write `paddle.client.test.ts` and see it fail.
- [ ] **Step 2:** Implement `paddle.client.ts`, then see the test pass.
- [ ] **Step 3:** Build the page and components. The page shows:
  - The current plan.
  - The balance.
  - The renewal or end date (and "Cancels on …" when `cancelAtPeriodEnd` is set).
  - Three plan cards, with the current one marked.
  - "Manage billing", only when a subscription exists.
  - Credit history.
- [ ] **Step 4: Manual check against the Paddle sandbox**, with the user's sandbox account:
  1. Create the three Prices in the Paddle sandbox ($29, $79, $199 monthly).
  2. Set the env vars in local `.env`.
  3. Expose the dev server with the tunnel the user prefers, and set the sandbox notification destination to `/api/billing/paddle`.
  4. Buy Creator with test card `4242 4242 4242 4242`.
  5. Confirm the page shows Creator and +20 credits.
  6. Open the portal, cancel, and confirm "Cancels on …".
- [ ] **Step 5:** Run `pnpm lint && pnpm typecheck`.
- [ ] **Step 6: Commit** (with approval): `git commit -m "feat: Billing page with Paddle checkout and the customer portal"`

---

### Task 8: Trial watermark

**Files:**
- Modify: `src/lib/ffmpeg-command.ts`: `AssembleInput` gets `watermark?: string`. `buildAssembleArgs` adds a `drawtext` after the subtitles filter.
- Modify: `src/services/render.service.ts`: where `buildAssembleArgs` is called, pass `watermark: "Made with Framecast Studio"` when `(await billingService.summary(video.userId)).watermark` is true.
- Test: `src/lib/ffmpeg-command.test.ts` (add cases).

- [ ] **Step 1: Write the failing tests**

```ts
it("adds no watermark unless asked, so existing renders are byte-identical", () => {
  const args = buildAssembleArgs(baseAssembleInput); // this file's existing fixture
  expect(args.join(" ")).not.toContain("drawtext");
});

it("draws the watermark after the captions, bottom right", () => {
  const args = buildAssembleArgs({ ...baseAssembleInput, watermark: "Made with Framecast Studio" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  expect(graph).toMatch(/subtitles=.*,drawtext=text='Made with Framecast Studio'/);
  expect(graph).toContain("x=w-tw-32:y=h-th-32");
});
```

- [ ] **Step 2:** See them fail. Then implement in `buildAssembleArgs`:

```ts
  // Trial renders only. After the captions so nothing ever sits on top of it.
  const watermark = input.watermark
    ? `,drawtext=text='${input.watermark.replace(/[':\\]/g, "\\$&")}':fontcolor=white@0.55:fontsize=h*0.028:x=w-tw-32:y=h-th-32:box=1:boxcolor=black@0.25:boxborderw=10`
    : "";
  const videoFilter =
    `[0:v]${grain}${buildSubtitleFilter(input.srtPath, input.captions)}${watermark}[vout]`;
```

- [ ] **Step 3:** See them pass. Then render one trial video locally and look at a frame, to check the text is readable and clear of the captions in both 16:9 and 9:16.
- [ ] **Step 4: Commit** (with approval): `git commit -m "feat: trial videos carry a small Framecast Studio watermark"`

---

### Task 9: Real pricing on the landing page, and the Framecast Studio name

**Files:**
- Modify: `src/features/marketing/components/landing-pricing.tsx`.
  - Replace the `PLANS` const and the file comment. Cards are built from `@/lib/plans` (Trial, Creator, Pro, Agency) with real prices.
  - The CTA goes to `/sign-up` for Trial and `/billing` for the paid plans; signed-out users land on sign-in first, through the existing redirect.
  - Lines per card:
    - Trial: "3 videos to try, watermark".
    - Creator: "20 credits a month: 20 Shorts or 4 long videos".
    - Pro: "60 credits, marketing videos".
    - Agency: "180 credits, client projects, 3 seats (coming soon)".
  - Footnote: "1 credit = one Short up to 60 s. A long video = 5 credits. Unused credits don't roll over. AI costs are included. Prices in USD; taxes are added at checkout by Paddle, our reseller."
- Modify: `src/features/marketing/landing-copy.ts` lines 70, 105 and 134. Change `price: "Free while it is in beta"` to `"From $29 a month · free trial"`.
- Modify: `src/lib/auth.ts`: `appName: "Framecast Studio"`.
- Modify: `src/app/layout.tsx`: change the site title and metadata `applicationName` to "Framecast Studio". Also update `src/app/manifest.ts` and `src/app/opengraph-image.tsx` text.
- Modify: `src/app/terms/page.tsx`. Add a "Payments and refunds" section:
  - Paddle is the merchant of record.
  - You can cancel any time in the portal, and access lasts to the end of the period.
  - Failed renders give their credits back.

The user must review this wording before it goes live.

- [ ] **Step 1:** Make the changes.
- [ ] **Step 2:** Run `pnpm lint && pnpm typecheck`, then `pnpm build`.
- [ ] **Step 3:** Open `/` in light and dark themes at 390 px and 1440 px. There must be no overflow, and the cards must match `PLANS`.
- [ ] **Step 4: Commit** (with approval): `git commit -m "feat: Framecast Studio plans and prices on the landing page"`

---

### Task 10: Production rollout (each step needs the user's OK)

Follow the repo memories "Framecast staging deploys" and "Migrations are manual".

- [ ] **Step 1:** The user creates a live Paddle account and passes Paddle's checks: website, terms, refund policy, and the Egypt seller check. They create the three live Prices and a notification destination `https://<prod-domain>/api/billing/paddle` subscribed to `subscription.*`.
- [ ] **Step 2:** Push the branch, then merge to main after review. GHCR builds images.
- [ ] **Step 3 (staging):**
  1. Set the sandbox Paddle env on the VPS staging service.
  2. Run the migration by hand on staging.
  3. Run `scripts/grant-trial-backfill.ts` on staging.
  4. Deploy `:staging` and do a sandbox purchase end to end.
- [ ] **Step 4 (production):**
  1. Set the live Paddle env and `PLATFORM_ELEVENLABS_API_KEY`.
  2. Run the migration by hand.
  3. Run the backfill.
  4. Move the prod pin to the tested SHA.
  5. Check sign-in, then `/billing`, then make one real purchase of the cheapest plan with the user's own card, and refund it from Paddle.
- [ ] **Step 5:** Set a budget alert on the AI Gateway key. The platform now pays for every user's AI.

---

## What comes after this plan (separate plans, in this order)

1. **Marketing mode in Framecast Studio, for the first client.**
   - Client projects without a YouTube channel.
   - Brand read from the website.
   - Brief chat and the branded social video.
   - Pro and Agency only.
   - Agency seats.
2. **Desktop app.** An Electron shell for Mac and Windows that signs in to the same account and runs the studio's Chrome renderer locally. On the web, the animated looks and the website reader show "This works in the desktop app" with a download link.
3. **Motion looks on the server** (once there's a render server): the Phase 2–3 work from the review.
4. **Gemini voice + Whisper timing:** cuts the platform's voice cost from ElevenLabs prices to about $0.014 a minute.
