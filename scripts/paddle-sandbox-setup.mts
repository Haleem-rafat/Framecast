/**
 * Sets up a Paddle SANDBOX account for Framecast Studio, so nobody has to
 * click through the dashboard:
 *
 *   1. the "Framecast Studio" product and one monthly price per paid plan
 *      (amounts from src/lib/plans.ts),
 *   2. a notification destination pointing at <public url>/api/billing/paddle,
 *      subscribed to the subscription events the webhook understands,
 *   3. the resulting ids and the webhook secret, written into .env.local.
 *
 *   PADDLE_API_KEY=pdl_sdbx_… in .env.local, then:
 *   pnpm billing:sandbox-setup https://<public-host-of-your-dev-server>
 *
 * Without the URL it creates only the catalog (step 1); run it again with the
 * URL once the dev server has a public address. An existing destination of
 * the same name is updated in place, never deleted, so its secret survives.
 *
 * Sandbox only: it refuses a key that is not a sandbox key. Safe to re-run —
 * existing PADDLE_PRICE_* values in .env.local are reused, and the webhook
 * destination is updated rather than duplicated. Prints ids, never secrets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { config } from "dotenv";

import { PAID_TIERS, PLANS } from "../src/lib/plans.ts";

/**
 * LIVE mode (PADDLE_SETUP_LIVE=1) is the same setup against real payments:
 * the key comes from `.env.paddle-live` (git-ignored, never .env.local), the
 * API is api.paddle.com, and existing prices are read only from the target
 * file, so sandbox price ids can never leak into production.
 */
const LIVE = process.env.PADDLE_SETUP_LIVE === "1";
config({ path: LIVE ? ".env.paddle-live" : ".env.local", quiet: true });

const API = LIVE ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
/** Where the results are written, and what the webhook destination is called —
 *  overridable so staging gets its own destination and secret. */
const ENV_FILE = process.env.PADDLE_SETUP_ENV_FILE ?? ".env.local";
const DESTINATION_NAME = process.env.PADDLE_SETUP_NAME ?? "Framecast Studio (local)";
const WEBHOOK_EVENTS = [
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
];

const key = process.env.PADDLE_API_KEY;
const publicUrl = process.argv[2]?.replace(/\/$/, "");

if (!key) throw new Error(`Put PADDLE_API_KEY in ${LIVE ? ".env.paddle-live" : ".env.local"} first.`);
if (LIVE ? !key.startsWith("pdl_live_") : !key.startsWith("pdl_sdbx_")) {
  throw new Error(`That is not a ${LIVE ? "live (pdl_live_…)" : "sandbox (pdl_sdbx_…)"} key. Refusing.`);
}
if (LIVE && !process.env.PADDLE_SETUP_ENV_FILE) {
  throw new Error("Live mode needs PADDLE_SETUP_ENV_FILE, so live values never land in .env.local.");
}
if (publicUrl && !publicUrl.startsWith("https://")) {
  throw new Error("The public URL of the dev server must be https.");
}

async function paddle<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { data?: T; error?: { detail?: string } };
  if (!response.ok) {
    throw new Error(`Paddle ${method} ${path} → HTTP ${response.status}: ${json.error?.detail ?? "no detail"}`);
  }
  return json.data as T;
}

/** Sets KEY=value in .env.local, replacing an existing line or appending one. */
function setEnv(name: string, value: string) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8").split("\n") : [];
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
}

// 1. Product and prices — reused when they already exist.
const prices: Record<string, string> = {};
/** Existing values: the target file in live mode, the environment otherwise. */
const existingValue = (name: string): string | undefined => {
  if (!LIVE) return process.env[name];
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, "utf-8").split("\n").find((one) => one.startsWith(`${name}=`));
  return line?.slice(name.length + 1) || undefined;
};
const missing = PAID_TIERS.filter((tier) => !existingValue(`PADDLE_PRICE_${tier}`));
if (missing.length > 0) {
  const product = await paddle<{ id: string }>("POST", "/products", {
    name: "Framecast Studio",
    tax_category: "saas",
    description: "AI video production: scripts, narration, footage and render.",
  });
  console.log(`Product ${product.id}`);
  for (const tier of missing) {
    const plan = PLANS[tier];
    const price = await paddle<{ id: string }>("POST", "/prices", {
      product_id: product.id,
      name: plan.name,
      description: `${plan.name}: ${plan.credits} credits a month`,
      unit_price: { amount: String(plan.monthlyUsd * 100), currency_code: "USD" },
      billing_cycle: { interval: "month", frequency: 1 },
    });
    prices[tier] = price.id;
    setEnv(`PADDLE_PRICE_${tier}`, price.id);
    console.log(`${plan.name} $${plan.monthlyUsd}/month → ${price.id}`);
  }
} else {
  console.log("Prices already in .env.local — reusing them.");
}

// 2. Webhook destination — created once, then only ever updated.
if (!publicUrl) {
  console.log("\nNo public URL given: catalog only. Re-run with the dev server's https URL for the webhook.");
  process.exit(0);
}
const destination = `${publicUrl}/api/billing/paddle`;
const existing = await paddle<{ id: string; description: string }[]>("GET", "/notification-settings");
const current = existing.find((setting) => setting.description === DESTINATION_NAME);
// Never deleted: the destination and its secret are what fulfilment runs on.
// A re-run (a new tunnel URL) points the same destination somewhere else.
const created = current
  ? await paddle<{ id: string; endpoint_secret_key: string }>("PATCH", `/notification-settings/${current.id}`, {
      destination,
      subscribed_events: WEBHOOK_EVENTS,
      active: true,
    })
  : await paddle<{ id: string; endpoint_secret_key: string }>("POST", "/notification-settings", {
      description: DESTINATION_NAME,
      destination,
      type: "url",
      subscribed_events: WEBHOOK_EVENTS,
      api_version: 1,
    });
setEnv("PADDLE_WEBHOOK_SECRET", created.endpoint_secret_key);
setEnv("PADDLE_ENV", LIVE ? "production" : "sandbox");
setEnv("PADDLE_API_KEY", key);
console.log(`Webhook → ${destination} (${created.id}); secret written to ${ENV_FILE}`);

// The browser token: the one given, or a new one made through the API.
const clientToken =
  process.env.PADDLE_CLIENT_TOKEN ??
  (await paddle<{ token: string }>("POST", "/client-tokens", {
    name: DESTINATION_NAME,
    description: "Paddle.js checkout for Framecast Studio",
  })).token;
setEnv("PADDLE_CLIENT_TOKEN", clientToken);
console.log(`Client token ${clientToken.slice(0, 5)}… written to ${ENV_FILE}`);
