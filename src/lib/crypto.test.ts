import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("crypto", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(encryptSecret("sk-test-123"))).toBe("sk-test-123");
  });

  it("produces a different ciphertext each time", async () => {
    const { encryptSecret } = await import("@/lib/crypto");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const [iv, tag, data] = encryptSecret("sk-test-123").split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() =>
      decryptSecret(`${iv}.${tag}.${flipped.toString("base64")}`),
    ).toThrow();
  });

  it("rejects a malformed payload", async () => {
    const { decryptSecret } = await import("@/lib/crypto");
    expect(() => decryptSecret("not-a-payload")).toThrow();
  });
});
