import "dotenv/config";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Creates the single studio operator plus their default settings and starter
 * prompt templates. Idempotent: re-running against a seeded database is a
 * no-op rather than an error.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_USER_EMAIL;
  const password = process.env.SEED_USER_PASSWORD;
  const name = process.env.SEED_USER_NAME ?? "Studio Operator";

  if (!email || !password) {
    throw new Error(
      "SEED_USER_EMAIL and SEED_USER_PASSWORD must be set to seed the operator account.",
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`✓ User ${email} already exists — skipping account creation.`);
  } else {
    // Routed through Better Auth so the password is hashed with the same
    // algorithm the sign-in path verifies against.
    await auth.api.signUpEmail({ body: { email, password, name } });
    console.log(`✓ Created operator account ${email}`);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  await prisma.userSetting.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
  });
  console.log("✓ Default settings ready");

  const templates = [
    {
      name: "Default script",
      category: "SCRIPT" as const,
      description: "Baseline narrated explainer script.",
      content:
        "Write a {{duration}}-minute YouTube script about {{topic}}.\n" +
        "Audience: {{audience}}.\n" +
        "Tone: {{tone}}.\n" +
        "Open with a hook in the first 5 seconds, then deliver the content in clear beats, and close with a call to action.",
      variables: [
        { key: "topic", label: "Topic", required: true },
        { key: "duration", label: "Duration (minutes)", defaultValue: "8" },
        { key: "audience", label: "Audience", defaultValue: "general viewers" },
        { key: "tone", label: "Tone", defaultValue: "clear and energetic" },
      ],
    },
    {
      name: "Default thumbnail",
      category: "THUMBNAIL" as const,
      description: "High-contrast thumbnail concept.",
      content:
        "A bold, high-contrast YouTube thumbnail about {{topic}}. " +
        "Single clear focal subject, dramatic lighting, saturated colours, " +
        "generous negative space on the {{text_side}} for overlaid text. No text in the image.",
      variables: [
        { key: "topic", label: "Topic", required: true },
        { key: "text_side", label: "Text side", defaultValue: "left" },
      ],
    },
  ];

  for (const template of templates) {
    const { variables, ...data } = template;

    await prisma.promptTemplate.upsert({
      where: { userId_name: { userId: user.id, name: data.name } },
      update: {},
      create: {
        ...data,
        isDefault: true,
        userId: user.id,
        variables: { create: variables },
      },
    });
  }
  console.log(`✓ Seeded ${templates.length} prompt templates`);
}

main()
  .then(() => console.log("\nSeed complete."))
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
