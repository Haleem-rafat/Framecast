import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("resolves not-ok rather than rejecting when the stored key cannot be decrypted", async () => {
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

    const result = await providerCredentialService.test(userId, "ANTHROPIC");
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("corrupted-ciphertext");

    const row = await prisma.providerCredential.findFirstOrThrow({
      where: { userId, provider: "ANTHROPIC", label: RUN },
    });
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestedAt).not.toBeNull();
  });

  describe("test() — ELEVENLABS", () => {
    it("reports ok when ElevenLabs accepts the key", async () => {
      await providerCredentialService.upsert(userId, {
        provider: "ELEVENLABS",
        apiKey: "sk-good0000000",
        label: RUN,
      });

      const fetchClient = vi.fn(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await providerCredentialService.test(
        userId,
        "ELEVENLABS",
        fetchClient,
      );

      expect(result.ok).toBe(true);
      expect(fetchClient).toHaveBeenCalledWith(
        "https://api.elevenlabs.io/v1/user/subscription",
        expect.objectContaining({
          headers: { "xi-api-key": "sk-good0000000" },
        }),
      );

      const row = await prisma.providerCredential.findFirstOrThrow({
        where: { userId, provider: "ELEVENLABS", label: RUN },
      });
      expect(row.lastTestOk).toBe(true);
    });

    it("reports not-ok, naming an invalid key, on a plain 401", async () => {
      await providerCredentialService.upsert(userId, {
        provider: "ELEVENLABS",
        apiKey: "sk-revoked0000",
        label: RUN,
      });

      const fetchClient = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ detail: { status: "invalid_api_key" } }),
            { status: 401 },
          ),
      ) as unknown as typeof fetch;

      const result = await providerCredentialService.test(
        userId,
        "ELEVENLABS",
        fetchClient,
      );

      expect(result.ok).toBe(false);
      expect(result.reason.toLowerCase()).toContain("invalid");
      expect(result.reason).not.toContain("sk-revoked0000");

      const row = await prisma.providerCredential.findFirstOrThrow({
        where: { userId, provider: "ELEVENLABS", label: RUN },
      });
      expect(row.lastTestOk).toBe(false);
    });

    it("distinguishes a missing-permission 401 from an invalid key, and names the permission", async () => {
      await providerCredentialService.upsert(userId, {
        provider: "ELEVENLABS",
        apiKey: "sk-scoped00000",
        label: RUN,
      });

      const fetchClient = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: {
                status: "missing_permissions",
                message:
                  "The API key you used is missing the permission user_read to execute this operation.",
              },
            }),
            { status: 401 },
          ),
      ) as unknown as typeof fetch;

      const result = await providerCredentialService.test(
        userId,
        "ELEVENLABS",
        fetchClient,
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toContain("user_read");
      expect(result.reason.toLowerCase()).not.toContain("invalid");
      expect(result.reason).not.toContain("sk-scoped00000");

      const row = await prisma.providerCredential.findFirstOrThrow({
        where: { userId, provider: "ELEVENLABS", label: RUN },
      });
      expect(row.lastTestOk).toBe(false);
    });
  });

  it("reports a provider with no implemented check as not-ok and untestable, rather than defaulting to ok", async () => {
    // OPENAI is a real, storable provider (see aiProviderTypes) with no
    // upstream check wired up yet — exactly the "no implemented check" case.
    await providerCredentialService.upsert(userId, {
      provider: "OPENAI",
      apiKey: "sk-untested000",
      label: RUN,
    });

    const fetchClient = vi.fn() as unknown as typeof fetch;

    const result = await providerCredentialService.test(userId, "OPENAI", fetchClient);

    expect(result.ok).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/test|verif/);
    // The gateway/ElevenLabs paths are never reached for an untestable provider.
    expect(fetchClient).not.toHaveBeenCalled();

    const row = await prisma.providerCredential.findFirstOrThrow({
      where: { userId, provider: "OPENAI", label: RUN },
    });
    expect(row.lastTestOk).toBe(false);
    expect(row.lastTestedAt).not.toBeNull();
  });
});
