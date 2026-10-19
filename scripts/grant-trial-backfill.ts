/**
 * Gives every already-approved account the trial's 3 credits. Accounts approved
 * before billing existed never went through the grant in `accountService.approve`.
 * Idempotent: `grantTrial` writes one `trial` row per user at most, so running
 * this twice is harmless. Run after the add_billing migration, staging first:
 *
 *   pnpm billing:backfill-trial
 */
import { prisma } from "@/lib/prisma";
import { billingService } from "@/services/billing.service";

const users = await prisma.user.findMany({
  where: { approval: "APPROVED" },
  select: { id: true },
});
for (const { id } of users) await billingService.grantTrial(id);
console.log(`Trial credits checked for ${users.length} approved accounts.`);
await prisma.$disconnect();
