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
 *   pnpm billing:sandbox-setup https://<your-ngrok-host>
 *
 * Sandbox only: it refuses a key that is not a sandbox key. Safe to re-run —
 * existing PADDLE_PRICE_* values in .env.local are reused, and the webhook
 * destination is replaced rather than duplicated. Prints ids, never secrets.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { config } from "dotenv";

import { PAID_TIERS, PLANS } from "../src/lib/plans";

config({ path: ".env.local", quiet: true });

const API = "https://sandbox-api.paddle.com";
const ENV_FILE = ".env.local";
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

if (!key) throw new Error("Put your sandbox PADDLE_API_KEY in .env.local first.");
if (!key.startsWith("pdl_sdbx_")) throw new Error("That is not a sandbox key (pdl_sdbx_…). Refusing.");
if (!publicUrl?.startsWith("https://")) {
  throw new Error("Pass the public https URL of your dev server, e.g. the ngrok one.");
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
  const lines = readFileSync(ENV_FILE, "utf-8").split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"));
}

// 1. Product and prices — reused when they already exist.
const prices: Record<string, string> = {};
const missing = PAID_TIERS.filter((tier) => !process.env[`PADDLE_PRICE_${tier}`]);
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

// 2. Webhook destination — the old Framecast one is removed first.
const destination = `${publicUrl}/api/billing/paddle`;
const existing = await paddle<{ id: string; description: string }[]>("GET", "/notification-settings");
for (const setting of existing.filter((s) => s.description === "Framecast Studio (local)")) {
  await paddle("DELETE", `/notification-settings/${setting.id}`);
}
const created = await paddle<{ id: string; endpoint_secret_key: string }>("POST", "/notification-settings", {
  description: "Framecast Studio (local)",
  destination,
  type: "url",
  subscribed_events: WEBHOOK_EVENTS,
  api_version: 1,
});
setEnv("PADDLE_WEBHOOK_SECRET", created.endpoint_secret_key);
setEnv("PADDLE_ENV", "sandbox");
console.log(`Webhook → ${destination} (${created.id}); secret written to ${ENV_FILE}`);

if (!process.env.PADDLE_CLIENT_TOKEN) {
  console.log(
    "\nOne thing left: Paddle → Developer tools → Authentication → Client-side tokens → New,\n" +
      "then put it in .env.local as PADDLE_CLIENT_TOKEN=test_…",
  );
}
