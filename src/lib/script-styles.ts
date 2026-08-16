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
 *
 * ── The developer styles, and why none of them is a tutorial ────────────────
 * The same limit decides the shape of every technical entry here. There is no
 * syntax-highlighted code renderer, no screen recording and no editor capture:
 * footage is stock video matched per section by keyword, so "let's look at
 * this function" buys a clip of somebody at a laptop. That rules out the
 * tutorial genre entirely and leaves the one this pipeline is actually good
 * at — narrated explainers whose value is carried by the words: architecture,
 * post-mortems, origin histories, comparisons, essays about the craft. Each of
 * those entries says so in the prompt itself, because the model has to know it
 * is writing for the ear alone.
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
  /**
   * The same figure as a number of seconds, and the reason both exist.
   *
   * `targetLength` is prose for a card and is deliberately vague where the
   * style is ("8–10 minutes"). Nothing can compare prose against a platform
   * limit, and the approve dialog now has to: a video's output format is
   * chosen at Gate 1, and a Short has a hard three-minute ceiling. This is that
   * comparison's input, so "which of these styles could be a Short" is read off
   * the catalogue rather than guessed at from the word "minutes".
   *
   * It must agree with the style's own `duration` (or `seconds`) default —
   * `script-styles.test.ts` pins that, so a style retargeted in one place and
   * not the other fails rather than misadvertising itself.
   */
  targetSeconds: number;
  content: string;
  variables: ScriptStyleVariable[];
  /**
   * A handful of subjects this style is genuinely good at, written here so the
   * easy-mode picker is never empty.
   *
   * These are the zero-cost floor under the subject list: an operator with no
   * topic queue and no branded channel still has something to tap, on a page
   * that made no model call to render itself. They are deliberately the weakest
   * of the three sources easy mode offers — generic by construction, because
   * they were written without knowing whose channel they would appear on — and
   * the picker labels them as shipped-with-the-app for exactly that reason.
   *
   * Each one is phrased the way the operator would have phrased it: a subject,
   * not an instruction and not a title. `AutomationService.deriveTitle` takes
   * the first sentence of whatever is chosen as the video's working title, and
   * `{{topic}}` is substituted verbatim into the prompt, so a subject written
   * as "Make a video about X" would produce a script about being asked to make
   * a video.
   *
   * They must fit the style they sit on. A countdown subject handed to the
   * post-mortem prompt produces a post-mortem of a list, so a starter is only
   * ever offered alongside the style it was written for.
   */
  starterSubjects: readonly string[];
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

/**
 * Shared by the developer styles, because it is the single constraint that
 * decides whether a technical script is usable here at all — a property of the
 * renderer, like the voice and cue rules above, rather than of any one format.
 * Written into the prompt and not just this comment: the model cannot infer
 * from a topic that the pictures are stock B-roll it does not control.
 */
const NO_CODE_RULES = [
  "NO CODE ON SCREEN — this pipeline has no code renderer, no screen recording and no editor capture. The picture is stock footage matched to a short search query, so while you describe a caching layer the screen shows somebody at a laptop.",
  "- The narration must stand alone. The pictures are illustrative, not instructional. A listener with the video in a background tab has to lose nothing at all.",
  "- Never write 'look at this', 'as you can see', 'on screen', 'in this diagram', 'here in the code', or 'follow along'. There is nothing to look at and nothing to follow.",
  "- Never dictate code, syntax, flags, commands or file paths. Nobody can copy them down, and the voice reads punctuation aloud as words.",
  "- Say what the code does instead, in ordinary words. 'The handler checks the cache first, and only asks the database when the cache misses' carries the idea. Reading out a function signature carries nothing.",
  "- Name things in speakable form: 'Postgres', 'a hash map', 'the load balancer'. Never a symbol, a command line or an identifier in snake case.",
  "- Keep structure the ear can hold. At most three things in a list, named in order, and named again in that order when you come back to them.",
  "- Where a shape matters, describe it physically — a queue is a line, a tree branches, a cache sits in front of the thing it protects. That is also the picture the footage can actually show.",
  "- This is not a tutorial. Nobody can follow steps from it. Aim for the thing a developer understands after listening, not the thing they can type.",
].join("\n");

