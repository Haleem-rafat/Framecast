/**
 * Gives every already-approved account the trial's 3 credits. Accounts approved
 * before billing existed never went through the grant in `accountService.approve`.
 * Idempotent: `grantTrial` writes one `trial` row per user at most, so running
 * this twice is harmless. Run after the add_billing migration, staging first:
 *
 *   pnpm billing:backfill-trial
 */
import { config } from "dotenv";

// Same order as every other script here: .env.local wins over .env. The app
// modules are imported below, after this, because `@/config/env` parses
// `process.env` the moment it is imported.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const { prisma } = await import("@/lib/prisma");
const { billingService } = await import("@/services/billing.service");

const users = await prisma.user.findMany({
  where: { approval: "APPROVED" },
  select: { id: true },
});
for (const { id } of users) await billingService.grantTrial(id);
console.log(`Trial credits checked for ${users.length} approved accounts.`);
await prisma.$disconnect();
