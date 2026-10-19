/**
 * Approves every account still waiting (approval PENDING) and gives each one
 * the trial's credits — the one-off catch-up for accounts that registered
 * before sign-ups were approved automatically. Rejected accounts stay
 * rejected. Safe to run twice.
 *
 *   pnpm accounts:approve-pending
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const { prisma } = await import("@/lib/prisma");
const { billingService } = await import("@/services/billing.service");

const waiting = await prisma.user.findMany({ where: { approval: "PENDING" }, select: { id: true } });
for (const { id } of waiting) {
  await prisma.user.update({ where: { id }, data: { approval: "APPROVED", approvedAt: new Date() } });
  await billingService.grantTrial(id);
}
console.log(`Approved ${waiting.length} waiting account${waiting.length === 1 ? "" : "s"}.`);
await prisma.$disconnect();
