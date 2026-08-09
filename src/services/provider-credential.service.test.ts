import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { providerCredentialService } from "@/services/provider-credential.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// that also holds the operator's real data. Every test in this file gets its
// own private, throwaway User (see src/test/fixtures.ts) instead of the
// operator's real account, so an upsert here can never collide with — and
// overwrite — the operator's real ProviderCredential row, which is unique on
// [userId, provider]. Because the user is private to this one test, this
// file's own rows are the only rows it can ever see: no run token or label
// scoping is needed to tell them apart from a concurrent run's fixtures or
// the operator's real data.
const RUN = randomUUID().slice(0, 8);

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("provider-credential");
});

// Deleting the user cascades away every fixture the test created.
afterEach(() => deleteTestUser(userId));

describe("providerCredentialService", () => {
  it("stores a key encrypted and returns only the last four characters", async () => {
    const saved = await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
      label: RUN,
    });

    expect(saved.keyLastFour).toBe("1234");
    expect(saved).not.toHaveProperty("encryptedKey");

    const raw = await prisma.providerCredential.findFirstOrThrow({
      where: { userId, provider: "ELEVENLABS", label: RUN },
    });
    expect(raw.encryptedKey).not.toContain("sk-abcdefgh1234");
  });

  it("never leaks encryptedKey from list()", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
      label: RUN,
    });

    const all = await providerCredentialService.list(userId);
    expect(all).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain("encryptedKey");
  });

  it("round-trips the key through resolveKey", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
      label: RUN,
    });

    expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe(
      "sk-abcdefgh1234",
    );
  });

  it("returns null from resolveKey when nothing is stored", async () => {
    // This user is private to this test and nothing has stored an OPENAI key
    // for it, so this is a genuine absence check, not an assumption about a
    // shared table's global emptiness.
    expect(await providerCredentialService.resolveKey(userId, "OPENAI")).toBeNull();
  });

  it("replaces the key on a second upsert for the same provider", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-first000000",
      label: RUN,
    });
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-second11111",
      label: RUN,
    });

    const mine = await providerCredentialService.list(userId);
    expect(mine).toHaveLength(1);
    expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe(
      "sk-second11111",
    );
  });

  it("resolves false rather than rejecting when the stored key cannot be decrypted", async () => {
    // Planted directly via Prisma, bypassing the service's encryptSecret —
    // this simulates a row copied between environments or left over from a
    // rotated CREDENTIAL_ENCRYPTION_KEY, which decryptSecret cannot parse.
    await prisma.providerCredential.create({
      data: {
        userId,
        provider: "ANTHROPIC",
        label: RUN,
        encryptedKey: "corrupted-ciphertext",
        keyLastFour: "xxxx",
      },
    });

    await expect(providerCredentialService.test(userId, "ANTHROPIC")).resolves.toBe(
      false,
    );

    const row = await prisma.providerCredential.findFirstOrThrow({
      where: { userId, provider: "ANTHROPIC", label: RUN },
    });
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestedAt).not.toBeNull();
  });
});
