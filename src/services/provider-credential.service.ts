import "server-only";

import type { AiProviderType } from "@/generated/prisma/enums";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import type { UpsertCredentialInput } from "@/schemas/provider.schema";
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
   * A one-token completion is the cheapest call that still proves the key is
   * accepted upstream — validating the string's shape locally would pass for a
   * revoked key.
   */
  async test(userId: string, provider: AiProviderType): Promise<boolean> {
    let ok = false;

    // A stored key that cannot even be decrypted — a rotated encryption key, a
    // row copied between environments — is a failed test, not an exception. The
    // operator needs to see a red badge, not a 500.
    try {
      const apiKey = await this.resolveKey(userId, provider);

      await gatewayProvider.generateScript({
        prompt: "Reply with the single word: ok",
        apiKey: apiKey ?? undefined,
      });

      ok = true;
    } catch {
      ok = false;
    }

    await prisma.providerCredential.updateMany({
      where: { userId, provider, deletedAt: null },
      data: { lastTestedAt: new Date(), lastTestOk: ok },
    });

    return ok;
  }
}

export const providerCredentialService = new ProviderCredentialService();
