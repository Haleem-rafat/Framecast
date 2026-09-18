/**
 * The rules every script of ninety seconds or less has to pass: a fresh
 * opening, a hook card, and an ending that asks the viewer for nothing.
 *
 * ## Why these three
 *
 * They come from reading every short on the channel this was written for
 * (see docs/superpowers/specs/2026-09-18-short-hooks-design.md). The stories
 * were good and the pictures were good; what the videos that stalled at a few
 * hundred views shared was an opening viewers had heard seventeen times, a
 * first on-screen text that meant nothing with the sound off, and an ending
 * that gave nobody a reason to replay or to reply.
 *
 * ## Why a gate and not a prompt
 *
 * The opening rule was already in a prompt — `vertical-short` bans "did you
 * know" in so many words — and the channel's shorts opened with it anyway,
 * because they were written from a template stored in the database that says
 * nothing of the kind. A rule that only exists in one template's text is a
 * rule every other template is free to break. Checked here, on the model's
 * answer, it holds whatever wrote the brief.
 *
 * Pure and dependency-free, like `short-hook.ts` beside it: the same functions
 * run in a test and in `ScriptService`'s retry loop.
 */

import {
  checkFreshOpening,
  checkHook,
  firstSentence,
  FORMULA_OPENERS,
  type HookCheck,
} from "@/lib/short-hook";

/** How a short's last line is asked to land. Mirrors the `EndingKind` enum;
 *  kept as a literal union so this module stays importable anywhere. */
export type EndingKind = "LOOP" | "DEBATE";

/** The longest script these rules apply to. Ninety seconds rather than sixty:
 *  a short may run to three minutes, but nothing this app writes as one aims
 *  past a minute and a half, and a four-minute explainer must never be held to
 *  a short's opening. */
export const SHORT_MAX_SECONDS = 90;

const CARD_MIN_WORDS = 2;
const CARD_MAX_WORDS = 6;

/** Asks for engagement. Matched on word boundaries, so "followed" and "likely"
 *  in an ordinary last line are not mistaken for requests. */
const ENGAGEMENT_ASK =
  /\b(comment|comments|let me know|subscribe|follow|like and|smash)\b/i;

const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Whether a generation is a short, read from what the template declares.
 *
 * Not from the video's format: landscape or vertical is chosen at approval,
 * after the script exists. A `seconds` variable is seconds and a `duration`
 * variable is minutes, which is how every built-in template already declares
 * its length. A length that does not parse is not a short — refusing a
 * script over a rule nobody asked for costs more than letting one through.
 */
export function isShortTarget(input: {
  format?: "prose" | "insight" | "longform";
  seconds?: string;
  duration?: string;
}): boolean {
  if (input.format === "longform") {
    return false;
  }

  if (input.format === "insight") {
    return true;
  }

  if (input.seconds !== undefined) {
    const seconds = Number(input.seconds);

    return Number.isFinite(seconds) && seconds <= SHORT_MAX_SECONDS;
  }

  if (input.duration !== undefined) {
    const minutes = Number(input.duration);

    return Number.isFinite(minutes) && minutes * 60 <= SHORT_MAX_SECONDS;
  }

  return false;
}

/** The other ending from last time, and LOOP for a channel's first short.
 *  Alternating rather than random so a later comparison of the two has
 *  roughly equal samples of each. */
export function nextEndingKind(previous: EndingKind | null): EndingKind {
  return previous === "LOOP" ? "DEBATE" : "LOOP";
}

/**
 * Opening shapes, each with an example drawn from the channel's own stories.
 *
 * Guidance, not a rule: the gate refuses what is stale, and this list is what
 * gives the model somewhere else to go.
 */
