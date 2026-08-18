/**
 * The rules an eight-minute list script has to pass before anything is
 * rendered, and the one place its shot tags are read.
 *
 * ## Why this is a gate and not a lint
 *
 * The same argument `insight-script.ts` makes, with an order of magnitude more
 * money behind it. A long-form list is the first format in this app that asks
 * for forty pictures: `story-beats.ts` prices `MAX_BEATS` at about $2 of
 * generated stills, and that is spent *after* the narration is billed per
 * character and *before* anybody has watched a frame. A script that came back
 * the wrong shape is cheapest to catch here, on the model's own answer, where
 * the fix costs one more four-cent call.
 *
 * ## The failure this exists for
 *
 * `planStoryBeats` switches to one-picture-per-cue only when **every** cue
 * carries a shot tag (`isShotScripted`, an `every` and deliberately so). A
 * single untagged section silently drops the video from forty slots back to the
 * twenty-four `BEAT_TARGET_SECONDS` produces — which renders, costs 40% less,
 * and looks like a slideshow. Nothing downstream can tell that apart from a
 * script that never asked for shots at all. This module is the only place the
 * difference is visible, so an untagged section is an error here rather than a
 * surprise on the finished video.
 *
 * ## Where the shot tag lives, and why it lives there
 *
 * On the end of the cue string, in square brackets, stripped by `readShotTag`
 * below. Not as a field of its own on `ScriptSection`: the sections schema in
 * `gateway.provider.ts` is shared by every prose style in the catalogue, and
 * adding a `shot` field to it would send a shot question to the eight styles
 * that have no shots — where "the model returned no tag" and "this format has
 * no tags to return" would become the same answer. The cue is already this
 * format's per-section visual field; the tag rides on it and is removed before
 * anything searches with it.
 *
 * Pure and dependency-free on purpose: no Prisma, no `server-only`, no React.
 * The same functions run in a test, in the generator's retry loop, and in the
 * browser if it is ever wanted.
 */

import { BANNED_PHRASES } from "@/lib/insight-script";
import { extractAnchor, type ScriptCue } from "@/lib/script-cues";

/** The narration a section carries. Under twenty and the video is being cut
 *  faster than the pictures can hold; over forty and one picture is covering
 *  two ideas. */
export const MIN_WORDS_PER_SECTION = 20;
export const MAX_WORDS_PER_SECTION = 40;

/** How many sections an eight-minute list runs to. Forty is `MAX_BEATS`, whose
 *  own comment already prices it at about $2 of generated stills — the first
 *  format with a reason to reach that ceiling. The band either side of it is
 *  wide enough that a writer counting words rather than sections still lands
 *  inside it, and narrow enough that thirty is a script that stopped early. */
export const MIN_SECTIONS = 32;
export const MAX_SECTIONS = 44;

/**
 * The share of sections that may be filled from a stock library.
 *
 * A cap in code and not only in the prompt, because a prompt is a request. A
 * model that tags everything `motion` would turn an eight-minute video into a
 * stock reel, which is the exact thing generated stills exist to avoid; the
 * excess falls back to stills in cue order rather than failing the script.
 *
 * Not checked by `checkLongformScript` for that reason — a rule the code
 * enforces silently must not also spend a retry. See `longformCues`.
 */
export const MAX_MOTION_SHARE = 0.35;

/** What a section wants on screen. The two values `CueMeta.shot` carries. */
export type Shot = "still" | "motion";

/** One section of the model's answer, in the shape `ScriptSection` already
 *  has. Declared here rather than imported so this module keeps its promise
 *  of importing nothing from `services/` — the two are structurally the same
 *  object, and `checkLongformScript` accepts either. */
export interface LongformSection {
  text: string;
  cue: string;
}

export interface LongformCheck {
  ok: boolean;
  /** One complete sentence per problem, safe to append to a retry prompt
   *  verbatim. Written for a model to act on rather than for a log — the same
   *  contract `validateInsightScript` returns under. */
  errors: string[];
}

/**
 * Splits a cue into the search query and the tag the writer put on it.
 *
 * Both ends are accepted, and both bracket shapes, because the tag is a
 * convention stated in a prompt rather than a field a schema enforces: a model
 * that leads with `(motion)` has done what it was asked and should not lose the
 * video fourteen slots over a punctuation choice. Anything else — no tag, a
 * word that is not one of the two, a tag in the middle of the query — comes
 * back untagged, and `checkLongformScript` is what refuses the script for it.
 *
 * The tag is always removed from the returned cue, including when it was the
 * whole string, because what remains is handed to a stock search or to an
 * illustration prompt and neither has any use for the word "motion".
 */
