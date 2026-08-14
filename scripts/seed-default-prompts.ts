/**
 * Gives every operator a default prompt template in each category.
 *
 * Why this exists: `onboarding.service.ts:37` only *checks* whether a user has
 * an `isDefault` SCRIPT template — nothing in the app ever creates one. A user
 * who never visits /prompts and writes one by hand gets a bare
 * `NotFoundError("Default script prompt")` from `script.service.ts:71` the
 * first time they generate, with no hint that authoring a template is the fix.
 *
 * Scope, stated plainly: of the six PromptCategory variants, only SCRIPT is
 * read by the application today. Thumbnail prompts are built in code
 * (`thumbnail.service.ts:168`, `buildPrompt`), and TITLE, DESCRIPTION, TAGS
 * and SCENE have no consumer at all. The templates for those five are seeded
 * because an operator editing a prompt they can see beats one they cannot, and
 * because wiring a category to `getDefault` later is a one-line change once
 * the content already exists. Until that wiring lands, editing them changes
 * nothing about what the app produces.
 *
 * Idempotent: upserts on the `userId_name` unique key, so re-running updates
 * the content of a template this script owns rather than duplicating it. It
 * deliberately does NOT touch a template whose name an operator chose — only
 * the ones named below.
 *
 * Safe to run against prod and staging, repeatedly.
 */
import "dotenv/config";

import type { PromptCategory } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

type Variable = {
  key: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
};

type Template = {
  name: string;
  category: PromptCategory;
  description: string;
  content: string;
  variables: Variable[];
};

/**
 * `topic` is never declared as a variable: `script.service.ts:74-78` injects it
 * from the video's own topic (falling back to its title) before rendering, so
 * declaring it would only let an operator override the video they are working
 * on with a stale default.
 */
const TEMPLATES: Template[] = [
  {
    name: "Default script",
    category: "SCRIPT",
    description: "Baseline narrated explainer. Edit this to change how every script sounds.",
    content: [
      "Write a {{duration}}-minute narration script about: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "How to structure it:",
      "- Open with a hook in the first five seconds that poses the question the video answers. No throat-clearing, no channel introduction, no 'in this video'.",
      "- Then explain in clear beats, each one following from the last.",
      "- Close in a single line. No subscribe request.",
      "",
      "How to write it:",
      "- Every word you write is read aloud by a voice synthesiser exactly as typed. Write spoken prose only — never scene directions, speaker labels, headings, bullet points, or stage notes.",
      "- Short sentences. One idea each. A listener cannot re-read.",
      "- Say concrete numbers and names rather than 'a lot' or 'experts'.",
      "- Never write a URL, a citation, or a SOURCES list into the narration. Put every source in the separate sources field instead — that field is published in the description and is never spoken.",
      "",
      "For each section also give a cue: a short stock-footage search query describing what the viewer should SEE while that line is read. Describe the picture, not the concept — 'printing press running', not 'monetary expansion'.",
    ].join("\n"),
    variables: [
      { key: "duration", label: "Duration (minutes)", defaultValue: "8" },
      { key: "audience", label: "Audience", defaultValue: "curious general viewers" },
      { key: "tone", label: "Tone", defaultValue: "clear, direct and energetic" },
    ],
  },
  {
    name: "Default thumbnail",
    category: "THUMBNAIL",
    description: "Image direction for the thumbnail. Not yet read by the app — see script header.",
    content: [
      "A photorealistic YouTube thumbnail about: {{topic}}",
      "",
      "Subject: {{subject}}",
      "Mood: {{mood}}",
      "",
      "Composition: one clear subject, filling the frame, positioned to the {{subject_side}} so the left third stays clear for a headline. Shallow depth of field. Strong single light source.",
      "",
      "Colour: high contrast and saturated enough to read as a thumbnail at 320 pixels wide on a phone.",
      "",
      "Never render any text, letters, numbers, words, logos, watermarks or captions in the image. The headline is added afterwards.",
    ].join("\n"),
    variables: [
      { key: "subject", label: "Subject", defaultValue: "a single person reacting" },
      { key: "mood", label: "Mood", defaultValue: "tense and urgent" },
      { key: "subject_side", label: "Subject side", defaultValue: "right" },
    ],
  },
  {
    name: "Default title",
    category: "TITLE",
    description: "Title generation. Not yet read by the app — see script header.",
    content: [
      "Write {{count}} YouTube title options for a video about: {{topic}}",
      "",
      "Rules:",
      "- Under 60 characters so none is truncated in search results.",
      "- Front-load the interesting word. The first three words decide the click.",
      "- Promise exactly what the video delivers. Never imply a revelation the script does not contain.",
      "- No ALL CAPS words, no clickbait brackets, no emoji.",
      "- Each option should take a genuinely different angle, not reword the same one.",
    ].join("\n"),
    variables: [{ key: "count", label: "How many options", defaultValue: "5" }],
  },
  {
    name: "Default description",
    category: "DESCRIPTION",
    description: "Description generation. Not yet read by the app — see script header.",
    content: [
      "Write a YouTube description for a video about: {{topic}}",
      "",
      "Structure:",
      "- First two lines: what the viewer learns, written to survive being cut off in the collapsed preview.",
      "- Then a short paragraph of context, no more than four sentences.",
      "- Then a SOURCES heading listing every source the narration cited, one per line.",
      "",
      "Plain sentences. No hashtag walls, no 'smash that like button', no timestamps unless supplied.",
    ].join("\n"),
    variables: [],
  },
  {
    name: "Default tags",
    category: "TAGS",
    description: "Tag generation. Not yet read by the app — see script header.",
    content: [
      "List {{count}} YouTube tags for a video about: {{topic}}",
      "",
      "Rules:",
      "- Terms a viewer would actually type into search, not abstract nouns.",
      "- Mix broad and specific: a few wide category terms, the rest narrow and exact.",
      "- Lowercase. No hashes. No duplicates and no near-duplicates.",
      "- Return them comma separated on one line and nothing else.",
    ].join("\n"),
    variables: [{ key: "count", label: "How many tags", defaultValue: "15" }],
  },
  {
    name: "Default scene",
    category: "SCENE",
    description: "Footage search wording. Not yet read by the app — see script header.",
    content: [
      "Turn this line of narration into a stock-footage search query: {{line}}",
      "",
      "Rules:",
      "- Describe what is visible, never the idea. 'Empty supermarket shelves', not 'supply shortage'.",
      "- Two to five words. Stock libraries match short literal queries best.",
      "- Prefer a subject doing something over a static object.",
      "- No proper nouns unless the footage would genuinely exist.",
      "- Return the query alone, with no explanation and no quotation marks.",
    ].join("\n"),
    variables: [{ key: "line", label: "Narration line", required: true }],
  },
];

