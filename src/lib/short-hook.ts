/**
 * The one rule a vertical short's first sentence has to pass: it must stand on
 * its own.
 *
 * ## Why the first sentence decides the video
 *
 * A short is watched by someone who did not choose it. They arrive mid-scroll,
 * with no title read and no context, and they leave in about two seconds if the
 * opening does not land — and the platform stops distributing a short whose
 * viewers leave that early, whatever the rest of it does. So the opening
 * sentence is not the introduction to the video. It is the video's whole
 * audition.
 *
 * The failure this catches is a sentence that begins in the middle of an
 * argument the viewer has not heard: a continuation word, a pronoun with
 * nothing behind it, a date laid down before the point. Openings like
 *
 *   - "Now, here's the part that sounds completely backwards."
 *   - "On a Saturday in June 1995, a grocery store in Menlo Park…"
 *   - "It cost them everything."
 *
 * are not badly written. They are written for a viewer who is already watching.
 * That viewer does not exist here.
 *
 * It is the characteristic fault of any short cut out of something longer,
 * which is why `shorts.service.ts` runs this over every clip it selects, and it
 * is a fault a writer falls into just as easily from a blank page, which is why
 * the insight format runs it over its HOOK beat.
 *
 * ## Why it is a list of openers and not a judgement
 *
 * "Does this hook work" is a question a second model call would answer no
 * better than the first, and it would answer it differently each time. What
 * *can* be decided with certainty is whether the sentence points backwards at
 * something that is not there. Those markers are lexical, they are cheap, and a
 * script that trips one is wrong for a reason an operator can read.
 *
 * The rules are deliberately narrower than the fault. See the last test in
 * `short-hook.test.ts` for the case that is knowingly let through and why
 * catching it would cost more than it saves.
 *
 * Pure and dependency-free, like `insight-script.ts` and `longform-script.ts`
 * beside it: the same function runs in a test, in the generator's retry loop
 * and in the shorts selector.
 */

/**
 * Words and phrases that carry a sentence on from a previous one.
 *
 * Exported so the test asserts the list is *applied* rather than restating it —
 * a copy in the test would pass forever after somebody edited only the copy.
 *
 * Lowercase. Matched only at the very start of the hook, and only on a word
 * boundary, so "Still" opening a sentence is refused while "still had ninety
 * years left" in the middle of one is not.
 */
export const CONTINUATION_OPENERS = [
  "now",
  "then",
  "but",
  "so",
  "and",
  "yet",
  "however",
  "meanwhile",
  "still",
  "also",
  "besides",
  "therefore",
  "thus",
  "anyway",
  "plus",
  "instead",
  "again",
  "next",
  "later",
  "afterward",
  "afterwards",
  "eventually",
  "ultimately",
  "finally",
  "of course",
  "in fact",
  "after all",
  "as a result",
  "even so",
  "worse",
  "here's the part",
  "here's where",
  "that's why",
  "that's when",
  "which is why",
  "on top of that",
  "because of that",
] as const;

/**
 * Pronouns that can only mean something the viewer has already been shown.
 *
 * A short has no already. Every one of these opening a hook names a person or a
 * thing the audience has never met.
 */
export const BACK_REFERENCE_OPENERS = [
  "it",
  "he",
  "she",
  "they",
  "them",
  "him",
  "his",
  "her",
  "its",
  "their",
] as const;

/**
 * Determiners that presuppose a comparison the hook never made.
 *
 * "the other customer" and "the same result" are only meaningful next to a
 * first customer and an earlier result. Matched anywhere in the sentence rather
 * than only at the front, because the presupposition is just as broken in the
 * middle of it.
 *
 * `first` is deliberately absent: "the first contest" is anaphoric but "the
 * first man to walk on the moon" is not, and no rule here can tell them apart.
 */
export const ANAPHORIC_DETERMINERS = [
  "other",
  "same",
  "next",
  "latter",
  "former",
] as const;

/** Demonstratives, which are back references only when they stand alone as the
 *  subject. "That was the moment" points at nothing; "That summer" names what
 *  it points at. The difference is whether a verb follows. */
const DEMONSTRATIVES = ["this", "that", "these", "those"] as const;

/** Verb forms that, straight after a demonstrative, mean the demonstrative was
 *  the whole subject. */
const COPULAS =
  "is|was|are|were|'s|'re|had|has|have|will|would|could|should|did|does|do|might|must|can";

const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";
const TIME_NOUNS =
  "morning|afternoon|evening|night|day|summer|winter|spring|autumn|fall";
const DECADES =
  "twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties";

/**
 * Openings that put a date, a place in time or a scene down before the point.
 *
 * The most common slow start there is, and the one the short-form prompt
 * already forbids in prose ("no setup before it"). A short has about two
 * seconds; a date spends them.
 */
const DATE_FIRST: readonly RegExp[] = [
  // "On a Saturday…", "On Tuesday…", "In June…"
  new RegExp(`^(on|in)\\s+(a|the)?\\s*(${WEEKDAYS}|${MONTHS})\\b`, "i"),
  // "In 1995…", "By 1825…", "Around 1900…"
  /^(in|by|around|about|before|after|during)\s+(the\s+)?\d{3,4}\b/i,
  // "Back in the eighties…", "In the nineties…"
  new RegExp(`^(back\\s+)?in\\s+the\\s+(${DECADES})\\b`, "i"),
  /^back\s+in\b/i,
  // "One morning…", "One summer…"
  new RegExp(`^one\\s+(${TIME_NOUNS})\\b`, "i"),
  // "At 2am…", "At 3 o'clock…"
  /^at\s+\d/i,
  /^once\s+upon\b/i,
  // "It was 1995" is caught by the pronoun rule; "There was a table" is not.
  /^there\s+(was|were)\b/i,
];

