/**
 * The one prompt this app uses to ask a model for video subjects, and the
 * reading of its answer.
 *
 * Two callers, and they were nearly the same prompt written twice before this
 * module existed:
 *
 *   * `easyModeService.suggest` — six subjects for a picker, offered to somebody
 *     who is about to choose one by hand.
 *   * `topicQueueService` — ten subjects appended to a schedule's queue, which
 *     nobody will look at before a video is made from them.
 *
 * Every rule below is true of both, so it lives here once. The difference is
 * `reach`: the queue ranks for views against the channel's own measured figures,
 * because it is choosing rather than offering, and there is nobody at the
 * keyboard to pass over a weak suggestion. Easy mode passes nothing and gets
 * byte-for-byte the prompt it sent before this file existed.
 *
 * Pure, and in lib/ rather than in a service, for the obvious reason: the whole
 * value of a prompt is what it says, and a prompt that can only be tested
 * through a provider call is a prompt nobody tests.
 */

/**
 * The channel's own answer to "what gets watched here", as titles.
 *
 * Titles rather than scores, deliberately. A model cannot do anything useful
 * with "42,000 views"; it can absolutely see what four titles have in common.
 * The numbers are how the lists are *chosen* — see `readReachEvidence` in
 * topic-queue.service.ts — and they stay there.
 */
export interface ReachEvidence {
  /** The best-performing recent videos on this channel, best first. */
  winners: string[];
  /** The worst-performing recent videos, worst first. */
  losers: string[];
  /**
   * Whether the two lists above are measurements or absences.
   *
   * `"analytics"` means this channel has collected figures and the lists are
   * real. `"settings"` means it has not — a new channel, or one whose analytics
   * collection has not run — and the prompt says so rather than implying an
   * empty list is a finding. The reach *rule* is applied either way: it is a
   * property of this operator's channel, established across every video they
   * have published, not something re-derived per call.
   */
  source: "analytics" | "settings";
}

export interface SubjectPromptArgs {
  /** How many subjects to ask for. */
  count: number;
  niche: string;
  tone: string;
  /** The script style each of these will be written with, named so the model can
   *  tell an eight-minute explainer from a sixty-second short. */
  styleName: string;
  /** Subjects already queued, already made, or already on offer. */
  avoid: readonly string[];
  /**
   * Turns on the reach-ranking half of the prompt. Omitted by the caller that is
   * offering subjects to a human who will judge them; set by the caller that is
   * choosing on the operator's behalf.
   */
  reach?: ReachEvidence;
}

/** How many entries of the avoid-list are sent. Bounded so a channel with two
 *  hundred videos does not turn a short prompt into a catalogue the model has to
 *  read before it can start. */
const AVOID_LIMIT = 40;

/** How many winners and losers are named. Enough for a pattern, few enough that
 *  the model is not being asked to average a page of titles. */
const EVIDENCE_LIMIT = 5;

/**
 * The measured pattern on this operator's channel, stated as a rule.
 *
 * This is not a general theory of YouTube and is not offered as one. It is what
 * their own numbers say: a video about a subject the viewer already recognises
 * gets roughly four times the views of one about a subject they do not, and the
 * examples in both directions are theirs. Written into the prompt as the named
 * examples rather than as an abstraction, because "prefer recognisable subjects"
 * is advice a model will agree with and ignore, whereas "Marcus Aurelius beat
 * Zheng He four to one on this channel" is a constraint it can actually apply.
 */
const REACH_RULE = [
  "Rank for reach, and rank hard. This channel's own figures say the same thing " +
    "every time: a video about a subject the viewer already recognises gets " +
    "about FOUR TIMES the views of one about a subject they do not, however " +
    "good the second one is. Marcus Aurelius and the Berlin conference are the " +
    "shape that wins here. Zheng He and the Aztecs are the shape that loses — " +
    "not because those videos were worse, but because nobody recognised the " +
    "name in the thumbnail.",
  "",
  "So: pick subjects most of the audience has already heard of, and then find " +
    "the genuine twist in each one — the fact, reversal or consequence that " +
    "makes a familiar name worth watching again. Recognisable subject plus a " +
    "real twist is the winning shape, and both halves are load-bearing. A " +
    "recognisable subject with no twist is a video nobody needs; an obscure " +
    "subject with a brilliant twist is a video nobody clicks.",
];

/**
 * Builds the prompt.
 *
 * It asks for subjects, not titles: `{{topic}}` is substituted verbatim into the
 * operator's script prompt, so "10 SHOCKING facts about X" would produce a
 * script about a clickbait headline rather than about X. And it is always given
 * what to avoid, because the cheapest way to waste this call is to have it
 * return the five things the operator is already looking at.
 */
