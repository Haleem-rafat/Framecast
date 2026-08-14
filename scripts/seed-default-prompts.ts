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
 * `topic` MUST be declared on every template whose content uses `{{topic}}`,
 * even though `script.service.ts:74-78` supplies its value automatically.
 * `renderTemplate` treats the declared variables as authoritative and leaves
 * any placeholder without a definition untouched (`prompt-template.ts:33-37`),
 * so an undeclared `{{topic}}` reaches the model verbatim — which produced a
 * real generated script whose subject was the missing placeholder itself.
 * Supplying a value is not enough; the declaration is what permits the
 * substitution.
 */
const TOPIC_VARIABLE: Variable = { key: "topic", label: "Topic", required: true };
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
      "LENGTH — this matters more than anything else here.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words of narration. Each section is about 22 words, so that is well over a hundred sections. Keep writing until you reach that length. A script that runs short is the single most common failure: do not stop at twenty sections and call it finished.",
      "",
      "STRUCTURE — hold attention for the whole runtime.",
      "- Cold open. The first sentence states the strangest, most specific fact you have. Not a summary, not a greeting, not 'in this video'. Something that makes stopping feel like a loss.",
      "- Then a promise: name the question the rest of the video answers.",
      "- Then chapters. Four to seven of them, each one a self-contained beat with its own small hook and its own small payoff. A chapter that only sets up the next one is where a viewer leaves.",
      "- Open a loop early and close it late. Ask something in the first minute you do not answer until the last.",
      "- Change gear every ninety seconds or so: after a stretch of explanation, land a number, a name, a date, a short story, or a direct question. Sustained exposition is what loses the second half of an audience.",
      "- Land the payoff before the close. The most satisfying fact goes near the end, not buried in the middle.",
      "- Close in one or two lines that resolve the opening loop. No subscribe request, no 'thanks for watching'.",
      "",
      "VOICE — every word is read aloud by a synthetic voice exactly as typed.",
      "- Spoken prose only. Never scene directions, speaker labels, headings, bullet points, stage notes, emoji or asterisks. They will be read out.",
      "- Short sentences, one idea each. A listener cannot re-read a sentence.",
      "- Write numbers the way they are said: 'nineteen twenty-nine', 'four hundred billion dollars', 'twelve per cent'.",
      "- Concrete over vague. A named company, a real year, an exact figure — never 'a lot', 'experts say', or 'studies show'.",
      "- Vary sentence length deliberately. Several short ones, then a longer one. Monotone rhythm is what makes synthetic narration sound synthetic.",
      "- Never write a URL, a citation or a SOURCES list into the narration. Put every source in the separate sources field, which is published in the description and never spoken.",
      "",
      "VISUALS — each section carries a cue, a stock-footage search query for what fills the screen while that line is read.",
      "- Describe the picture, never the idea: 'printing press running', not 'monetary expansion'. Stock libraries match what a camera can see.",
      "- Two to five words. Longer queries return nothing.",
      "- Prefer motion and people over static objects: 'trader shouting on floor' beats 'stock chart'.",
      "- Change the cue every section. Repeating a query means the same clip twice in a row, which reads as a glitch.",
      "- Vary the shot scale across neighbouring sections — a wide, then a close-up, then hands or a face. Sequences of identical framing feel like a slideshow.",
      "- Prefer footage that would plausibly exist in a stock library. Historical or highly specific events do not; find the nearest thing a camera really filmed.",
    ].join("\n"),
    variables: [
      TOPIC_VARIABLE,
      { key: "duration", label: "Duration (minutes)", defaultValue: "9" },
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
      TOPIC_VARIABLE,
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
    variables: [TOPIC_VARIABLE, { key: "count", label: "How many options", defaultValue: "5" }],
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
    variables: [TOPIC_VARIABLE],
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
    variables: [TOPIC_VARIABLE, { key: "count", label: "How many tags", defaultValue: "15" }],
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