async function main() {
  // No soft-delete column on User — every row here is a live account.
  const users = await prisma.user.findMany({ select: { id: true, email: true } });

  if (users.length === 0) {
    console.log("No users in this database — nothing to seed.");
    return;
  }

  let created = 0;
  let updated = 0;

  for (const user of users) {
    for (const template of TEMPLATES) {
      const existing = await prisma.promptTemplate.findUnique({
        where: { userId_name: { userId: user.id, name: template.name } },
        select: { id: true },
      });

      // `isDefault` is only claimed when this user has no default in the
      // category yet. An operator who already marked their own template as the
      // default for a category keeps it — a seed script silently demoting the
      // prompt someone chose is the kind of change nobody notices until their
      // scripts start reading differently.
      const currentDefault = await prisma.promptTemplate.findFirst({
        where: {
          userId: user.id,
          category: template.category,
          isDefault: true,
          deletedAt: null,
          ...(existing ? { NOT: { id: existing.id } } : {}),
        },
        select: { id: true },
      });
      const claimDefault = currentDefault === null;

      const record = await prisma.promptTemplate.upsert({
        where: { userId_name: { userId: user.id, name: template.name } },
        create: {
          userId: user.id,
          name: template.name,
          description: template.description,
          category: template.category,
          content: template.content,
          isDefault: claimDefault,
        },
        update: {
          description: template.description,
          category: template.category,
          content: template.content,
          isDefault: claimDefault,
          deletedAt: null,
        },
        select: { id: true },
      });

      // Variables are replaced wholesale rather than merged: a key removed from
      // TEMPLATES above must stop existing, or a renamed placeholder leaves an
      // orphan row that the dialog still renders as an editable field.
      await prisma.promptVariable.deleteMany({ where: { promptTemplateId: record.id } });
      if (template.variables.length > 0) {
        await prisma.promptVariable.createMany({
          data: template.variables.map((variable) => ({
            promptTemplateId: record.id,
            key: variable.key,
            label: variable.label,
            defaultValue: variable.defaultValue ?? null,
            required: variable.required ?? false,
          })),
        });
      }

      if (existing) updated += 1;
      else created += 1;
    }
  }

  console.log(
    `${users.length} user(s): ${created} template(s) created, ${updated} updated.`,
  );

  const missing = await prisma.user.count({
    where: {
      promptTemplates: { none: { category: "SCRIPT", isDefault: true, deletedAt: null } },
    },
  });
  console.log(`Users still without a default SCRIPT prompt: ${missing}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
