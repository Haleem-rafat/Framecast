/**
 * Creates a throwaway, fully-populated DRAFT video for capturing product
 * screenshots.
 *
 * The landing page needs a real picture of the studio, and the only honest
 * source of one is the studio itself. Fabricating a mockup for a page that
 * sells the product is the kind of dishonesty that is hard to walk back, so
 * this seeds a real account with real rows and lets a browser photograph it.
 *
 * Everything it writes is disposable and namespaced by the email it is given,
 * so `deleteTestUser`-style cleanup is a single cascade from the User row.
 *
 * Run against staging only. One-shot: delete once the captures are taken.
 */
import { config } from "dotenv";

// `.env.local` holds the local overrides and must load first so it wins over
// `.env`. Mirrors src/lib/prisma.ts, prisma.config.ts and the other scripts —
// a bare `import "dotenv/config"` reads only `.env` and leaves `@/config/env`
// throwing on variables that are in fact present.
config({ path: ".env.local" });
config({ path: ".env" });

const SCRIPT = [
  "In two thousand and one, Apple was a computer company with four per cent of the market.",
  "Today it moves more money in a quarter than most countries make in a year.",
  "The interesting part is not the phone. It is what Apple built around it.",
  "Every device sold pulls the buyer further into a system they cannot easily leave.",
  "A watch that only pairs with an iPhone. Messages that break when a friend switches.",
  "Photographs that live in a library you rent by the month.",
  "None of this is an accident. It is the product.",
  "Analysts call it an ecosystem. Economists call it a switching cost.",
  "The difference between those two words is worth about two trillion dollars.",
].join(" ");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const email = process.argv[2];

  if (!email) {
    console.error("Usage: tsx scripts/seed-screenshot-fixture.ts <email>");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  if (!user) {
    console.error(`No user with email ${email}. Sign up first.`);
    process.exitCode = 1;
    return;
  }

  // Approved so the session gate lets the browser past /pending.
  await prisma.user.update({
    where: { id: user.id },
    data: { approval: "APPROVED", approvedAt: new Date() },
  });

  const project = await prisma.project.create({
    data: { userId: user.id, name: "Money Mechanics" },
  });

  // DRAFT deliberately: that is the state where the script panel and the
  // Approve button are both on screen, which is the argument the landing page
  // is making — the operator reads it before anything runs.
  const video = await prisma.video.create({
    data: {
      userId: user.id,
      projectId: project.id,
      title: "The Trillion-Dollar Ecosystem: How Apple Prints Money",
      topic: "how Apple's ecosystem creates switching costs",
      status: "DRAFT",
    },
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: 1,
      content: SCRIPT,
      wordCount: SCRIPT.trim().split(/\s+/).length,
    },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  console.log(video.id);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
