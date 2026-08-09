import "server-only";

import type { AiProviderType } from "@/generated/prisma/enums";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { UpsertCredentialInput } from "@/schemas/provider.schema";
import { ELEVENLABS_API_BASE } from "@/services/providers/elevenlabs.provider";
import { gatewayProvider } from "@/services/providers/gateway.provider";

/**
 * Explicit select list, used by every read. `encryptedKey` is absent by
 * construction rather than by remembering to omit it.
 */
const SUMMARY_SELECT = {
  id: true,
  provider: true,
  label: true,
  keyLastFour: true,
  isActive: true,
  lastTestedAt: true,
  lastTestOk: true,
} as const;

export interface CredentialSummary {
  id: string;
  provider: AiProviderType;
  label: string | null;
  keyLastFour: string;
  isActive: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
}

/**
 * A boolean can't say *why* a test failed, and the operator needs that: an
 * invalid key and a key that's merely missing a permission call for different
 * fixes. `reason` is always human-readable and safe to show verbatim — it
 * must never contain the key itself.
 */
export interface CredentialTestResult {
  ok: boolean;
  reason: string;
}

/** The minimal `fetch` surface `test()` needs, so a fake can stand in under test. */
export type FetchLike = typeof fetch;

/** ElevenLabs' error envelope for both invalid keys and permission gaps. */
interface ElevenLabsErrorBody {
  detail?: {
    status?: string;
    message?: string;
  };
}

/**
 * `GET /v1/user/subscription` is the cheapest authenticated ElevenLabs call:
 * it consumes no quota and still proves the key is accepted upstream. A key
 * can be syntactically valid but scoped without `user_read` — ElevenLabs
 * reports that as its own 401 `missing_permissions` status, distinct from an
 * outright invalid key, and the operator needs to know which one they're
 * looking at.
 */
async function testElevenLabsKey(
  apiKey: string | null,
  fetchClient: FetchLike,
): Promise<CredentialTestResult> {
  if (!apiKey) {
    return {
      ok: false,
      reason: "No API key configured. Add one on the Providers page.",
    };
  }

  let response: Response;

  try {
    response = await fetchClient(`${ELEVENLABS_API_BASE}/user/subscription`, {
      headers: { "xi-api-key": apiKey },
    });
  } catch {
    return { ok: false, reason: "Could not reach ElevenLabs." };
  }

  if (response.ok) {
    return { ok: true, reason: "ElevenLabs accepted the key." };
  }

  if (response.status === 401) {
    // Deliberately no response body beyond the parsed status/message: the
    // status line plus ElevenLabs' own classification is enough to act on,
    // and the key is never in this body either way.
    let body: ElevenLabsErrorBody | undefined;

    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (body?.detail?.status === "missing_permissions") {
      const missing = body.detail.message ?? "a required permission";
      return {
        ok: false,
        reason: `Key is valid but is missing a permission ElevenLabs needs: ${missing}`,
      };
    }

    return { ok: false, reason: "ElevenLabs rejected this key as invalid." };
  }

  return {
    ok: false,
    reason: `ElevenLabs request failed with status ${response.status} ${response.statusText}.`,
  };
}

export class ProviderCredentialService {
  async list(userId: string): Promise<CredentialSummary[]> {
    return prisma.providerCredential.findMany({
      where: { userId, deletedAt: null },
      orderBy: { provider: "asc" },
      select: SUMMARY_SELECT,
    });
  }

  async upsert(
    userId: string,
    input: UpsertCredentialInput,
  ): Promise<CredentialSummary> {
    const data = {
      encryptedKey: encryptSecret(input.apiKey),
      keyLastFour: input.apiKey.slice(-4),
      label: input.label ?? null,
      isActive: true,
      deletedAt: null,
      // A replaced key invalidates any previous test result.
      lastTestedAt: null,
      lastTestOk: null,
    };

    return prisma.providerCredential.upsert({
      where: { userId_provider: { userId, provider: input.provider } },
      create: { ...data, userId, provider: input.provider },
      update: data,
      select: SUMMARY_SELECT,
    });
  }

  /** Soft delete, so ProviderUsage rows keep their credential reference. */
  async remove(userId: string, provider: AiProviderType): Promise<void> {
    await prisma.providerCredential.updateMany({
      where: { userId, provider, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /** Returns the plaintext key, or null when the operator has not stored one. */
  async resolveKey(
    userId: string,
    provider: AiProviderType,
  ): Promise<string | null> {
    const credential = await prisma.providerCredential.findFirst({
      where: { userId, provider, deletedAt: null, isActive: true },
      select: { encryptedKey: true },
    });

    return credential ? decryptSecret(credential.encryptedKey) : null;
  }

  /**
   * Calls the actual upstream the credential is for, not a stand-in. Each
   * provider gets the cheapest check that still proves the key is accepted
   * upstream — validating the string's shape locally would pass for a
   * revoked key. A provider with no check implemented here must say so
   * rather than reporting `ok`, which is the bug this method exists to
   * avoid: a green tick for a provider nobody actually tested.
   *
   * `fetchClient` defaults to the real `fetch` and exists so tests can
   * substitute a fake instead of making a real network call.
   */
  async test(
    userId: string,
    provider: AiProviderType,
    fetchClient: FetchLike = fetch,
  ): Promise<CredentialTestResult> {
    let result: CredentialTestResult;

    // A stored key that cannot even be decrypted — a rotated encryption key, a
    // row copied between environments — is a failed test, not an exception. The
    // operator needs to see a red badge, not a 500. This also catches the
    // per-provider checks below: a thrown ProviderError becomes its own
    // (key-free) reason instead of an uncaught rejection.
    try {
      const apiKey = await this.resolveKey(userId, provider);
      result = await this.runCheck(provider, apiKey, fetchClient);
    } catch (error) {
      result = {
        ok: false,
        reason:
          error instanceof ProviderError
            ? error.message
            : "The stored key could not be read. Re-enter it and test again.",
      };
    }

    await prisma.providerCredential.updateMany({
      where: { userId, provider, deletedAt: null },
      data: { lastTestedAt: new Date(), lastTestOk: result.ok },
    });

    return result;
  }

  private async runCheck(
    provider: AiProviderType,
    apiKey: string | null,
    fetchClient: FetchLike,
  ): Promise<CredentialTestResult> {
    switch (provider) {
      case "ELEVENLABS":
        return testElevenLabsKey(apiKey, fetchClient);

      case "ANTHROPIC":
        await gatewayProvider.generateScript({
          prompt: "Reply with the single word: ok",
          apiKey: apiKey ?? undefined,
        });
        return { ok: true, reason: "The gateway accepted the key." };

      default:
        // Silently returning `ok: true` here is exactly the bug this method
        // exists to fix — it must be visibly untested, not green.
        return {
          ok: false,
          reason: `${provider} has no connection test implemented yet. This credential has not been verified.`,
        };
    }
  }
}

export const providerCredentialService = new ProviderCredentialService();
