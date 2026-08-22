import type { FootageStyle } from "@/generated/prisma/enums";
import { readShotTag } from "@/lib/longform-script";
import { extractAnchor, type ScriptCue } from "@/lib/script-cues";
import type { ScriptSection } from "@/services/providers/types";

/**
 * The cadence arithmetic for the doodle format, and the reason it is arithmetic
 * on a section count rather than a rule in the renderer.
 *
 * `planStoryBeats` has two plans. The one it uses by default groups sections
 * into pictures held 15-25 seconds, from a constant measured on four-minute
 * bedtime stories. The other — taken when every cue carries a shot tag — cuts
 * one picture per cue, applies neither `BEAT_MIN_SECONDS` nor `MAX_BEATS`, and
 * is already how the long-form list format gets forty pictures out of eight
 * minutes. Its doc comment puts the whole design of this module in one line:
 * "Nothing here asks for that arithmetic; asking for forty sections is what
 * performs it."
 *
 * So a doodle channel's seconds-per-picture is converted into a *requested
 * section count* here, handed to the writer as a system instruction, and never
 * seen again. `footage.service.ts`, `render.service.ts` and `shorts.service.ts`
 * do not import this file and must not: they reach the same grouping from
 * `ScriptVersion.cues`, which all three already read, and that is what keeps
 * them from drifting apart.
 *
 * Pure, and client-safe on purpose — the branding screen shows the operator how
 * many pictures their setting implies before they save it.
 */

/**
 * The longest a doodle video may be.
 *
 * A money ceiling wearing a length's clothes. `MAX_BEATS` cannot serve here:
 * `planStoryBeats` deliberately does not apply it on the tagged path, because
 * "the writer's count is the count, it arrived with the script, and capping it
 * would drop shot forty-one silently". Capping the *duration* instead bounds
 * the spend without ever leaving narration with no picture over it.
 *
 * Five minutes at the fastest allowed cadence is sixty pictures, about $3.00 —
 * the same order as the ~$2.00 `MAX_BEATS` allows an illustrated video, and at
 * the expected seven seconds it is forty-three pictures and about $2.15.
 */
export const DOODLE_MAX_SECONDS = 300;

/**
 * The fastest a picture may be cut.
 *
 * Under five seconds stops being a video with a rhythm and becomes a strobe,
 * and it is also where the cost stops being defensible: the ceiling above is
 * computed against this number.
 */
export const DOODLE_BEAT_MIN_SECONDS = 5;

/**
 * The slowest a picture may be cut.
 *
 * Not a safety limit but a signpost. Twenty seconds is exactly what
 * `BEAT_TARGET_SECONDS` already gives an `ILLUSTRATED` channel, so a doodle
 * channel asking for more is asking for a style it could have picked directly —
 * and would be paying the tagged path's lack of a `MAX_BEATS` ceiling for the
 * privilege.
 */
export const DOODLE_BEAT_MAX_SECONDS = 20;

/**
 * How many sections the writer is asked for.
 *
 * Floored at one because a zero-section script is not a cheaper video, it is a
 * request for an empty one — the same reasoning `beatCountFor` gives for its
 * own floor.
 */
export function doodleSectionCount(targetSeconds: number, beatSeconds: number): number {
  return Math.max(1, Math.round(Math.max(0, targetSeconds) / beatSeconds));
}

/**
 * What the writer is told, as a system instruction.
 *
 * Sent *beside* the operator's prompt and never inside it, for the reasons
 * `script.service.ts` gives where it does the same thing for the recurring
 * character: `renderTemplate` treats a template's declared variables as
 * authoritative and leaves an undeclared `{{placeholder}}` unsubstituted so a
 * typo stays visible, so a token injected here would print verbatim in every
 * template that does not declare it — and appending prose to the template
 * instead would silently edit the operator's own template and then store the
 * edited text in `ScriptVersion.prompt`, whose whole job is to record what the
 * template said.
 *
 * It does NOT ask the writer to tag anything, and that is the correction a real
 * generation forced. The first version copied `longform-list` and asked for a
 * `[still]` tag on every cue; the model returned forty-three sections and
 * tagged none of them, which would have rendered fifteen pictures instead of
 * forty-three. Tagging was the wrong instrument anyway — `longform-list` tags
 * because its writer is choosing between drawn and filmed, and a doodle channel
 * draws EVERYTHING. There is no judgement to record, so `doodleCues` sets the
 * shot itself and the model is asked for one less thing to get wrong.
 */
export function doodleCadenceInstruction(sectionCount: number): string {
  return [
    "This channel draws every picture, one per section, so the number of " +
      "sections you write is the number of pictures the video has.",
    `Write exactly ${sectionCount} sections. Keep them short and even — this ` +
      "format cuts fast, and a section three times longer than its neighbours " +
      "holds one picture on screen while the rest flick past.",
    "Give every section a cue describing one drawing. Do not label the cues " +
      "or mark them in any way — this channel draws every section, so there is " +
      "nothing to choose between.",
  ].join("\n\n");
}

