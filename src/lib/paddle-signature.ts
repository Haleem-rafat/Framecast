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
  const parts = new Map(
    header.split(";").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    }),
  );
  const ts = Number(parts.get("ts"));
  const h1 = parts.get("h1");
  if (!Number.isInteger(ts) || !h1 || !/^[0-9a-f]+$/i.test(h1)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest();
  const given = Buffer.from(h1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
