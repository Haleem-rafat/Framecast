/**
 * The built-in catalogue of script styles this app ships with.
 *
 * What it is: a set of ready-made prompt templates an operator can read and
 * add to their own Prompt Library with one click. Once added, a style is an
 * ordinary `PromptTemplate` row owned by that operator — theirs to edit,
 * rename or delete, with no link back to the entry it came from and no
 * upstream that can change it under them. Editing a style here changes what a
 * *future* add produces and nothing else.
 *
 * What it is not: a marketplace. There are no payments, no submissions, no
 * ratings, no install counts and no "most popular" — every one of those would
 * be a number this codebase would have to invent.
 *
 * Data in the repository rather than rows in the database, for two reasons.
 * The app ships with the catalogue whether or not a seed has run, and
 * `scripts/seed-default-prompts.ts` reads the first entry from here — so the
 * template every operator starts with and the catalogue's account of that same
 * style cannot drift apart.
 *
 * Client-safe on purpose (no `server-only`): the browse surface on `/prompts`
 * renders these on its first frame.
 *
 * ── Every entry must declare `topic` ────────────────────────────────────────
 * `renderTemplate` treats an entry's declared variables as authoritative and
 * leaves any placeholder without a definition untouched
 * (`prompt-template.ts`), so an undeclared `{{topic}}` reaches the model
 * verbatim — which has already produced a real generated script whose subject
 * was the missing placeholder itself. `script.service.ts` supplying a value is
 * not enough; the declaration is what permits the substitution. `TOPIC` below
 * exists so no entry can forget it.
 *
 * ── Every entry must be renderable ─────────────────────────────────────────
 * This pipeline makes one thing: narration read by a synthetic voice over
 * stock footage, with burnt-in captions and a music bed. There is no presenter,
 * no on-screen text beyond the captions, no charts, no animation and no
 * graphics. A style that says "show the number on screen" describes a video
 * the renderer cannot produce, so every entry states its structure in terms of
 * what can be *said* and what a camera can be *pointed at*.
 */

import type { PromptCategory } from "@/generated/prisma/enums";

/** One declared placeholder, in the shape `PromptVariable` stores. */
export interface ScriptStyleVariable {
  key: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
}

export interface ScriptStyle {
  /**
   * Stable slug, and the only thing a client ever sends to add this style.
   * Never the name or the content: an entry is chosen from a fixed set the
   * server holds, so no request can post arbitrary prompt text through the
   * add action and have it stored as a shipped style.
   */
  id: string;
  /** Becomes the `PromptTemplate.name` of the copy added to a library. */
  name: string;
  /** One line: what it produces and who it suits. */
  description: string;
  category: PromptCategory;
  /** What the style aims at, for the browse card — e.g. "About 4 minutes". */
  targetLength: string;
  content: string;
  variables: ScriptStyleVariable[];
}

/** See the module comment. Every entry spreads this in. */
const TOPIC: ScriptStyleVariable = {
  key: "topic",
  label: "Topic",
  required: true,
};

/**
 * Shared by every style, verbatim, because they are properties of the
 * renderer rather than of any one format: the voice reads what is typed, and
 * each section carries a stock-footage query for what fills the screen while
 * it is read. A style that reworded these would be describing a different
 * pipeline.
 */
const VOICE_RULES = [
  "VOICE — every word is read aloud by a synthetic voice exactly as typed.",
  "- Spoken prose only. Never scene directions, speaker labels, headings, bullet points, stage notes, emoji or asterisks. They will be read out.",
  "- Short sentences, one idea each. A listener cannot re-read a sentence.",
  "- Write numbers the way they are said: 'nineteen twenty-nine', 'four hundred billion dollars', 'twelve per cent'.",
  "- Never write a URL, a citation or a SOURCES list into the narration. Put every source in the separate sources field, which is published in the description and never spoken.",
].join("\n");

const CUE_RULES = [
  "VISUALS — each section carries a cue, a stock-footage search query for what fills the screen while that line is read.",
  "- Describe the picture, never the idea: 'printing press running', not 'monetary expansion'. Stock libraries match what a camera can see.",
  "- Two to five words. Longer queries return nothing.",
  "- Prefer motion and people over static objects.",
  "- Change the cue every section. Repeating a query means the same clip twice in a row, which reads as a glitch.",
  "- Vary the shot scale across neighbouring sections — a wide, then a close-up, then hands or a face. Sequences of identical framing feel like a slideshow.",
  "- Prefer footage that would plausibly exist in a stock library. Historical or highly specific events do not; find the nearest thing a camera really filmed.",
].join("\n");

