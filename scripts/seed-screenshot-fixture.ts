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
  "In nineteen hundred and one, sponge divers off a Greek island pulled a lump of corroded bronze out of a shipwreck.",
  "It sat in a museum drawer for fifty years before anyone worked out what it was.",
  "Inside were at least thirty interlocking gears, cut by hand, some with teeth barely a millimetre across.",
  "It predicted eclipses. It tracked the moon's irregular orbit. It marked the four-year cycle of the games at Olympia.",
  "Nothing of comparable complexity appears again for well over a thousand years.",
  "The obvious question is who built it, and the honest answer is that we do not know.",
  "What we do know is that a device this refined is never the first attempt.",
  "Somewhere behind it sits a workshop, a tradition, and a great many failures nobody kept.",
  "That is the part engineers still find unsettling. Not the object. The silence around it.",
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
    data: { userId: user.id, name: "Machines & Makers" },
  });

  // DRAFT deliberately: that is the state where the script panel and the
  // Approve button are both on screen, which is the argument the landing page
  // is making — the operator reads it before anything runs.
  const video = await prisma.video.create({
    data: {
      userId: user.id,
      projectId: project.id,
      title: "Why the Antikythera mechanism still puzzles engineers",
      topic: "the Antikythera mechanism and what it implies about lost engineering",
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
