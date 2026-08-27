import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Who exists in this database, and what each account is able to do.
 *
 *   pnpm tsx --conditions=react-server scripts/list-accounts.ts
 *
 * ## What it is for
 *
 * Two questions, both of which otherwise mean opening the studio as somebody
 * else or writing a query by hand:
 *
 *   - "what is the project id" — every script here that drives the pipeline
 *     takes one, and there is nowhere else to read it.
 *   - "why did that account's generation fail" — a missing provider key and a
 *     disconnected channel both surface downstream as something vaguer, and
 *     both are visible here.
 *
 * Provider keys are listed by NAME only. This never reads or prints a stored
 * credential — `ProviderCredential` holds them encrypted and the whole point of
 * that is that a convenience script cannot undo it.
 *
 * Read-only.
 */

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      role: true,
      approval: true,
      channels: { select: { title: true, deletedAt: true } },
      providerCredentials: { select: { provider: true } },
      projects: {
        where: { deletedAt: null },
        select: { id: true, name: true, channelId: true },
      },
    },
  });

  for (const user of users) {
    console.log(`\n${user.email}  [${user.role}/${user.approval}]`);

    const channels = user.channels
      .map((channel) => channel.title + (channel.deletedAt ? " (disconnected)" : ""))
      .join(" | ");

    console.log(`  channels  ${channels || "none"}`);
    console.log(
      `  keys      ${user.providerCredentials.map((c) => c.provider).join(", ") || "none"}`,
    );

    for (const project of user.projects) {
      // A project with no channel cannot publish, which is worth seeing here
      // rather than discovering at the end of a pipeline run.
      console.log(
        `  project   ${project.id}  ${project.name}${project.channelId ? "" : "  (no channel)"}`,
      );
    }
  }

  console.log();
  await prisma.$disconnect();
}

void main();
