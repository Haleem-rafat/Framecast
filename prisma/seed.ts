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
      isDefault: true,
      description: "Baseline narrated explainer script.",
      content:
        "You are writing a {{duration}}-minute narration script for Money Mechanics, " +
        "a YouTube channel that explains how business and money actually work.\n\n" +
        "Topic: {{topic}}\n" +
        "Audience: {{audience}}\n" +
        "Tone: {{tone}}\n\n" +
        "Rules — these are not stylistic preferences:\n" +
        "- Explain how something works or what happened. Never give financial advice.\n" +
        "- Never recommend buying or selling any asset, stock, or cryptocurrency.\n" +
        "- Never predict a price or promise a return.\n" +
        "- Every factual claim must name its source inline, e.g. (SEC filing, 2001).\n" +
        // Every word of the narration is spoken by a text-to-speech voice, so
        // a SOURCES list written into the script is a list of URLs read aloud.
        // The structured-output schema (see gateway.provider.ts) carries a
        // `sources` field for exactly this, and it never reaches the audio —
        // publish.service.ts turns it into the video description's SOURCES
        // block instead.
        "- Put the full reference for each source in the `sources` field, one entry each.\n" +
        "- Never write a SOURCES list, a URL, or a citation list into the narration " +
        "itself — every word of the narration is read aloud.\n\n" +
        "Structure: a hook in the first 5 seconds that poses the question, " +
        "then the explanation in clear beats, then a one-line close. " +
        "Write spoken prose only — no scene directions, no speaker labels.",
      variables: [
        { key: "topic", label: "Topic", required: true },
        { key: "duration", label: "Duration (minutes)", defaultValue: "8" },
        { key: "audience", label: "Audience", defaultValue: "general viewers" },
        { key: "tone", label: "Tone", defaultValue: "clear and energetic" },
      ],
    },
    {
      // The single-insight short's Stage 1 prompt — see
      // docs/superpowers/specs/2026-08-17-knowsense-format-design.md.
      //
      // Not marked `isDefault`, unlike the two beside it: this is one format
      // among several rather than what an operator gets when they generate a
      // script without choosing. It is picked by name on a video, or pinned on
      // a Series via `Series.promptTemplateId`.
      //
      // The model is not named here and does not need to be. The pack that
      // decoded this format specified `claude-sonnet-4-6`, which does not
      // exist; `env.AI_SCRIPT_MODEL` already defaults to
      // `anthropic/claude-sonnet-5`, which is what every script in this app is
      // written with and what this one wants.
      //
      // The rules below are the format's, restated for a model that has never
      // seen it. They are deliberately the same rules `src/lib/insight-script.ts`
      // enforces — that module is the gate, this is the brief, and a script
      // that reads this and still fails the gate gets the gate's own sentences
      // appended and one more try (see `ScriptService.generate`).
      name: "Single-insight short",
      category: "SCRIPT" as const,
      description:
        "One behavioural insight in 40-55 vertical seconds, paid off by naming a real psychological effect. Six beats, one sentence a scene.",
      content:
        "Write a {{duration}}-second vertical short that explains ONE behavioural " +
        "insight and pays it off by naming the real psychological effect behind it.\n\n" +
        "Topic: {{topic}}\n" +
        "Audience: {{audience}}\n\n" +
        "Structure — six beats, in this order, each covering one or more scenes:\n" +
        "- HOOK: a specific thing the viewer has done, stated as fact. No question, " +
        "no greeting, no channel name.\n" +
        "- TENSION: why that thing does not make sense.\n" +
        "- MECHANISM: what is actually happening, in plain language.\n" +
        "- NAME_IT: the real, established effect this is. Name it.\n" +
        "- TURN: what changes once you know.\n" +
        "- LOOP: a closing line that lands back on the opening image.\n\n" +
        "Voice — these are not stylistic preferences:\n" +
        "- Second person throughout. You, your. Never 'we', never 'people'.\n" +
        "- One sentence per scene, 8 to 14 words, one clause, ending in a full stop.\n" +
        "- Flat and certain. No hype, no hedging, no rhetorical questions.\n" +
        "- No dashes, no emoji, no stage directions, no speaker labels.\n" +
        "- Never write: in this video, let's dive in, here's the thing, studies show, " +
        "mind-blowing, game-changer, unlock, crazy, insane.\n" +
        "- The effect you name must be a real one that already has that name. If you " +
        "cannot name a real one for this topic, pick the adjacent insight that has one.\n\n" +
        "Length: 95 to 150 words of narration in total, across 8 to 14 scenes. Each " +
        "scene declares a duration between 2.5 and 5.0 seconds, and the declared " +
        "durations must add up to roughly the time the words take to say at 2.6 words " +
        "a second.\n\n" +
        "Visuals: one shot per scene, described as a shot rather than as an idea. The " +
        "picture is an emotional rhyme of the line, not an illustration of it — memory " +
        "is not a brain, it is a woman pausing in a doorway. A different person may " +
        "appear in every shot; nothing about the look is your concern beyond what is " +
        "happening in the frame.\n\n" +
        "Emphasis: for each scene, list the words the voice should lean on. Every one " +
        "must appear in that scene's own narration exactly as written.",
      variables: [
        { key: "topic", label: "Topic", required: true },
        { key: "duration", label: "Target length (seconds)", defaultValue: "45" },
        { key: "audience", label: "Audience", defaultValue: "general viewers" },
      ],
      isDefault: false,
    },
    {
      name: "Default thumbnail",
      category: "THUMBNAIL" as const,
      isDefault: true,
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
        // `isDefault` is per template rather than assumed: the single-insight
        // prompt is one format among several, and marking it default would
        // make every video that generates a script without choosing one a
        // forty-second short.
        ...data,
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
