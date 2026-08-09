"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import type { AiProviderType } from "@/generated/prisma/enums";
import { upsertCredentialSchema } from "@/schemas/provider.schema";
import { requireSession } from "@/server/session";
import {
  providerCredentialService,
  type CredentialSummary,
} from "@/services/provider-credential.service";

export async function upsertCredentialAction(
  input: unknown,
): Promise<ActionResult<CredentialSummary>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = upsertCredentialSchema.parse(input);
    const saved = await providerCredentialService.upsert(session.user.id, parsed);

    revalidatePath("/providers");

    return saved;
  });
}

export async function removeCredentialAction(
  provider: AiProviderType,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await providerCredentialService.remove(session.user.id, provider);

    revalidatePath("/providers");

    return null;
  });
}

export async function testCredentialAction(
  provider: AiProviderType,
): Promise<ActionResult<{ ok: boolean }>> {
  return run(async () => {
    const session = await requireSession();
    const ok = await providerCredentialService.test(session.user.id, provider);

    revalidatePath("/providers");

    return { ok };
  });
}
