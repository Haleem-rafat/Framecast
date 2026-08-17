/**
 * Gives a channel a publishing cadence: one project, and one weekly schedule
 * per requested day.
 *
 *   pnpm tsx --conditions=react-server scripts/seed-channel-cadence.ts <email> "<channel>" <days> <hh:mm> <tz>
 *   pnpm tsx --conditions=react-server scripts/seed-channel-cadence.ts me@example.com "Dev Pixel" 1,3,5 09:00 Europe/London
 *
 * ## Why a script and not a seed
 *
 * Nothing here is derivable. Which days a channel publishes, at what hour, in
 * whose timezone — those are editorial decisions, and a seed that guessed them
 * would be inventing an answer to "when does my video go out", which is the one
 * thing this must not get wrong quietly. So it is a command somebody types,
 * with the answers as arguments.
 *
 * ## Why it calls the services rather than writing rows
 *
 * `ScheduleService.create` computes `nextRunAt` from the recurrence, refuses a
 * project that cannot produce, and checks the answers against the variables the
 * operator's default SCRIPT prompt actually declares. A script that INSERTed
 * straight into `schedule` would skip all three and leave rows the tick loop
 * chokes on weeks later.
 *
 * Safe to run twice: a schedule whose name is already taken on that project is
 * reported as unchanged and no row is written.
 */
import { config } from "dotenv";

// .env.local holds local overrides; it must load first so it wins over the
// docker-compose defaults in .env. Mirrors prisma.config.ts, src/lib/prisma.ts
// and every other script in this directory.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything that reaches `@/config/env` — which parses `process.env` at import
// time — is imported inside `main`, below the two lines above. A static import
// would run first and read every variable as unset.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseDays(raw: string): number[] {
  const days = raw.split(",").map((part) => Number(part.trim()));

  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    fail(`Days must be 0–6, comma separated, 0 = Sunday. Got "${raw}".`);
  }

  const unique = [...new Set(days)];
  if (unique.length !== days.length) {
    fail(`Repeated day in "${raw}" — each day gets one schedule.`);
  }

  return unique;
}

function parseTime(raw: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) fail(`Time must look like 09:00. Got "${raw}".`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) fail(`"${raw}" is not a real time of day.`);

  return { hour, minute };
}

function assertZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    fail(`"${zone}" is not an IANA timezone. Try Europe/London or Africa/Cairo.`);
  }
  return zone;
}

async function main(): Promise<void> {
  const [email, channelTitle, rawDays, rawTime, rawZone] = process.argv.slice(2);

  if (!email || !channelTitle || !rawDays || !rawTime || !rawZone) {
    fail(
      'Usage: seed-channel-cadence.ts <email> "<channel title>" <days 0-6> <hh:mm> <IANA timezone>',
    );
  }

  const days = parseDays(rawDays);
  const { hour, minute } = parseTime(rawTime);
  const timeZone = assertZone(rawZone);

  const { PromptCategory } = await import("@/generated/prisma/enums");
  const { prisma } = await import("@/lib/prisma");
  const { projectService } = await import("@/services/project.service");
  const { scheduleService } = await import("@/services/schedule.service");

  try {
    const user = await prisma.user.findUnique({
      // Normalised the way Better Auth stores it, so an address differing only
      // in case does not report "no account" while the account sits right there.
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) fail(`No account for ${email}.`);

    const channel = await prisma.channel.findFirst({
      where: { userId: user.id, title: channelTitle, deletedAt: null },
      select: { id: true, title: true, brand: { select: { tone: true, niche: true } } },
    });
    if (!channel) fail(`${user.email} has no channel titled "${channelTitle}".`);

    // A schedule with no default SCRIPT prompt has nothing to generate from, and
    // `create` would reject each one separately. Say it once, up front.
    const defaultPrompt = await prisma.promptTemplate.findFirst({
      where: { userId: user.id, category: PromptCategory.SCRIPT, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    if (!defaultPrompt) {
      fail(`${user.email} has no default SCRIPT prompt, so a schedule has nothing to run.`);
    }

    const project =
      (await prisma.project.findFirst({
        where: { userId: user.id, channelId: channel.id, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      })) ??
      (await projectService.create(user.id, {
        name: channel.title,
        description: `Scheduled output for ${channel.title}.`,
        channelId: channel.id,
      }));

    console.log(`Channel  ${channel.title}`);
    console.log(`Project  ${project.name}`);

    // The brand already carries the channel's voice, colours and footage style;
    // repeating those here would give the operator two places to change one
    // thing. Only what the default prompt actually asks for is copied.
    const variables: Record<string, string> = {};
    if (channel.brand?.tone) variables.tone = channel.brand.tone;
    if (channel.brand?.niche) variables.audience = channel.brand.niche;

    for (const day of days) {
      const name = `${channel.title} — ${DAY_NAMES[day]}`;

      const existing = await prisma.schedule.findFirst({
        where: { userId: user.id, projectId: project.id, name, deletedAt: null },
        select: { id: true },
      });
      if (existing) {
        console.log(`  = ${name} (already there)`);
        continue;
      }

      // The topic queue is seeded empty on purpose. A schedule that runs dry
      // pauses itself rather than inventing a subject, and inventing three
      // months of subjects here is the thing that behaviour exists to prevent.
      const created = await scheduleService.create(user.id, {
        name,
        projectId: project.id,
        frequency: "WEEKLY",
        dayOfWeek: day,
        dayOfMonth: null,
        hour,
        minute,
        timeZone,
        // Seeded off, like the column's default. A script that provisions
        // cadences in bulk is the last place that should decide, on somebody's
        // behalf, that their channel starts publishing without them.
        autoPublish: false,
        publishVisibility: "PRIVATE",
        variables,
        topics: [],
      });

      const row = await prisma.schedule.findUniqueOrThrow({
        where: { id: created.id },
        select: { nextRunAt: true },
      });

      console.log(`  + ${name} — first run ${row.nextRunAt?.toISOString() ?? "none"}`);
    }

    console.log("\nTopic queues are empty. Add topics on each schedule, or the first run skips.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
