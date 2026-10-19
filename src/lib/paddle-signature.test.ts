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