export function buildSubjectPrompt(args: SubjectPromptArgs): string {
  const lines = [
    `Suggest ${args.count} subjects for narrated explainer videos on a ` +
      `YouTube channel about: ${args.niche}.`,
    `The channel's voice is ${args.tone}. Each video is written with a script ` +
      `style called "${args.styleName}".`,
  ];

  if (args.reach) {
    lines.push("", ...REACH_RULE);

    if (args.reach.winners.length > 0) {
      lines.push(
        "",
        "These did best on this channel. Aim at this end — more like these:",
        ...args.reach.winners.slice(0, EVIDENCE_LIMIT).map((title) => `- ${title}`),
      );
    }

    if (args.reach.losers.length > 0) {
      lines.push(
        "",
        "These did worst. Unlike these — work out what they have in common and " +
          "stay away from it:",
        ...args.reach.losers.slice(0, EVIDENCE_LIMIT).map((title) => `- ${title}`),
      );
    }

    if (args.reach.source === "settings") {
      lines.push(
        "",
        "This channel has no published figures yet, so there are no winners or " +
          "losers of its own to copy. Work from the niche and voice above, and " +
          "apply the rule anyway: it is what every other video on this account " +
          "has shown.",
      );
    }
  }

  lines.push(
    "",
    "Rules:",
    "- Each entry is a SUBJECT, not a title. Write it the way somebody would " +
      "describe what a video is about: 'how index funds took over the stock " +
      "market', not '10 SHOCKING facts about index funds'.",
    "- One clear line each, under twenty words, no numbering and no quotation marks.",
    "- Specific enough that two of them could not be the same video.",
    "- Only subjects a narrated video over stock footage can carry. No tutorials, " +
      "no screen recordings, nothing that needs a chart or a diagram on screen.",
    "- Nothing that depends on this week's news; these are made days later.",
  );

  if (args.reach) {
    // Only meaningful for the queue: its entries are consumed in the order they
    // are given, oldest first, so position in this answer is position in the
    // schedule. Easy mode's picker shows all six at once and the operator's eye
    // does the ranking, which is why this rule is not in the shared block above.
    lines.push(
      "- Order them strongest first. They are used in the order you write them, " +
        "one per video, so the first line is the next video this channel makes.",
    );
  }

  if (args.avoid.length > 0) {
    lines.push(
      "",
      "Do not suggest any of these, or anything that is plainly the same video:",
      ...args.avoid.slice(0, AVOID_LIMIT).map((topic) => `- ${topic}`),
    );
  }

  lines.push(
    "",
    'Reply with JSON only, no prose: ["subject one", "subject two", ...]',
  );

  return lines.join("\n");
}

/**
 * Reads the model's answer, tolerantly.
 *
 * JSON first, because that is what the prompt asked for. A model that answered
 * with a bulleted list instead is not a failure worth throwing away a paid call
 * over, so the fallback strips the list markers and takes the lines. Anything
 * else yields nothing, and both callers report that as an error rather than as
 * an empty list of ideas.
 */
export function parseSubjects(content: string): string[] {
  const trimmed = content.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map(cleanSubject)
        .filter(isUsableSubject);
    }
  } catch {
    // Fall through to the line reader below.
  }

  return trimmed.split("\n").map(cleanSubject).filter(isUsableSubject);
}

/** Strips the decoration a model adds when it ignores "no numbering": leading
 *  bullets, `1.`, wrapping quotes, and a trailing comma from a JSON-ish line. */
export function cleanSubject(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/,$/, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
}

/**
 * Bounds that match `startAutomationSchema`'s own topic limits, so a suggestion
 * the operator taps is one the server will accept. A model that returned a
 * paragraph produces a topic the action would reject after the tap, which reads
 * as the button being broken.
 */
export function isUsableSubject(subject: string): boolean {
  return subject.length >= 3 && subject.length <= 300 && !subject.startsWith("[");
}

/**
 * The model talking rather than answering.
 *
 * `parseSubjects` is deliberately tolerant — a bulleted list instead of JSON is
 * not worth throwing a paid call away over — and the cost of that tolerance is
 * that a prose reply like "I'd be happy to help with that!" passes every bound
 * `isUsableSubject` checks. In a picker that is harmless: it appears as one
 * obviously silly option among six and nobody taps it.
 *
 * In the topic queue it is not harmless at all. Nobody reads that list before a
 * run takes the head of it, so a line of model chatter becomes a narrated,
 * rendered video on a real YouTube channel with the operator's name on it. That
 * is the single worst thing this feature could do, and it is worth a narrow,
 * boring regex to prevent.
 *
 * Narrow on purpose. It matches openers, anchored at the start, that no honest
 * subject begins with — a subject is a noun phrase or a "how/why/what" question,
 * never a first-person offer or an apology. It is not a content filter and is not
 * trying to be: a reply that is *mostly* usable with one chatty line loses that
 * line and keeps the rest.
 */
export function looksLikeModelChatter(subject: string): boolean {
  return /^(sure|certainly|of course|absolutely|okay|ok|here (are|is|you go)|i\s*('m|'d|'ll|am|hope|would|could|can|cannot|can't|will|have|apologi[sz]e)|sorry|unfortunately|as an ai|thanks|thank you|let me know)\b/i.test(
    subject.trim(),
  );
}

/** Case- and punctuation-insensitive comparison, so "How index funds took over"
 *  and "how index funds took over." are one subject rather than two. */
export function normaliseSubject(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
