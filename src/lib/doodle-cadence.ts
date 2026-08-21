import type { ScriptCue } from "@/lib/script-cues";

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
 * The paragraph about a missing tag is not padding. One untagged section out of
 * forty-three drops `isShotScripted` to false and the video renders fifteen
 * pictures instead of forty-three — a finished-looking video that is quietly
 * the wrong film. `longform-list` warns about the same thing in its own prompt
 * for the same reason.
 */
export function doodleCadenceInstruction(sectionCount: number): string {
  return [
    "This channel draws every picture, one per section, so the number of " +
      "sections you write is the number of pictures the video has.",
    `Write exactly ${sectionCount} sections. Keep them short and even — this ` +
      "format cuts fast, and a section three times longer than its neighbours " +
      "holds one picture on screen while the rest flick past.",
    "Tag every section by putting [still] at the end of its cue. Every " +
      "section, without exception: one picture per section only happens when " +
      "every single one is tagged, and a single missing tag silently drops the " +
      "video to one picture every twenty seconds.",
  ].join("\n\n");
}

/**
 * How many cues came back without a shot tag.
 *
 * The detector for the one silent failure this format introduces. Zero for an
 * empty script rather than "all of them": `planStoryBeats` also declines the
 * tagged path for an empty script, but for an unrelated reason, and reporting
 * "0 of 0 sections untagged" would be noise on a script that has other problems.
 */
export function countUntaggedCues(cues: readonly ScriptCue[]): number {
  return cues.filter((cue) => !cue.shot).length;
}