export function readShotTag(cue: string): { cue: string; shot?: Shot } {
  const tagged = /^\s*[[(](still|motion)[\])]\s*|\s*[[(](still|motion)[\])]\s*$/i;
  const match = tagged.exec(cue);

  if (!match) {
    return { cue: cue.trim() };
  }

  return {
    cue: cue.replace(tagged, "").trim(),
    shot: (match[1] ?? match[2]).toLowerCase() as Shot,
  };
}

function words(text: string): number {
  const trimmed = text.trim();

  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Judges a long-form list script on the things that can be checked cheaply and
 * certainly, and on nothing else.
 *
 * Deliberately **not** checked, so that the reasons are on the record rather
 * than rediscovered: the motion share (capped in `longformCues` instead, where
 * it costs nothing to fix), two motion shots in a row, a cue repeated from the
 * section before, and whether the ranking the prompt asks for is defensible.
 * The first is handled; the rest are judgements about the writing that a second
 * ask would answer no better than the first, and every rejection here is a
 * second bill.
 */
export function checkLongformScript(
  sections: readonly LongformSection[],
): LongformCheck {
  const errors: string[] = [];

  if (sections.length < MIN_SECTIONS || sections.length > MAX_SECTIONS) {
    errors.push(
      `The script has ${sections.length} sections. An eight-minute list needs ` +
        `between ${MIN_SECTIONS} and ${MAX_SECTIONS}, at about 30 words each.`,
    );
  }

  const untagged: number[] = [];

  sections.forEach((section, index) => {
    // 1-based, because the model numbered nothing and an operator reading the
    // error counts from one.
    const at = index + 1;
    const count = words(section.text);

    if (count < MIN_WORDS_PER_SECTION || count > MAX_WORDS_PER_SECTION) {
      errors.push(
        `Section ${at} is ${count} words. Every section must run between ` +
          `${MIN_WORDS_PER_SECTION} and ${MAX_WORDS_PER_SECTION}.`,
      );
    }

    const { cue, shot } = readShotTag(section.cue);

    if (shot === undefined) {
      untagged.push(at);
    }

    // A section with a tag and nothing else has no search query at all, which
    // is a section with no picture — the tag is the one part of the cue the
    // pipeline never looks anything up with.
    if (cue.length === 0) {
      errors.push(
        `Section ${at} has no visual cue, only a shot tag. Give it a two to ` +
          `five word search query as well.`,
      );
    }
  });

  // One sentence for all of them rather than one each. Forty untagged sections
  // is one mistake made forty times, and forty near-identical lines in a retry
  // prompt bury the other problems under themselves.
  if (untagged.length > 0) {
    errors.push(
      `${untagged.length} section(s) carry no shot tag: ` +
        `${untagged.join(", ")}. Every section must end its cue with ` +
        `[still] or [motion] — a single missing tag drops the whole video ` +
        `back to a picture every twenty seconds.`,
    );
  }

  const haystack = sections
    .map((section) => section.text)
    .join(" ")
    .toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(phrase)) {
      errors.push(`Remove the phrase "${phrase}". It is banned in this format.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Turns the model's sections into the cues `ScriptVersion` stores, with the
 * stock share capped.
 *
 * The cap is applied here rather than in `footage.service.ts`, and that is the
 * load-bearing choice: `render.service.ts` and the collector each re-derive the
 * picture plan from the stored cues, independently and with no stored plan to
 * share (see `story-beats.ts`). A cap applied at collection time would be a
 * decision only one of them made. Trimmed into the cues, it is simply what the
 * script says, and the two cannot disagree about it.
 *
 * Excess motion tags fall back to stills **in cue order** — the first
 * `floor(n * MAX_MOTION_SHARE)` keep theirs. Not the "best" ones, because
 * nothing here can rank them, and not at random, because a script generated
 * twice must produce the same video twice.
 */
export function longformCues(
  sections: readonly LongformSection[],
): ScriptCue[] {
  const allowed = Math.floor(sections.length * MAX_MOTION_SHARE);
  let spent = 0;

  return sections.map((section) => {
    const { cue, shot } = readShotTag(section.cue);
    const motion = shot === "motion" && spent < allowed;

    if (motion) {
      spent += 1;
    }

    return {
      anchor: extractAnchor(section.text),
      cue,
      // Always present, never undefined: `isShotScripted` is an `every` over
      // `Boolean(cue.shot)`, so a cue that fell back to a still still has to
      // say so out loud or it would take the whole video off the shot-scripted
      // path it was written for.
      shot: motion ? ("motion" as const) : ("still" as const),
    };
  });
}
