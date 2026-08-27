/**
 * Whether a queued topic gives the writer something to open on.
 *
 * ## Why a topic is where a video is won or lost
 *
 * A `ScheduleTopic` is one line of text, and it is the entire brief for
 * everything downstream: the script, the title, the pictures and the hook. Two
 * topics about the same events produce very different videos —
 *
 *   "Congress of Vienna"
 *   "the treaty that redrew Europe was negotiated between parties and affairs"
 *
 * The first names a subject. A writer handed it has to invent the surprise, and
 * what it invents is whatever is most obvious about the subject, which is what
 * everybody else has already made. The second *is* the surprise, so the first
 * sentence writes itself and the rest of the video has somewhere to go.
 *
 * ## Why this advises and never refuses
 *
 * Topics are the operator's own words, typed into their own queue, and some of
 * the best ones are two words that happen to be extraordinary. A gate that
 * rejected them would be wrong often enough to be turned off, and a queue that
 * silently rewrote them would be worse. So this returns a hint for a form to
 * show beside the field, and nothing here can stop a topic being saved.
 *
 * That is also why it is not on the schema: `scheduleTopicSchema` decides what
 * may be stored, and everything this module notices is still perfectly storable.
 *
 * Pure and dependency-free, so the same function runs in a test and in the
 * browser as somebody types.
 */

/**
 * Words that mean the topic asserts something rather than naming something.
 *
 * Exported so the test asserts the list is *applied* rather than restating it.
 * Deliberately a plain list of common verbs and not a parser: the question is
 * "is there a claim in here at all", which a finite verb answers, and a wrong
 * answer costs a hint nobody had to read.
 */
export const CLAIM_VERBS = [
  "is", "was", "were", "are", "be", "been", "being",
  "has", "have", "had",
  "does", "did", "do",
  "can", "could", "will", "would", "should", "must",
  "make", "makes", "made",
  "cost", "costs",
  "take", "takes", "took",
  "pay", "pays", "paid",
  "build", "builds", "built",
  "kill", "kills", "killed",
  "lose", "loses", "lost",
  "win", "wins", "won",
  "break", "breaks", "broke",
  "turn", "turns", "turned",
  "say", "says", "said",
  "hide", "hides", "hid",
  "sell", "sells", "sold",
  "buy", "buys", "bought",
  "give", "gives", "gave",
  "get", "gets", "got",
  "go", "goes", "went",
  "come", "comes", "came",
  "run", "runs", "ran",
  "stop", "stops", "stopped",
  "start", "starts", "started",
  "change", "changes", "changed",
  "save", "saves", "saved",
  "spend", "spends", "spent",
  "owe", "owes", "owed",
  "charge", "charges", "charged",
  "refuse", "refuses", "refused",
  "force", "forces", "forced",
  "become", "becomes", "became",
  "beat", "beats",
  "sank", "sink", "sinks",
] as const;

/**
 * Words that set one thing against another.
 *
 * A topic carrying any of these has a tension in it even with no verb —
 * "more choices, fewer sales" is a whole video and has no finite verb at all.
 */
export const TENSION_MARKERS = [
  "but",
  "yet",
  "despite",
  "although",
  "though",
  "while",
  "without",
  "until",
  "even",
  "still",
  "never",
  "nobody",
  "no one",
  "everyone",
  "always",
  "only",
  "instead",
  "more than",
  "less than",
  "fewer",
  "why",
  "how",
] as const;

/** Below this a topic is a label rather than a sentence, whatever else it
 *  contains. Three words is "Congress of Vienna" and "the Enron collapse". */
export const MIN_TOPIC_WORDS = 4;

export interface TopicShape {
  /** False only when a hint is worth showing. Never a reason to refuse a save. */
  ok: boolean;
  /** One sentence for the operator, or null when there is nothing to say.
   *  Written as advice about this topic, not as a rule about topics. */
  hint: string | null;
}

const SUGGESTION =
  "Try writing it as the surprise itself — what happened, and the part of it " +
  "that should not have.";

function tokens(topic: string): string[] {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9'’\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Judges the shape of one queued topic.
 *
 * Three things count as a claim: a finite verb, a tension marker, or a number.
 * A number earns its place on its own — "$9.99 for three years" is a topic with
 * a shape even though it asserts nothing grammatically, because the figure is
 * the thing the video will be built around.
 */
export function describeTopicShape(topic: string): TopicShape {
  const trimmed = topic.trim();

  if (trimmed.length === 0) {
    return { ok: false, hint: "This topic is empty." };
  }

  const words = tokens(trimmed);
  const haystack = ` ${words.join(" ")} `;

  const hasVerb = words.some((word) =>
    (CLAIM_VERBS as readonly string[]).includes(word),
  );
  const hasTension = TENSION_MARKERS.some((marker) =>
    haystack.includes(` ${marker} `),
  );
  const hasNumber = /\d/.test(trimmed);
  // Five letters or more, so "red" and "ring" are not read as participles.
  const hasParticiple = words.some((word) => /^.{3,}(ed|ing)$/.test(word));

  if (hasVerb || hasTension || hasNumber || hasParticiple) {
    return { ok: true, hint: null };
  }

  if (words.length < MIN_TOPIC_WORDS) {
    return {
      ok: false,
      hint:
        `"${trimmed}" names a subject rather than making a claim about it, so ` +
        `the writer has to invent the surprise — and it will invent the most ` +
        `obvious one. ${SUGGESTION}`,
    };
  }

  return {
    ok: false,
    hint:
      `"${trimmed}" describes what the video is about but never says what ` +
      `happens in it, so there is nothing here for the opening line to be. ` +
      `${SUGGESTION}`,
  };
}