export interface HookCheck {
  ok: boolean;
  /** One complete sentence per problem, safe to append to a retry prompt
   *  verbatim — the same contract `validateInsightScript` returns under. */
  errors: string[];
}

/**
 * The first sentence of a narration, whitespace collapsed.
 *
 * Splits on a full stop, question mark or exclamation mark that is followed by
 * whitespace or the end of the string, and never on one preceded by a digit —
 * "$9.99 a month" is one sentence and a hook that mentions a price must not be
 * truncated to "It cost $9." before it is judged.
 *
 * A narration with no terminator at all comes back whole rather than empty: a
 * writer who forgot the full stop still wrote a hook, and refusing it for the
 * punctuation would be a rule this module never claimed to have.
 */
export function firstSentence(narration: string): string {
  const text = narration.replace(/\s+/g, " ").trim();
  const boundary = /(?<!\d)[.?!](?=\s|$)/.exec(text);

  return boundary === null ? text : text.slice(0, boundary.index + 1);
}

function startsWith(hook: string, opener: string): boolean {
  // A word boundary after the opener, so "so" does not match "something" and
  // "and" does not match "another". Punctuation counts as a boundary, which is
  // what lets "Now," through to the rule.
  return new RegExp(`^${opener.replace(/'/g, "['’]")}\\b`, "i").test(hook);
}

/**
 * Judges a short's opening sentence, and only its opening sentence.
 *
 * Returns every problem it finds rather than the first, so one retry can fix
 * all of them — the same reason the two validators beside it collect errors
 * into a list.
 */
export function checkHook(narration: string): HookCheck {
  const hook = firstSentence(narration);
  const errors: string[] = [];

  if (hook.length === 0) {
    return { ok: false, errors: ["The script has no opening sentence."] };
  }

  const continuation = CONTINUATION_OPENERS.find((opener) => startsWith(hook, opener));

  if (continuation !== undefined) {
    errors.push(
      `The first sentence opens with "${continuation}", which carries on from ` +
        `something the viewer has not heard. A short has no previous sentence. ` +
        `Open on the surprise itself.`,
    );
  }

  const pronoun = BACK_REFERENCE_OPENERS.find((opener) => startsWith(hook, opener));

  if (pronoun !== undefined) {
    errors.push(
      `The first sentence opens with "${pronoun}", which stands for someone the ` +
        `viewer has not met. Name the person or the thing outright.`,
    );
  }

  const demonstrative = DEMONSTRATIVES.find((word) =>
    new RegExp(`^${word}\\s+(${COPULAS})\\b`, "i").test(hook),
  );

  if (demonstrative !== undefined) {
    errors.push(
      `The first sentence opens with "${demonstrative}" standing on its own, ` +
        `which points at something the viewer has not met. Say what it is ` +
        `instead.`,
    );
  }

  const determiner = ANAPHORIC_DETERMINERS.find((word) =>
    new RegExp(`\\bthe\\s+${word}\\b`, "i").test(hook),
  );

  if (determiner !== undefined) {
    errors.push(
      `The first sentence says "the ${determiner}", which compares against ` +
        `something it never introduced. Drop the comparison or make both sides ` +
        `visible.`,
    );
  }

  if (DATE_FIRST.some((pattern) => pattern.test(hook))) {
    errors.push(
      `The first sentence opens on a date or a scene rather than on the point. ` +
        `Lead with what was surprising and let the date follow it.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Openings a scrolling viewer has already learned to skip.
 *
 * Every one of these announces that a fact is coming instead of stating it,
 * and a channel that opens the same way every day trains its audience to
 * swipe on the first word. Measured, not guessed: all seventeen of the history
 * shorts on the channel this was written for opened "Did you know", and none
 * of them left the first test pool of about a thousand viewers.
 *
 * Exported so the test asserts the list is applied rather than restating it.
 * Lowercase, matched at the very start on a word boundary, like
 * `CONTINUATION_OPENERS`.
 */
export const FORMULA_OPENERS = [
  "did you know",
  "what if i told you",
  "have you ever",
  "imagine",
  "this is the story of",
  "meet",
  "ever wonder",
  "here's why",
  "here is why",
  "you won't believe",
  "picture this",
] as const;

/**
 * An opening's first three words, lowercased with punctuation removed — the
 * part of a sentence a viewer hears before deciding, and so the part two
 * videos must not share.
 */
export function openingKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

/**
 * Judges whether a short's opening is new: not a formula, and not the way one
 * of this channel's recent videos opened.
 *
 * Separate from `checkHook` rather than folded into it, because `checkHook`
 * also judges clips cut out of a finished video, which have no channel history
 * to be fresh against and no say in how their first line was written.
 */
export function checkFreshOpening(
  narration: string,
  recentOpenings: readonly string[],
): HookCheck {
  const hook = firstSentence(narration);
  const errors: string[] = [];
  const formula = FORMULA_OPENERS.find((opener) => startsWith(hook, opener));

  if (formula !== undefined) {
    errors.push(
      `The first sentence opens with "${formula}", a formula viewers have ` +
        `learned to scroll past. Open on the fact itself.`,
    );
  }

  const key = openingKey(hook);

  if (key.length > 0 && recentOpenings.some((recent) => openingKey(recent) === key)) {
    errors.push(
      `The first sentence opens "${key}", the same way a recent video on this ` +
        `channel opened. Use a different opening shape.`,
    );
  }

  return { ok: errors.length === 0, errors };
}