/**
 * Also shared by the developer styles. The general sourcing rules cover
 * invented facts; this covers the way technical claims go wrong instead —
 * true in twenty nineteen, true on one platform, true before a rewrite. An
 * audience that writes software notices within a minute.
 */
const TECHNICAL_ACCURACY_RULES = [
  "TECHNICAL ACCURACY — this audience writes software and will catch a wrong claim immediately, so accuracy outranks fluency here.",
  "- Prefer the well established over the current. Behaviour that has held for years is safer than behaviour that changed last month and may have changed again since.",
  "- Name versions and dates wherever they change the answer. 'Node has this built in' is wrong somewhere; 'Node has shipped this since version eighteen' is a claim that can be checked.",
  "- Where the field genuinely disagrees, say that it disagrees and give each side its own best argument. Never flatten a contested question into one confident sentence to make a segment land.",
  "- Never give a performance number, a benchmark or an adoption figure without saying what was measured and where it came from. A benchmark with no workload attached means nothing.",
  "- Do not describe a company's internal system as though you had read the code. Say what has been published, and say who published it.",
  "- If you are not sure something is still true, leave it out. There is always another accurate thing to say.",
].join("\n");

export const SCRIPT_STYLES: readonly ScriptStyle[] = [
  {
    id: "default-script",
    name: "Default script",
    description:
      "The house style: a long narrated explainer with a cold open, four to seven chapters and an open loop. Suits a channel whose videos answer one substantial question.",
    category: "SCRIPT",
    targetLength: "8–10 minutes",
    targetSeconds: 540,
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
    starterSubjects: [
      "How index funds quietly took over the stock market",
      "Why shipping containers changed the world more than the internet did",
      "What actually happens to a plastic bottle after you put it in the bin",
      "The reason almost every keyboard still starts with QWERTY",
      "How a single undersea cable can take a whole country offline",
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
    targetSeconds: 240,
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
    starterSubjects: [
      "Counting the animals that live in a garden pond",
      "The colours you can find on a walk to the park",
      "What a baker does from morning until the bread is ready",
      "Naming the parts of a tree, one at a time",
      "How a caterpillar becomes a butterfly",
    ],
  },

  {
    id: "case-study",
    name: "Case study",
    description:
      "One real story told in order, from the decision to the consequence. Suits a channel that explains an idea through a single company, person or event.",
    category: "SCRIPT",
    targetLength: "About 7 minutes",
    targetSeconds: 420,
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
    targetSeconds: 360,
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
    targetSeconds: 360,
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

  {
    id: "system-design-explainer",
    name: "System design explainer",
    description:
      "How one system works, traced along a single request from the first hop to the last. Suits explaining an architecture to developers when there is nothing to put on screen.",
    category: "SCRIPT",
    // Nine minutes because the format has a fixed spine — job, constraints,
    // the traced path, the trade-off, the failure mode — and the path is the
    // part that needs room. At 150 words a minute that is 1,350 words, around
    // 60 sections, which is what the default style already renders.
    targetLength: "About 9 minutes",
    targetSeconds: 540,
    content: [
      "Write a {{duration}}-minute narration script explaining how this works, end to end: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is an architecture explainer for people who build software. The whole video is one system, taken apart in the order a request moves through it.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words. At about 22 words a section that is around 60 sections. Keep writing until the path is genuinely traced end to end at that length.",
      "",
      "STRUCTURE — one path, followed in order.",
      "- Open on what the system costs when it is absent or when it fails: a delay a user feels, an outage, a bill, a number. Not a definition, and never 'in this video'.",
      "- Then state the system's job in one sentence a non-specialist would follow. Everything after this is how that sentence is achieved.",
      "- Then the constraints, before any component. What is scarce here: requests a second, bytes, latency budget, money, the fact that a disk is a thousand times slower than memory. A design is only sensible against its constraints, and naming them first is what makes the rest feel inevitable rather than arbitrary.",
      "- Then trace one single request from the outside in. One component per beat, in the order it is reached. For each: what it is, what it does to the request, and why it is there at all. Never introduce a component before the request arrives at it.",
      "- Say what each hop costs. Roughly, honestly, in units the ear holds: a memory read is instant, a disk seek is slow, a call across the internet is far slower than both.",
      "- Then the hard part. Every design gives something up — consistency, cost, latency, operational simplicity. Name what this one gives up and who pays for it. This is the beat the audience came for; do not rush it.",
      "- Then the failure mode. Remove one component and say what a user sees. Then say what the system does about it: a retry, a queue, a replica, a degraded response.",
      "- Then scale. What breaks first when the load is ten times larger, and what is done about that.",
      "- Close by walking the path again in three or four steps, quickly. The recap is the diagram this video cannot draw, so it earns its place here even though most formats should never repeat themselves.",
      "",
      NO_CODE_RULES,
      "- Trace the path in speech the way you would draw it on a whiteboard: 'in front of', 'behind', 'to one side', 'and then'. Position words are what let a listener hold a shape.",
      "",
      VOICE_RULES,
      "- Introduce every term the first time it is used, in the same sentence, in six words or fewer. Then use it consistently and never swap in a synonym.",
      "- Vary sentence length deliberately. Several short ones, then a longer one. Monotone rhythm is what makes synthetic narration sound synthetic.",
      "",
      TECHNICAL_ACCURACY_RULES,
      "",
      SOURCING_RULES,
      "",
      CUE_RULES,
      "- Cue the physical world the system lives in: server rooms, cabling, technicians, network operations centres, fibre being spliced, delivery vans, warehouse conveyors, traffic junctions, water flowing through pipes.",
      "- Never cue a screen full of code or a text editor. It is the one shot that makes a stock library look like a stock library, and it matches nothing you are saying.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "9" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "working software developers",
      },
      { key: "tone", label: "Tone", defaultValue: "precise and plain-spoken" },
    ],
  },

  {
    id: "incident-postmortem",
    name: "Incident post-mortem",
    description:
      "One real outage told as a timeline: what broke, what the responders saw, and what actually fixed it. Blameless, and specific about the contributing causes.",
    category: "SCRIPT",
    // Seven minutes, matching the case study it is a sibling of: a timeline
    // with a diagnosis and a set of remediations has a natural end, and
    // padding an incident produces invented minutes. 1,050 words, ~48 sections.
    targetLength: "About 7 minutes",
    targetSeconds: 420,
    content: [
      "Write a {{duration}}-minute narration script reconstructing one incident: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is a post-mortem, told the way a good internal write-up reads: a clock, a diagnosis, and what was changed afterwards. It is one incident, not a survey of outages.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 48 sections at 22 words each. If the public record does not fill that, spend the extra time on the conditions that made the failure possible — never on invented detail.",
      "",
      "STRUCTURE — the clock runs forward, once.",
      "- Open at detection. The time, what fired, and what a user was seeing at that moment. Before any explanation of the system.",
      "- Then the impact, plainly and with figures: who was affected, in which regions, for how long, and what it cost, if that was published. Say if the true blast radius was only understood later.",
      "- Then the setup: the change, the deploy, the config edit or the traffic shift that started the clock, and how long it had been in place before anything went wrong. Latent failures often ship days early.",
      "- Then the timeline in order, with clock times, one beat per event. What the responders saw, what they believed, what they tried, and what that did. Never jump ahead to the answer and come back for it.",
      "- Name the misleading signal. Almost every long incident has one: a dashboard that looked fine, an alert that pointed at the wrong service, a retry storm that hid its own cause. The time lost to it is the real story.",
      "- Separate the trigger from the cause. The deploy is the trigger. The cause is the condition that made a routine deploy capable of doing this — a missing limit, an unbounded retry, a default nobody chose, a dependency nobody knew was in the path.",
      "- Then mitigation, then repair. They are different: the thing that stopped the bleeding, and the thing that made a recurrence impossible. Say how long each took.",
      "- Then the remediations that followed, and whether they were actually shipped. An action item nobody completed is part of the story.",
      "- Close on the one condition that generalises to other systems. One paragraph, stated once.",
      "",
      "BLAMELESS — this is a rule about the script, not a disclaimer to read out.",
      "- Never name an individual as the person who broke it, and never imply one. Name the system that allowed it: the missing guardrail, the default, the review that could not have caught it, the alert that did not exist.",
      "- Treat every action taken during the incident as reasonable given what the responder knew at that minute. Hindsight is not evidence of carelessness.",
      "- No mockery of the company, no 'how did nobody think of this', no implication that the audience would have done better.",
      "",
      "EVIDENCE.",
      "- Times, durations and figures come from the published post-mortem, status page or filing. If a time was never published, say the order of events without inventing a clock.",
      "- No invented dialogue, no imagined panic in the room, no reconstructed thoughts. Say what was done and what was recorded.",
      "- If the cause was never publicly established, say that, and say what the plausible explanations are and who holds them.",
      "",
      NO_CODE_RULES,
      "",
      VOICE_RULES,
      "- Say times the way a person says them: 'twelve minutes past two in the morning, Pacific time'.",
      "",
      TECHNICAL_ACCURACY_RULES,
      "",
      SOURCING_RULES,
      "- The post-mortem, the status page updates, the incident report and the reporting on it are the sources. List them.",
      "",
      CUE_RULES,
      "- Cue the shape of a response, not the fault: phones lighting up, an operations room at night, someone woken by a pager, engineers around one desk, traffic at a standstill, an empty shop floor, lights going out across a building.",
      "- Match the clock. Night-time footage while the timeline is at three in the morning, daylight when it reaches the next afternoon.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "7" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "working software developers",
      },
      { key: "tone", label: "Tone", defaultValue: "calm and forensic" },
    ],
  },

  {
    id: "why-it-exists",
    name: "Why it exists",
    description:
      "The origin story of a technology: the problem before it, who built it and when, and what adopting it cost. Suits 'why do we even have this' questions.",
    category: "SCRIPT",
    // Eight minutes: a history needs the before, the build, the displacement
    // and the has-it-aged beat, and each is a real segment. 1,200 words,
    // ~55 sections.
    targetLength: "About 8 minutes",
    targetSeconds: 480,
    content: [
      "Write a {{duration}}-minute narration script on why this exists at all: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is a history, told to people who use the thing every day and have never asked where it came from. The payoff is not what it is. The payoff is what the world was like that made someone build it.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 55 sections at 22 words each. Keep writing until the history reaches the present at that length.",
      "",
      "STRUCTURE — before, during, after, and still true?",
      "- Open inside the pain. One concrete task from before it existed, described so the audience feels the tedium or the risk: what a developer physically did, how long it took, how often it went wrong.",
      "- Then the constraints of that era, with numbers and years. What memory cost, how fast a network was, how big a team was, what a release cycle looked like. Half of every design decision in this story is an artefact of something that was expensive then and is free now.",
      "- Then the people. Who built it, where they worked, what year, and what problem they had been handed. Real names, real dates, real employers.",
      "- Then the first version. What it actually did on release, and what it pointedly did not do. First versions are almost always smaller than the audience assumes, and that gap is the most interesting thing in the segment.",
      "- Then what it displaced, and why the incumbent lost. Rarely because it was worse at everything. Usually because it was worse at the one thing that had started to matter most.",
      "- Then the cost of adoption. Every technology trades something away: complexity, control, performance, portability, a whole class of bug that did not exist before. Name the trade and say who has been paying it since.",
      "- Then the beat this format exists for. Is the original constraint still there? Say plainly what has changed, and whether the thing is now solving a problem the audience no longer has.",
      "- Close by naming the condition under which it stops being the right answer — not a prediction, a condition.",
      "",
      "HISTORY DISCIPLINE.",
      "- No origin myths. If the well-known story is a simplification or is disputed, say so and say what the record shows.",
      "- No inevitability. Nothing in this story had to happen; say what the live alternatives were at the time and why they lost.",
      "- Judge decisions against what was known then, never against what is obvious now.",
      "- Dates and version numbers throughout: which year, which release, which company.",
      "",
      NO_CODE_RULES,
      "",
      VOICE_RULES,
      "- Vary sentence length deliberately. Several short ones, then a longer one. Monotone rhythm is what makes synthetic narration sound synthetic.",
      "",
      TECHNICAL_ACCURACY_RULES,
      "",
      SOURCING_RULES,
      "- Founding stories attract invented quotations more than any other kind of technical writing. If a famous line is only attributed second-hand, say so or leave it out.",
      "",
      CUE_RULES,
      "- Follow the era. Old hardware, tape reels, printouts, telephone exchanges, workshops and factory floors for the early beats; modern rooms, cities and devices as the story reaches now. The visual shift from old to new is doing half the work of the history.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "8" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "working software developers",
      },
      { key: "tone", label: "Tone", defaultValue: "curious and unhurried" },
    ],
  },

  {
    id: "head-to-head",
    name: "Head to head",
    description:
      "Two technologies compared against a stated set of criteria, ending in a verdict with its conditions attached. Suits a decision the audience is about to make.",
    category: "SCRIPT",
    // Seven minutes: an opening, four criteria at roughly a minute each, and
    // a verdict that has room for its conditions. 1,050 words, ~48 sections.
    targetLength: "About 7 minutes",
    targetSeconds: 420,
    content: [
      "Write a {{duration}}-minute narration script comparing two things and reaching a verdict: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "If the subject names both sides, compare those two. If it names only one, choose the alternative it is most often weighed against, say in the first thirty seconds which one you chose, and say why that is the real comparison.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 48 sections at 22 words each. The {{count}} criteria get comparable shares of the body. A criterion that runs three times longer than its neighbours says the others were filler.",
      "",
      "STRUCTURE — the same order, every round.",
      "- Open on what choosing wrong costs: a migration somebody had to do twice, a rewrite, a bill, a team that lost a year. Then name the two things being compared.",
      "- Give each side one fair sentence: what problem it was built to solve, and by whom. Both descriptions written as their own advocates would write them.",
      "- Then declare the criteria before comparing anything. {{count}} of them, named in the order you will take them, and say why those are the ones that decide it. An unstated criterion is where this format loses its audience's trust.",
      "- Then one criterion per segment. Always the same shape: what the first does, what the second does, which one wins here, and what the winner gives up to win. Never change the order of the two sides between segments; the ear tracks position.",
      "- Say where they are equivalent, and say it clearly. Most comparisons are decided by one or two criteria and are a coin toss on everything else. Pretending all {{count}} are decisive is the dishonest version of this format.",
      "- Then the verdict. Actually pick one. A comparison that ends in 'it depends' wasted the runtime — but attach the conditions: which one to choose given a small team, a hard deadline, an unusual scale, an existing stack.",
      "- Then name the case where the loser is the right answer, specifically. There always is one, and saying it is what makes the verdict credible.",
      "- Close in two lines on the question the viewer should ask themselves to decide, not on a summary of the scores.",
      "",
      "FAIRNESS — the failure mode of this format is a rigged fight.",
      "- Take each side at its strongest and most current. Comparing today's version of one against the version of the other from five years ago is the most common way these go wrong.",
      "- Never argue against a position nobody holds. If a criticism only applies to a misuse, say that it is a misuse.",
      "- Separate what is true of the technology from what is true of its community, its documentation or its job market. All four are fair to discuss; conflating them is not.",
      "- Say which version of each you are describing, and when. Comparisons rot faster than anything else on a developer channel.",
      "",
      NO_CODE_RULES,
      "- Compare behaviour and consequence, never syntax. 'One fails at compile time, the other at three in the morning' is a comparison a listener can hold. Two code samples are not.",
      "",
      VOICE_RULES,
      "- Name both sides in full at the start of each segment. A listener who joined late must never have to guess which one you are talking about.",
      "",
      TECHNICAL_ACCURACY_RULES,
      "",
      SOURCING_RULES,
      "- Benchmarks need the workload, the hardware, the versions and the author named, or they do not go in.",
      "",
      CUE_RULES,
      "- Cue the choice, not the products: two roads diverging, a fork in a river, weighing scales, a workshop with two different tools, two teams working differently, a crossroads at rush hour. Alternate which side of a frame the motion comes from as you alternate sides.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "7" },
      { key: "count", label: "How many criteria", defaultValue: "4" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "working software developers",
      },
      { key: "tone", label: "Tone", defaultValue: "even-handed and decisive" },
    ],
  },

  {
    id: "craft-essay",
    name: "Craft essay",
    description:
      "One argued opinion about how software gets made, with the strongest objection to it taken seriously. Suits practice and career subjects rather than tools.",
    category: "SCRIPT",
    // Six minutes. An essay is one thesis, its evidence, its best
    // counterargument and its limits; past that it starts restating itself.
    // 900 words, ~40 sections — the same budget as the countdown.
    targetLength: "About 6 minutes",
    targetSeconds: 360,
    content: [
      "Write a {{duration}}-minute narration script arguing one thing about the craft of software: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is an essay, not an explainer. It takes a position and defends it. The audience has done this job and will recognise a position that costs the writer nothing.",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words, or about 40 sections at 22 words each. Write the whole length, and spend it on argument rather than on restating the thesis in new words.",
      "",
      "STRUCTURE — one argument, taken seriously.",
      "- Open on a specific scene from working life, thirty seconds of it. A review that went badly, a deadline met the wrong way, an on-call night, a rewrite that solved nothing, a first week on a new team. Concrete and small. No thesis yet.",
      "- Then the thesis, in one sentence, stated once and plainly. If it cannot be said in one sentence it is two videos.",
      "- Say what the common position is, fairly, in the words the people who hold it use. You are disagreeing with something real.",
      "- Then the evidence, in three different kinds: something from how the work is actually done, something from the history of the field with names and dates, and something measurable that you can source. Three kinds beats three anecdotes.",
      "- Then the strongest objection, given a full beat of its own and argued as well as its holders argue it. Not the weakest one you can answer easily. This is the segment that decides whether the essay is worth anything.",
      "- Then your answer to it, which may concede part of it. A conceded point makes the rest more believable, not less.",
      "- Then the limits. Where does the thesis stop being true — a different size of team, a different industry, a regulated domain, a prototype instead of a product? An argument with no stated limits is a slogan.",
      "- Then the practical turn: what somebody would do differently on Monday. Specific, and in prose. Never a numbered checklist; the voice reads it as a list and it stops being an essay.",
      "- Close by returning to the opening scene and saying what it looks like the other way. Two or three lines.",
      "",
      "DISCIPLINE — this format fails by being flattering, so guard against it.",
      "- No contempt. Never for junior developers, never for a language's users, never for managers, never for a previous generation of engineers, never for whoever wrote the code you are describing.",
      "- No industry clichés doing the work of an argument: ten times engineers, 'developers just want to rewrite everything', 'nobody reads documentation', 'AI will replace all of this'. If a sentence would fit on a conference slide, cut it.",
      "- No claims about what the industry does or believes unless you can point at a survey, a report or a study, with its year and its sample. If you cannot, argue from the specific case instead.",
      "- Distinguish your argument from established fact, out loud. 'This is what I think follows' is allowed and honest. Presenting a preference as a finding is not.",
      "- No career advice that depends on the listener's circumstances being yours. Say who the advice is for.",
      "",
      NO_CODE_RULES,
      "",
      VOICE_RULES,
      "- Write it as one person talking, in the first person, at an even pace. Vary sentence length deliberately — several short ones, then a longer one — because an essay read in a monotone stops sounding like a person.",
      "",
      TECHNICAL_ACCURACY_RULES,
      "",
      SOURCING_RULES,
      "- An essay's evidence gets checked more aggressively than an explainer's, because the audience already disagrees with somebody in it. Every study, survey, figure and quotation goes in the sources field.",
      "",
      CUE_RULES,
      "- Cue the human side of the work rather than the machinery: hands on a keyboard in a quiet room, a whiteboard being erased, two people arguing at a desk, a commute, an empty office at night, a notebook, a coffee going cold.",
      "- Return to the opening scene's imagery at the close, once, so the ending lands visually as well as in the words.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "6" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "working software developers",
      },
      {
        key: "tone",
        label: "Tone",
        defaultValue: "personal, plain and unhurried",
      },
    ],
  },

  {
    id: "vertical-short",
    name: "Vertical short",
    description:
      "One idea, forty-five seconds, written to be watched on a phone with the sound on. The only style in the catalogue short enough to approve as a Short.",
    category: "SCRIPT",
    // Seconds, not minutes, and it is the only entry measured that way — which
    // is the point. Every other style here targets four minutes or more, so
    // before this one existed an operator choosing the vertical output at Gate
    // 1 had nothing in their library that could produce a script for it and
    // the approve dialog could only warn them. Forty-five seconds is about 110
    // words: comfortably inside YouTube's three-minute Shorts ceiling, long
    // enough for a hook, a middle and a payoff, and short enough that the
    // whole thing is one thought rather than a summary of several.
    targetLength: "About 45 seconds",
    targetSeconds: 45,
    content: [
      "Write a {{seconds}}-second narration script about one single idea: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "This is a vertical short, watched full-screen on a phone, usually while scrolling. It is not a summary of a longer video and it is not an introduction to one. It is the whole thing.",
      "",
      "LENGTH — this is the hardest constraint here and the easiest one to break.",
      "The narration is read aloud at about 150 words a minute, so {{seconds}} seconds is about {{seconds}} times two and a half words. That is roughly six to nine sections of around 13 words each. Count the words before you finish. A script that runs to three hundred words is a two-minute video, and a two-minute video is not what was asked for.",
      "",
      "STRUCTURE — four moves, in this order, with nothing else in between.",
      "- The hook is the first sentence and it is the whole video's fate. State the strangest, most specific, most concrete fact you have, in under twelve words. No greeting, no 'in this video', no 'did you know', no setup before it.",
      "- Then one line that says why it is not what anyone would expect.",
      "- Then the explanation, in three or four short sentences. One mechanism, one cause, one number. Never two competing explanations — there is no room to compare them.",
      "- Then the payoff: the consequence, in one or two lines, and stop. No recap, no 'follow for more', no question to the comments, no teaser for another video.",
      "",
      "DISCIPLINE — what makes this format fail.",
      "- No list. A countdown needs a minute an entry, and a list of five in forty-five seconds is five things nobody remembers.",
      "- No history lesson before the point. If the background takes longer than one sentence, pick a different fact.",
      "- No numbers a listener cannot hold. One figure, said once, in the form they would repeat it.",
      "- Never trail off into a wider theme. It ends on the specific thing it opened with.",
      "",
      VOICE_RULES,
      "- Short sentences even by this catalogue's standards. Most under twelve words. Read it aloud against a clock before you finish.",
      "",
      SOURCING_RULES,
      "- A short is the most shared thing this channel makes and the least able to caveat itself, so the one fact it rests on has to be one you can point at.",
      "",
      CUE_RULES,
      "- The frame is vertical and the subject is centred, so cue tight shots: hands, a face, one object, one motion. Wide landscapes lose their subject to the crop.",
      "- Change the cue every section. At this length the picture is what stops the scroll on the second and third seconds.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "seconds", label: "Length (seconds)", defaultValue: "45" },
      {
        key: "audience",
        label: "Audience",
        defaultValue: "someone scrolling who has never heard of this",
      },
      { key: "tone", label: "Tone", defaultValue: "direct and surprising" },
    ],
  },
];

/** The catalogue entry a slug names, or null. The add path's only lookup. */
export function findScriptStyle(id: string): ScriptStyle | null {
  return SCRIPT_STYLES.find((style) => style.id === id) ?? null;
}

/**
 * The catalogue entries whose target length fits inside `maxSeconds`.
 *
 * The approve dialog's answer to "which script styles suit which output". Read
 * off `targetSeconds` rather than judged from the prose, so a style retargeted
 * later moves between the two lists on its own — and so that the answer for the
 * vertical output stays honest: for most of this catalogue it is "none of
 * them", and saying so is more useful than offering a nine-minute explainer as
 * a way to make a forty-five-second Short.
 */
export function scriptStylesUnder(maxSeconds: number): readonly ScriptStyle[] {
  return SCRIPT_STYLES.filter((style) => style.targetSeconds <= maxSeconds);
}

/**
 * The style `seed-default-prompts.ts` seeds as every operator's starting
 * SCRIPT template. Named rather than indexed so reordering the catalogue for
 * display cannot change what a fresh account is seeded with.
 */
export const SEEDED_SCRIPT_STYLE_ID = "default-script";
