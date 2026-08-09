import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";

/**
 * Tests run against a real, shared Supabase database (see src/test/setup.ts)
 * that also holds the operator's real data. `prisma.user.findFirstOrThrow()`
 * used to be how service tests obtained a `userId` — which silently returned
 * the operator's real account. Any table unique on `userId` (e.g.
 * ProviderCredential on `[userId, provider]`) then had a test `upsert`
 * overwrite the operator's real row, and label-scoped cleanup deleted it
 * afterwards believing it was deleting its own fixture. That destroyed a real
 * ElevenLabs credential.
 *
 * The fix: every service test gets its own throwaway `User` row, created
 * here and deleted here. The `.invalid` TLD is reserved by RFC 2606 and can
 * never resolve to a real address, so this email can never collide with — or
 * be mistaken for — an operator's real account.
 */
export async function createTestUser(namePrefix = "test"): Promise<string> {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: {
      name: `${namePrefix}-${token}`,
      email: `test-${token}@framecast.invalid`,
      emailVerified: true,
    },
  });
  return user.id;
}

/**
 * Deletes a test user and everything it owns.
 *
 * Every direct relation off `User` in schema.prisma is `onDelete: Cascade`
 * (sessions, accounts, channels, projects, videos, promptTemplates,
 * providerCredentials, settings) except `ActivityLog.userId`, which is
 * `onDelete: SetNull` — so activity log rows this user's actions created
 * would otherwise survive as orphans with `userId` nulled out instead of
 * being removed. Transitively, `ProviderUsage.credentialId` is also
 * `onDelete: SetNull` (usage rows are meant to outlive a removed credential
 * for the cost dashboard), so a usage row tied to one of this user's
 * credentials would likewise survive, orphaned. Both are deleted explicitly
 * before the user cascade runs. Every other descendant (scripts, scenes,
 * render jobs, publications, prompt variables, ...) cascades transitively
 * through one of the `Cascade` edges above and needs no special handling.
 */
export async function deleteTestUser(userId: string | undefined): Promise<void> {
  if (!userId) return;

  await prisma.activityLog.deleteMany({ where: { userId } });
  await prisma.providerUsage.deleteMany({ where: { credential: { userId } } });
  await prisma.user.deleteMany({ where: { id: userId } });
}
