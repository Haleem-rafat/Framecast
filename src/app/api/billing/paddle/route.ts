import { NextResponse } from "next/server";

import { env } from "@/config/env";
import { paddlePrices } from "@/config/paddle";
import { clientIp, PaddleIpList } from "@/lib/paddle-ips";
import { verifyPaddleSignature } from "@/lib/paddle-signature";
import { billingService, type PaddleEvent } from "@/services/billing.service";

/**
 * Paddle → Framecast Studio, and the only writer of plans. No session: Paddle
 * proves itself with the signature instead. An event this app does not act on
 * still answers 200, or Paddle would keep retrying it for days.
 */
/** Paddle's live senders, fetched from api.paddle.com/ips and kept an hour. */
const liveSenders = new PaddleIpList("production");

export async function POST(request: Request) {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Billing is not configured" }, { status: 503 });
  }

  // Live only: sandbox deliveries reach a developer's machine through a
  // tunnel, whose address is the tunnel's, never Paddle's.
  if (env.PADDLE_ENV === "production" && !(await liveSenders.allows(clientIp(request.headers)))) {
    return NextResponse.json({ error: "Not from Paddle" }, { status: 403 });
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
