/**
 * Fills schedules' topic queues from a JSON file of `{ "schedule name": [...] }`.
 *
 *   pnpm tsx --conditions=react-server scripts/seed-schedule-topics.ts <email> <topics.json>
 *
 * Pairs with seed-channel-cadence.ts, which creates the schedules deliberately
 * empty. Typing eight subjects into nine schedules through the UI is
 * seventy-two fields; this is one file the operator can keep, diff and re-run.
 *
 * Adds, never replaces. `ScheduleService.addTopics` appends after the highest
 * existing position and the queue is partly *consumed*, so a re-run tops a
 * schedule up rather than resurrecting subjects it has already made videos
 * about. That does mean running it twice with the same file queues everything
 * twice — the summary prints each queue's depth afterwards so that is visible
 * rather than discovered a month later.
 */
import { config } from "dotenv";

// .env.local holds local overrides; it must load first so it wins over the
// docker-compose defaults in .env. Mirrors every other script in this directory.
config({ path: ".env.local" });
config({ path: ".env" });

import { readFileSync } from "node:fs";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [email, file] = process.argv.slice(2);
  if (!email || !file) fail("Usage: seed-schedule-topics.ts <email> <topics.json>");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("The file must be an object keyed by schedule name.");
  }

  const plan = Object.entries(parsed as Record<string, unknown>).map(([name, topics]) => {
    if (!Array.isArray(topics) || topics.some((topic) => typeof topic !== "string")) {
      fail(`"${name}" must map to an array of strings.`);
    }
    return { name, topics: topics as string[] };
  });

  const { prisma } = await import("@/lib/prisma");
  const { scheduleService } = await import("@/services/schedule.service");

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) fail(`No account for ${email}.`);

    // Every name is resolved before a single topic is written. Half-filled
    // queues across nine schedules would be worse to unpick than a refusal.
    const resolved = await Promise.all(
      plan.map(async (entry) => {
        const matches = await prisma.schedule.findMany({
          where: { userId: user.id, name: entry.name, deletedAt: null },
          select: { id: true },
        });
        return { ...entry, matches };
      }),
    );

    const missing = resolved.filter((entry) => entry.matches.length === 0);
    if (missing.length > 0) {
      fail(`No schedule named ${missing.map((entry) => `"${entry.name}"`).join(", ")}.`);
    }

    const ambiguous = resolved.filter((entry) => entry.matches.length > 1);
    if (ambiguous.length > 0) {
      fail(
        `${ambiguous.map((entry) => `"${entry.name}"`).join(", ")} matches more than one schedule. ` +
          "Rename one, or this would fill a queue you did not mean.",
      );
    }

    for (const entry of resolved) {
      const scheduleId = entry.matches[0].id;
      const { added } = await scheduleService.addTopics(user.id, scheduleId, {
        topics: entry.topics,
      });

      const depth = await prisma.scheduleTopic.count({
        where: { scheduleId, consumedAt: null },
      });

      console.log(`  ${entry.name}: +${added}, ${depth} waiting`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