/**
 * Sourcing, shared for the same reason: this app publishes a SOURCES block in
 * every description, and a style that quietly dropped the discipline would
 * publish uncited claims under the same channel as one that did not.
 */
const SOURCING_RULES = [
  "SOURCES — this video's description publishes them, so they have to be real.",
  "- Every figure, date, name and quoted claim comes from something you can point at. List each one in the sources field.",
  "- If you cannot source a claim, cut the claim. Do not soften it into 'some say' and keep it.",
  "- Never invent a study, a statistic, an expert or a quotation. An invented source is worse than no claim at all, because the description presents it as checked.",
].join("\n");

export const SCRIPT_STYLES: readonly ScriptStyle[] = [
  {
    id: "default-script",
    name: "Default script",
    description:
      "The house style: a long narrated explainer with a cold open, four to seven chapters and an open loop. Suits a channel whose videos answer one substantial question.",
    category: "SCRIPT",
    targetLength: "8–10 minutes",
    // Verbatim what `seed-default-prompts.ts` has always seeded — this entry
    // is where that content now lives, and the seed reads it from here. Do not
    // "tidy" it: every operator's `Default script` template is upserted from
    // this string on every seed run, so a change here rewrites the prompt
    // behind every unedited library in the deployment.
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
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "9" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "curious general viewers",
      },
      { key: "tone", label: "Tone", defaultValue: "clear, direct and energetic" },
    ],
  },

  {
    id: "childrens-content",
    name: "Children's content",
    description:
      "A short, gentle narration for young children: plain words, concrete things, repetition and a calm ending. No peril, no jump scares, no irony.",
    category: "SCRIPT",
    // Four minutes, and the number is a decision rather than a round figure.
    // The audience is roughly three to seven, which is the age band the whole
    // style is written for — literal reading, short sentences, no irony. A
    // single narrated segment for that band runs three to five minutes before
    // it is asking more sustained attention than the format can hold, and the
    // structure here (a naming or counting spine with a repeated line) has
    // nowhere useful to go past about six repetitions. Four minutes is 600
    // words at the pipeline's 150-a-minute reading pace and roughly 27
    // sections — well inside what the renderer already produces for the
    // 60-plus-section default style, so nothing about the format is new to it.
    targetLength: "About 4 minutes",
    content: [
      "Write a {{duration}}-minute narration script for young children, about {{age_range}} years old, on this subject: {{topic}}",
      "",
      "This is read aloud to children who take every word literally. Write it the way a patient adult reads a picture book: unhurried, warm, and always kind.",
      "",
      "SAFETY — these rules come before everything else on this page. Breaking one of them makes the script unusable, however good the rest is.",
      "- Nothing frightening. No monsters, no darkness closing in, no being lost, no being chased, no sudden loud surprises, no cliffhangers, no jump scares.",
      "- Nobody is ever in danger. No injury, no illness, no death, no rescue from danger, no character in distress. Difficulty in this script means a shoe on the wrong foot, not a fall from a tree.",
      "- No behaviour a child could copy and be hurt by. Never describe climbing on furniture, running into water, crossing a road alone, playing with fire, matches, knives, tools, plastic bags, electrical sockets, or an open window.",
      "- Nothing goes in a mouth. No swallowing, tasting or drinking of medicines, vitamins, sweets that are really pills, cleaning products, plants, berries, mushrooms, or anything found outside.",
      "- No stunts, no dares, no tricks, no 'try this at home', no 'see if you can'. Never instruct the viewer to do a physical thing.",
      "- Nothing sexual, nothing violent, no weapons, no fighting — not even play fighting, and not even cartoon fighting.",
      "- No sarcasm, no irony, no jokes that depend on something being untrue. A young child hears the literal words and believes them.",
      "- No fear-based motivation. Never 'if you don't, then...'. Never shame, never scolding, never a character punished.",
      "- No brand names, no characters from films or television, no requests to subscribe, like, buy or ask a grown-up for anything.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute script is about {{duration}} times 150 words. Sentences here are short, so that comes to roughly 25 to 30 sections. Write the whole length — a script that stops after ten sections makes a video that ends before it has arrived anywhere.",
      "",
      "STRUCTURE — a gentle arc, not a plot.",
      "- Open with the friendly thing itself, named plainly. 'Today we are looking at rabbits.' No cold open, no mystery, no question the child cannot answer.",
      "- Then a spine the child can follow and predict. Pick the one that fits the subject: counting up through a small number of things, naming them one at a time, following one day from morning to night, or going through colours or sizes in order.",
      "- Repeat a short line each time the spine turns. The same words, in the same order, every time. Repetition is how this age group joins in, and it is the single most useful thing in the whole script.",
      "- Ask the child a question and then leave a beat before answering it yourself. 'How many can you see? ... There are three.' Never leave a question hanging.",
      "- Slow down at the end rather than building up. The last thirty seconds get quieter, not louder.",
      "- Close by naming what was seen, warmly, and stop. No cliffhanger, no next-time tease.",
      "",
      "WORDS.",
      "- Short sentences. Most of them under ten words. One idea each.",
      "- Concrete nouns only, and things that exist in the room or in the world: a cup, a leaf, a red ball, a small brown dog. Never an abstraction like 'community', 'energy' or 'the environment'.",
      "- Ordinary words a young child already owns. If a word has to be introduced, say it, then say what it means in the same breath, then use it again soon.",
      "- Present tense. Active. 'The bird builds a nest', not 'nests are built by birds'.",
      "- Numbers small and spoken: one, two, three. Never a figure larger than ten unless the subject genuinely is a big number, and then say it plainly.",
      "- Warm and steady, never excited shouting. No exclamation marks stacked up, no 'WOW', no capitals.",
      "",
      VOICE_RULES,
      "",
      SOURCING_RULES,
      "- This matters more here than anywhere else on the channel. A child cannot check anything, so an invented fact goes in as true and stays. If you are not certain a rabbit does the thing you were about to say, say something you are certain of instead.",
      "",
      CUE_RULES,
      "- Every cue must be gentle and bright: daylight, open space, soft colours, calm movement. Animals, children playing safely, plants growing, everyday objects, simple crafts.",
      "- Never cue anything dark, fast, loud-looking, crowded, medical, or in any way alarming. No storms, no traffic, no crowds, no hospitals, no night scenes, no fire, no machinery with blades.",
      "- Never cue footage of a child doing something the safety rules above forbid a child from doing.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "4" },
      { key: "age_range", label: "Age range", defaultValue: "three to seven" },
    ],
  },

  {
    id: "case-study",
    name: "Case study",
    description:
      "One real story told in order, from the decision to the consequence. Suits a channel that explains an idea through a single company, person or event.",
    category: "SCRIPT",
    targetLength: "About 7 minutes",
    content: [
      "Write a {{duration}}-minute narration script telling one story: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is not an overview. It is one case, followed from beginning to end, with the general point emerging from it rather than being announced over it.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words. At about 22 words a section that is around 45 to 50 sections. Keep writing until the story is genuinely finished at that length.",
      "",
      "STRUCTURE — chronological, and only chronological.",
      "- Open on the moment things changed, before explaining who anybody is. A scene, a date, a decision. The viewer should be curious about the people before they are introduced.",
      "- Then go back and set the situation up: who, where, when, and what the constraint was. Two minutes at most.",
      "- Then the sequence, in order, one step per beat. What was tried, what happened, what that forced next. Never jump forward to the outcome and come back.",
      "- Name the turn. There is one moment where the outcome became likely; say which it was and why.",
      "- Then the consequence, and how long it took to arrive. Most consequences are slower than the story that caused them.",
      "- Only in the last minute, draw the general point — one paragraph, stated once. If the story needed the point explained twice, the story was told badly.",
      "- Close on a concrete image or figure from the case, not on a moral.",
      "",
      "DISCIPLINE.",
      "- Real names, real dates, real figures throughout. A case study with anonymised participants is a parable, and a parable does not need seven minutes.",
      "- No invented dialogue and no imagined interior thoughts. If a person said something, quote what they said; if nobody recorded it, describe what they did instead.",
      "- No counterfactuals presented as fact. 'It might have gone differently' is fine; 'it would have gone differently' is a claim nobody can source.",
      "- Vary sentence length deliberately. Several short ones, then a longer one. Monotone rhythm is what makes synthetic narration sound synthetic.",
      "",
      VOICE_RULES,
      "",
      SOURCING_RULES,
      "",
      CUE_RULES,
      "- Follow the story's own settings: where it physically happened, what the work looked like, what the objects were. A case study cued entirely with office stock footage looks like every other video on the internet.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "7" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "curious general viewers",
      },
      { key: "tone", label: "Tone", defaultValue: "measured and specific" },
    ],
  },

  {
    id: "countdown",
    name: "Countdown",
    description:
      "A ranked list counted down to number one, each entry a self-contained beat. Suits browsable topics where every item stands alone.",
    category: "SCRIPT",
    targetLength: "About 6 minutes",
    content: [
      "Write a {{duration}}-minute narration script counting down {{count}} things: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 40 sections at 22 words each. Divide the body evenly: each of the {{count}} entries gets a comparable share. An entry that runs three times longer than its neighbours tells the viewer the rest were filler.",
      "",
      "STRUCTURE.",
      "- Open on the most surprising detail from anywhere in the list, without saying which entry it belongs to. Then say what is being counted down and how many there are.",
      "- Count down from {{count}} to one. Say each number out loud as you reach it — the pipeline renders footage and captions only, so a number that is not spoken is a number nobody receives.",
      "- Each entry: name it, say the one specific fact that earns its place, then the detail nobody expects. Three beats, then move on.",
      "- Do not compare entries to each other. Each has to stand alone, because a viewer who joined halfway is the normal case for this format.",
      "- The ranking must be defensible and stated. Say near the start what the order is by — size, age, cost, speed, whatever it is — and keep to it. An unexplained ranking is the thing this format is most often accused of.",
      "- Number one gets the strongest fact of the whole script. If the best fact belongs to number four, the ranking is wrong.",
      "- Close in two lines. No recap of the list; the viewer just heard it.",
      "",
      VOICE_RULES,
      "- Never write '5.' or '#5'. Write 'number five', because the voice reads what is typed.",
      "",
      SOURCING_RULES,
      "",
      CUE_RULES,
      "- Cue the entry itself, not the counting. Each entry is a different subject, so this format gets more visual variety than any other — use it.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "6" },
      { key: "count", label: "How many entries", defaultValue: "7" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "curious general viewers",
      },
      { key: "tone", label: "Tone", defaultValue: "brisk and confident" },
    ],
  },

  {
    id: "myths-and-facts",
    name: "Myths and facts",
    description:
      "Widely believed claims taken one at a time and checked against what is actually known. Suits subjects where the audience arrives already holding an answer.",
    category: "SCRIPT",
    targetLength: "About 6 minutes",
    content: [
      "Write a {{duration}}-minute narration script examining {{count}} common beliefs about: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 40 sections at 22 words each. Split it evenly across the {{count}} beliefs.",
      "",
      "STRUCTURE — one belief at a time, each in the same four moves.",
      "- State the belief plainly and fairly, in the words someone who holds it would use. Never set up a version nobody actually believes so it can be knocked down.",
      "- Say where it came from. Most durable beliefs started as something reasonable, and that origin is usually the most interesting part of the segment.",
      "- Say what is actually known, with the specific evidence. Name the study, the measurement, the year, the number.",
      "- Say precisely how wrong it is. Most beliefs are not simply false: they are true in a narrow case, or were true and stopped being true, or confuse two things. 'Half right, and here is which half' is a better and more honest payoff than 'false'.",
      "- Open with the belief the audience is most likely to hold themselves, and keep the one with the best evidence for last.",
      "- Close by naming the pattern behind them — what these beliefs have in common — in two or three lines.",
      "",
      "DISCIPLINE — this format fails in one specific way, so guard against it.",
      "- Never overcorrect. Replacing a wrong claim with an equally overconfident opposite is the same error facing the other way.",
      "- Where the evidence is genuinely unsettled, say so and say why, and do not pick a side to make the segment land.",
      "- Never mock anyone for holding the belief.",
      "",
      VOICE_RULES,
      "- Vary sentence length deliberately. Several short ones, then a longer one. Monotone rhythm is what makes synthetic narration sound synthetic.",
      "",
      SOURCING_RULES,
      "- A correction with no source behind it is just a different unsourced claim. Every belief examined here needs its evidence listed.",
      "",
      CUE_RULES,
      "- Cue the subject, never the argument. There is no footage of a claim being false — point the camera at the thing the claim is about.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "6" },
      { key: "count", label: "How many beliefs", defaultValue: "5" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "curious general viewers",
      },
      { key: "tone", label: "Tone", defaultValue: "fair-minded and precise" },
    ],
  },
];

/** The catalogue entry a slug names, or null. The add path's only lookup. */
export function findScriptStyle(id: string): ScriptStyle | null {
  return SCRIPT_STYLES.find((style) => style.id === id) ?? null;
}

/**
 * The style `seed-default-prompts.ts` seeds as every operator's starting
 * SCRIPT template. Named rather than indexed so reordering the catalogue for
 * display cannot change what a fresh account is seeded with.
 */
export const SEEDED_SCRIPT_STYLE_ID = "default-script";
