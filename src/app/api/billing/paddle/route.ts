import { NextResponse } from "next/server";

import { env } from "@/config/env";
import { paddlePrices } from "@/config/paddle";
import { verifyPaddleSignature } from "@/lib/paddle-signature";
import { billingService, type PaddleEvent } from "@/services/billing.service";

/**
 * Paddle → Framecast Studio, and the only writer of plans. No session: Paddle
 * proves itself with the signature instead. An event this app does not act on
 * still answers 200, or Paddle would keep retrying it for days.
 */
export async function POST(request: Request) {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get("paddle-signature");
  if (!verifyPaddleSignature(signature, raw, env.PADDLE_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  const result = await billingService.applyPaddleEvent(
    JSON.parse(raw) as PaddleEvent,
    paddlePrices(),
  );
  return NextResponse.json({ result });
}