const OPENING_SHAPES = [
  'Famous name, then the twist: "Marcus Aurelius handed Rome to a lunatic."',
  'One extreme number: "Four hundred ships burned on a single order."',
  'A flat verdict: "The wisest emperor made the dumbest choice in Rome."',
  'A scene already moving: "Soldiers rolled in and every road sign vanished."',
  'A contradiction: "The most feared destroyer saved the oldest story on earth."',
  'The stakes: "One signature decided which language Africa would speak."',
  'The object: "A clay tablet outlived the empire that burned it."',
  'The aftermath first: "The borders are still there. The men who drew them never saw them."',
] as const;

/**
 * The system instruction a short is written under.
 *
 * Sent beside the operator's template, never inside it, for the reason
 * `ScriptService.generate` gives for the recurring-character instruction: the
 * template goes to the model and into `ScriptVersion.prompt` unchanged.
 */
export function shortInstruction(
  recentOpenings: readonly string[],
  ending: EndingKind,
): string {
  const recent =
    recentOpenings.length > 0
      ? "Recent videos on this channel opened like this. Open differently:\n" +
        recentOpenings.map((opening) => `- ${firstSentence(opening)}`).join("\n")
      : null;

  const endingRule =
    ending === "LOOP"
      ? "ENDING: loop. The last line leads straight back into the first " +
        "sentence, so a replay reads as one continuous thought."
      : "ENDING: debate. End on a flat verdict a viewer could argue with. " +
        "State it; never ask it.";

  return [
    'OPENING: use one of these shapes. Never open with a formula such as "Did you know".',
    ...OPENING_SHAPES.map((shape) => `- ${shape}`),
    recent,
    "HOOK CARD: also return hook_card, two to six words shown on screen for " +
      "the first three seconds. It must make sense with the sound off and must " +
      "not repeat the first sentence.",
    endingRule,
    "Never ask the viewer to comment, like, follow or subscribe.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every problem with a short's hook card, one sentence each, written to be
 *  pasted into a retry prompt. Empty when the card is fine. */
export function checkHookCard(card: string | undefined, narration: string): string[] {
  if (card === undefined || card.trim().length === 0) {
    return [
      "The script has no hook_card. Return two to six words for the opening screen.",
    ];
  }

  const errors: string[] = [];
  const words = card.trim().split(/\s+/).length;

  if (words < CARD_MIN_WORDS || words > CARD_MAX_WORDS) {
    errors.push(`The hook_card has ${words} words. It must have two to six.`);
  }

  if (EMOJI.test(card)) {
    errors.push("The hook_card contains an emoji. Use words only.");
  }

  if (normalise(card) === normalise(firstSentence(narration))) {
    errors.push("The hook_card repeats the first sentence. Say the hook a different way.");
  }

  const lowered = card.trim().toLowerCase();

  if (FORMULA_OPENERS.some((opener) => lowered.startsWith(opener))) {
    errors.push("The hook_card opens with a formula phrase. Lead with the fact.");
  }

  return errors;
}

/** Refuses a last sentence that asks the viewer for something. Both endings
 *  are statements; a question to the comments is the bait the debate ending
 *  exists to replace. */
export function checkEnding(narration: string): string[] {
  const sentences = narration.trim().split(/(?<=[.?!])\s+/);
  const last = sentences[sentences.length - 1]?.trim() ?? "";

  if (last.endsWith("?") || ENGAGEMENT_ASK.test(last)) {
    return [
      `The last sentence ("${last}") asks the viewer for something. End on a statement.`,
    ];
  }

  return [];
}

/**
 * The whole gate for a short: every rule, every problem, in one list so one
 * retry can fix all of them.
 */
export function checkShortScript(input: {
  narration: string;
  hookCard?: string;
  recentOpenings: readonly string[];
}): HookCheck {
  const errors = [
    ...checkHook(input.narration).errors,
    ...checkFreshOpening(input.narration, input.recentOpenings).errors,
    ...checkHookCard(input.hookCard, input.narration),
    ...checkEnding(input.narration),
  ];

  return { ok: errors.length === 0, errors };
}