/**
 * A doodle script's cues: one per section, every one a still.
 *
 * The sibling of `longformCues`, and shorter by everything that function does
 * to decide between drawn and filmed. A doodle channel has no stock arm, so
 * there is no motion share to cap and no tag to read — the shot is `still` by
 * construction.
 *
 * That construction is the whole point. `planStoryBeats` takes its
 * one-picture-per-cue path only when EVERY cue carries a shot, and a model
 * asked to tag forty-three sections will eventually miss one; when it does, the
 * video silently renders at one picture every twenty seconds. Setting the shot
 * here rather than asking for it removes that failure mode instead of detecting
 * it — which is why there is no longer a warning for it to trigger.
 *
 * `readShotTag` still runs, for one reason: an earlier prompt asked for tags and
 * a model may still volunteer one. Left in the cue, `[still]` reaches the
 * illustration prompt as literal text and gets DRAWN — which is exactly what
 * `beatDoodlePrompt`'s no-text rule exists to prevent, arriving from inside.
 */
export function doodleCues(sections: readonly ScriptSection[]): ScriptCue[] {
  return sections.map((section) => {
    const stressed = stressWord(section.text);

    return {
      anchor: extractAnchor(section.text),
      cue: readShotTag(section.cue).cue,
      shot: "still" as const,
      // Omitted rather than an empty array when there is nothing worth
      // colouring: `CueMeta.emphasis` is optional, and an empty array reads as
      // "the writer considered this and chose none" rather than "nobody asked".
      ...(stressed ? { emphasis: [stressed] } : {}),
    };
  });
}

/**
 * The shortest word a caption is worth colouring.
 *
 * Under six characters is almost always a function word — "then", "over",
 * "with" — and a highlight on one of those reads as a rendering fault rather
 * than as stress. Six also happens to exclude every entry in `UNSTRESSED`
 * below that is not already excluded by length, which is why that list is as
 * short as it is.
 */
const STRESS_MIN_LENGTH = 6;

/** Long words that still carry no stress. Not a general stopword list — only
 *  the ones long enough to pass the length test above and common enough to be
 *  picked repeatedly across a script. */
const UNSTRESSED = new Set([
  "another",
  "because",
  "before",
  "between",
  "however",
  "nothing",
  "really",
  "should",
  "something",
  "through",
  "without",
]);

/**
 * The one word in a section a kinetic caption colours.
 *
 * Derived rather than asked for, and the reason is narration safety. Only the
 * insight format's schema carries an `emphasis` field; every other format
 * returns `{ text, cue }`, so asking a model to mark a word would mean putting
 * a marker in one of those two strings. `text` is sent to ElevenLabs verbatim —
 * an asterisk there is a character the voice reads. `cue` is safe but is the
 * tagging pattern this format already abandoned once, when the model returned
 * forty-three sections and tagged none of them.
 *
 * So: the longest content word wins. That picks a *plausible* stress rather
 * than the *meaningful* one — a human would sometimes choose differently — but
 * it is deterministic, costs nothing, needs no cooperation from the model, and
 * degrades to no highlight rather than to a wrong cadence. The captions still
 * chunk and still land on the beat without it, which is most of the effect.
 *
 * Ties go to the earliest word, so re-running on the same script colours the
 * same word — `planStoryBeats` is deterministic for the same reason.
 */
function stressWord(text: string): string | undefined {
  let best: string | undefined;

  for (const raw of text.split(/\s+/)) {
    // Punctuation is stripped from the ends only: `kinetic-captions.ts` matches
    // through punctuation, and a hyphenated word is one word to both of us.
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

    if (word.length < STRESS_MIN_LENGTH || UNSTRESSED.has(word.toLowerCase())) {
      continue;
    }

    if (!best || word.length > best.length) {
      best = word;
    }
  }

  return best;
}

/**
 * Whether this generation may proceed, and what the writer should be told.
 *
 * A discriminated union rather than thrown errors, so the decision is a pure
 * function of three values and can be tested without a database. The caller —
 * `script.service.ts`, the only one — turns a refusal into a `ValidationError`
 * at the point where it has the context to do so, and does it *before*
 * `chargeVideo`: a refusal is not a charge.
 */
export type DoodlePlan =
  | { readonly ok: true; readonly instruction: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The doodle format's two numbers, checked against each other.
 *
 * Null for any channel that is not `DOODLE`, which is most of them — the caller
 * reads that as "this format has nothing to say about your video" rather than
 * as an error.
 *
 * `declaredMinutes` arrives as the string the template variable holds, because
 * that is what the caller has: a prompt template's variables are strings all
 * the way to the model. Parsing it here keeps the caller from having a second
 * opinion about what "5" means.
 */
export function planDoodleGeneration(input: {
  footageStyle: FootageStyle;
  beatSeconds: number | null;
  declaredMinutes: string | undefined;
}): DoodlePlan | null {
  if (input.footageStyle !== "DOODLE") {
    return null;
  }

  const targetSeconds = Number(input.declaredMinutes) * 60;

  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    return {
      ok: false,
      reason:
        "A doodle video needs a duration in minutes before its pictures can be counted.",
    };
  }

  if (targetSeconds > DOODLE_MAX_SECONDS) {
    return {
      ok: false,
      reason:
        `A doodle video can be at most ${DOODLE_MAX_SECONDS / 60} minutes. This format ` +
        "draws every picture, so its length is what bounds what it costs.",
    };
  }

  if (input.beatSeconds === null) {
    return {
      ok: false,
      reason:
        "This channel has no seconds per picture set. Choose one on the channel's " +
        "branding screen — it decides how many pictures the video has, and there is " +
        "no sensible default to pick on the channel's behalf.",
    };
  }

  return {
    ok: true,
    instruction: doodleCadenceInstruction(
      doodleSectionCount(targetSeconds, input.beatSeconds),
    ),
  };
}
