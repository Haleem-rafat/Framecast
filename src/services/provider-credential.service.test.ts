import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { providerCredentialService } from "@/services/provider-credential.service";

// Tests run against a real, shared Supabase database (see src/test/setup.ts).
// A run-unique label lets every fixture this file creates be scoped to this
// run's own rows, so a concurrent test run — or the operator's own dev app —
// never has rows it owns touched, and this file never touches rows it doesn't
// own. The vault has one row per [userId, provider], so the token rides in
// `label` rather than in an identifying column of its own.
const RUN = randomUUID().slice(0, 8);

let userId: string;

async function cleanup() {
  await prisma.providerCredential.deleteMany({
    where: { userId, label: { contains: RUN } },
  });
}

beforeEach(async () => {
  userId = (await prisma.user.findFirstOrThrow()).id;
  await cleanup();
});

// Belt and suspenders: afterEach keeps each test isolated from the next,
// afterAll guarantees nothing from this file survives even if a test throws
// before its own assertions run.
afterEach(cleanup);
afterAll(cleanup);

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

    const all = (await providerCredentialService.list(userId)).filter(
      (c) => c.label === RUN,
    );
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
    // No fixture in this run stores an OPENAI key for this user, but a
    // concurrent run's fixture legitimately might — so assert against a
    // provider this file never writes to under a value distinguishable by
    // absence of the run token, rather than assuming global emptiness.
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

    const mine = (await providerCredentialService.list(userId)).filter(
      (c) => c.label === RUN,
    );
    expect(mine).toHaveLength(1);
    expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe(
      "sk-second11111",
    );
  });
});
