import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { env } from "@/config/env";
import { InternalError } from "@/lib/errors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  return Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "base64");
}

/** Returns `<iv>.<authTag>.<ciphertext>`, each segment base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

/**
 * Any failure — tampering, a rotated key, a malformed payload — collapses to a
 * generic InternalError. Distinguishing them would leak whether a given
 * ciphertext is well-formed.
 */
export function decryptSecret(payload: string): string {
  const [iv, authTag, ciphertext] = payload.split(".");

  if (!iv || !authTag || !ciphertext) {
    throw new InternalError("Stored credential is unreadable.");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new InternalError("Stored credential is unreadable.", { cause });
  }
}
