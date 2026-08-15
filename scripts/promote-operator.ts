/**
 * Promotes one account to OPERATOR, by hand.
 *
 *   pnpm tsx --conditions=react-server scripts/promote-operator.ts
 *   pnpm tsx --conditions=react-server scripts/promote-operator.ts someone@example.com
 *   pnpm tsx --conditions=react-server scripts/promote-operator.ts --demote someone@example.com
 *
 * ## Why this is a script and not a line in the migration
 *
 * `20260820100000_add_user_role` adds `role` with `DEFAULT 'MEMBER'` and
 * backfills nothing, which leaves the studio with zero operators until this is
 * run. That is not an oversight to be tidied up — it is the fix. The bug being
 * closed is that privilege was being *inferred* (an approved account was
 * treated as the operator), and a migration that guessed which of 41 approved
 * rows deserved the flag would be the same mistake with a timestamp on it.
 * Granting it is a decision, so it is a command somebody types.
 *
 * The email defaults to `OPERATOR_EMAIL` from src/config/site.ts — already
 * public, already in the privacy policy — but only as a default for the
 * argument. The script still has to be invoked; nothing runs it on deploy.
 *
 * ## What it will not do
 *
 * It does not approve anybody. `role` and `approval` are orthogonal (see the
 * UserRole comment in schema.prisma) and an operator whose account is not
 * APPROVED is refused by the session gate before the role is ever read, so
 * quietly flipping both would hide a state the owner needs to see. If the
 * target is not approved this says so and stops.
 *
 * Safe to run twice: an account that is already an OPERATOR is reported as
 * unchanged and no row is written.
 */
import { OPERATOR_EMAIL } from "@/config/site";

interface Options {
  email: string;
  demote: boolean;
}

function parseArgs(argv: string[]): Options {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const positional = argv.filter((arg) => !arg.startsWith("--"));

  return {
    // Normalised the same way Better Auth stores it. An address that differs
    // only in case would otherwise report "no account with that email" while
    // the account sits right there.
    email: (positional[0] ?? OPERATOR_EMAIL).trim().toLowerCase(),
    demote: flags.has("--demote"),
  };
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { email, demote } = parseArgs(process.argv.slice(2));
  const target = demote ? "MEMBER" : "OPERATOR";

  const before = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, approval: true, role: true },
  });

  if (!before) {
    console.error(`No account with the email ${email}.`);
    console.error(
      "Nothing was changed. Check the address, or list accounts with:\n" +
        "  psql -c 'select email, approval, role from \"user\" order by \"createdAt\"'",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  console.log(`Account : ${before.name} <${before.email}>`);
  console.log(`Approval: ${before.approval}`);
  console.log(`Role    : ${before.role}`);

  if (before.role === target) {
    console.log(`\nAlready ${target}. Nothing to do.`);
    await prisma.$disconnect();
    return;
  }

  // Refused rather than fixed up. See the header: an OPERATOR who is not
  // APPROVED cannot use the studio at all, because the session gate checks
  // approval before it ever looks at the role — so promoting one would produce
  // an account that reads as privileged in the database and as locked out in
  // the browser, which is the sort of disagreement that costs an afternoon.
  if (!demote && before.approval !== "APPROVED") {
    console.error(
      `\nSTOP: ${before.email} is ${before.approval}, not APPROVED. The session ` +
        "gate checks approval before role, so promoting this account would " +
        "grant a privilege it cannot use. Approve it first, then run this again.",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const { count } = await prisma.user.updateMany({
    // Conditional on the role we just read, so a concurrent change loses
    // rather than being silently overwritten — the same shape
    // `accountService.decide` uses for approvals.
    where: { id: before.id, role: before.role },
    data: { role: target },
  });

  if (count === 0) {
    console.error(
      `\nSTOP: ${before.email}'s role changed while this script was running. ` +
        "Nothing was written. Run it again to see the current state.",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // The same audit trail an in-app privilege change would leave. Attributed to
  // the account itself because there is no session here — a human at a
  // terminal ran this, and the row says so in its message.
  await prisma.activityLog.create({
    data: {
      userId: before.id,
      level: "WARN",
      action: demote ? "account.role.demoted" : "account.role.promoted",
      entityType: "User",
      entityId: before.id,
      message:
        `${before.email} changed from ${before.role} to ${target} by ` +
        "scripts/promote-operator.ts, run by hand at the server.",
      metadata: { from: before.role, to: target, via: "promote-operator.ts" },
    },
  });

  console.log(`\nChanged: ${before.role} -> ${target} for ${before.email}`);
  console.log("1 account updated, 1 activity log row written.");
  if (!demote) {
    console.log("/approvals and /admin are now reachable by this account.");
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
