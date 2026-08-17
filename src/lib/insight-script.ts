/**
 * The rules a single-insight short's script has to pass before anything is
 * rendered.
 *
 * ## Why this is a gate and not a lint
 *
 * Every stage after the script costs money: narration is billed per character,
 * every scene is a generated picture, and the render burns worker minutes. A
 * script that breaks the format is cheapest to catch here, before the first
 * billed call — the same argument `ScheduleService` makes for checking
 * readiness before it starts a run.
 *
 * ## Why the rules are this blunt
 *
 * They come from a format spec (see
 * docs/superpowers/specs/2026-08-17-knowsense-format-design.md) where the
 * constraints *are* the genre. A sixteen-word sentence is not a style
 * preference in a forty-second second-person short; it is the difference
 * between the thing working and not. Being able to fail a script on it, with a
 * message the model can act on, is what makes the retry loop useful rather
 * than decorative.
 *
 * Pure and dependency-free on purpose: no Prisma, no `server-only`, no React.
 * The same function checks a script in a test, in the generator's retry loop
 * and, if it is ever wanted, in the browser. `script-cues.ts` is the one import
 * and it is pure for the same reasons.
 */

import { extractAnchor, normalise, type ScriptCue } from "@/lib/script-cues";
import type { TransitionStyle } from "@/lib/video-style";

/** How fast the narration is assumed to be read, in words per second.
 *
 *  ~156 words a minute, which is the calm, unhurried end of a voiceover and
 *  what the format's timings are built on. Used only to sanity-check a
 *  script's own declared durations against its word count — the *render* never
 *  reads this, because by then the real alignment exists and a real number
 *  beats an assumed one. */
export const WORDS_PER_SECOND = 2.6;

/** The six beats, in the order they must appear. */
export const BEATS = [
  "HOOK",
  "TENSION",
  "MECHANISM",
  "NAME_IT",
  "TURN",
  "LOOP",
] as const;

export type Beat = (typeof BEATS)[number];

/**
 * Phrases that mark the script as generic short-form filler.
 *
 * Exported so the test asserts the list is *applied* rather than restating it —
 * a copy in the test would pass forever after somebody edited only the copy.
 *
 * Lowercase, matched case-insensitively as substrings. Every one of these is
 * either a stall ("here's the thing"), a hedge ("studies show"), or a piece of
 * borrowed hype ("mind-blowing") — and all three are the opposite of the flat,
 * certain register the format runs on.
 */
export const BANNED_PHRASES = [
  "in today's video",
  "in this video",
  "let's dive in",
  "buckle up",
  "delve",
  "it's important to note",
  "studies show",
  "studies suggest",
  "scientists were shocked",
  "here's the thing",
  "but here's where it gets interesting",
  "mind-blowing",
  "game-changer",
  "unlock",
  "hack your brain",
  "crazy",
  "insane",
] as const;

/** Longest a single scene's narration may run.
 *
 *  Sixteen, not fifteen or twenty: the format's rule is 8–14 words with one
 *  clause, and sixteen is the first length at which a sentence has reliably
 *  acquired a second clause. Enforced as a ceiling rather than a range because
 *  a short sentence is never the problem. */
export const MAX_WORDS_PER_SCENE = 16;

export const MIN_TOTAL_WORDS = 95;
export const MAX_TOTAL_WORDS = 150;
export const MIN_SCENE_SECONDS = 2.5;
export const MAX_SCENE_SECONDS = 5.0;

/** How far a script's declared timings may drift from its word count before it
 *  is treated as wrong rather than approximate. Six seconds on a fifty-second
 *  video is the point at which the writer has plainly stopped counting. */
export const MAX_TIMING_DRIFT_SECONDS = 6;

export interface InsightScene {
  id: number;
  beat: string;
  duration: number;
  narration: string;
  caption: string;
  visualBrief: string;
  emphasis: string[];
}

export interface InsightScript {
  conceptName: string;
  scenes: InsightScene[];
}

export interface ValidationResult {
  ok: boolean;
  /** One complete sentence per problem, safe to append to a retry prompt
   *  verbatim. Written for a model to act on rather than for a log. */
  errors: string[];
}

function words(text: string): number {
  const trimmed = text.trim();

  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function validateInsightScript(script: InsightScript): ValidationResult {
  const errors: string[] = [];
  const narration = script.scenes.map((scene) => scene.narration).join(" ");
  const total = words(narration);
  const haystack = narration.toLowerCase();

  if (total < MIN_TOTAL_WORDS || total > MAX_TOTAL_WORDS) {
    errors.push(
      `The narration is ${total} words. It must be between ${MIN_TOTAL_WORDS} ` +
        `and ${MAX_TOTAL_WORDS}.`,
    );
  }

  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(phrase)) {
      errors.push(`Remove the phrase "${phrase}". It is banned in this format.`);
    }
  }

  for (const scene of script.scenes) {
    const count = words(scene.narration);

    if (count > MAX_WORDS_PER_SCENE) {
      errors.push(
        `Scene ${scene.id} is ${count} words. No sentence may exceed ` +
          `${MAX_WORDS_PER_SCENE}; split it or cut it.`,
      );
    }

    if (scene.duration < MIN_SCENE_SECONDS || scene.duration > MAX_SCENE_SECONDS) {
      errors.push(
        `Scene ${scene.id} is ${scene.duration}s. Every scene must run between ` +
          `${MIN_SCENE_SECONDS} and ${MAX_SCENE_SECONDS} seconds.`,
      );
    }

    // An em dash is a second clause wearing punctuation. The format's whole
    // rhythm is one clause and a full stop.
    if (/[—–]/.test(scene.narration)) {
      errors.push(`Scene ${scene.id} contains a dash. Use a full stop instead.`);
    }

    if (/\p{Extended_Pictographic}/u.test(scene.narration)) {
      errors.push(`Scene ${scene.id} contains an emoji. Remove it.`);
    }

    // The caption is what is burned on screen. An empty one is a scene with no
    // words on it, which in this format reads as a rendering fault.
    if (scene.caption.trim().length === 0) {
      errors.push(`Scene ${scene.id} has no caption.`);
    }

    // Emphasis drives the voice. A word that is not in the line cannot be
    // stressed, and silently dropping it would make the setting look applied
    // when it was not.
    for (const word of scene.emphasis) {
      if (!scene.narration.toLowerCase().includes(word.toLowerCase())) {
        errors.push(
          `Scene ${scene.id} asks to stress "${word}", which is not in its ` +
            `narration.`,
        );
      }
    }
  }

  const beats = new Set(script.scenes.map((scene) => scene.beat));

  for (const beat of BEATS) {
    if (!beats.has(beat)) {
      errors.push(`The script has no ${beat} beat. All six are required.`);
    }
  }

  // Beats may span several scenes but may not interleave: a MECHANISM scene
  // after the NAME_IT payoff is a script that has lost its own shape.
  const order = script.scenes.map((scene) => BEATS.indexOf(scene.beat as Beat));

  for (let index = 1; index < order.length; index += 1) {
    if (order[index] !== -1 && order[index - 1] !== -1 && order[index] < order[index - 1]) {
      errors.push(
        `Scene ${script.scenes[index].id} is a ${script.scenes[index].beat} beat ` +
          `after a ${script.scenes[index - 1].beat} beat. The six beats must run ` +
          `in order.`,
      );
      break;
    }
  }

  const declared = script.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const spoken = total / WORDS_PER_SECOND;

  if (Math.abs(declared - spoken) > MAX_TIMING_DRIFT_SECONDS) {
    errors.push(
      `The scenes declare ${declared.toFixed(1)}s but ${total} words takes about ` +
        `${spoken.toFixed(1)}s to say. Bring the two within ` +
        `${MAX_TIMING_DRIFT_SECONDS}s of each other.`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The beat the whole video is built to arrive at, and the one join that is
 * allowed to be anything other than a cut.
 */
export const PAYOFF_BEAT = "NAME_IT";

/**
 * Six frames at 30fps.
 *
 * Long enough to register as a held breath and short enough that it is not a
 * transition. Anything approaching half a second — this app's default
 * crossfade — reads as a scene change in a slideshow, which is the opposite of
 * the point: the picture is supposed to stop, not to blend.
 */
export const PAYOFF_DIP_SECONDS = 0.2;

/**
 * What happens at each join in a single-insight video: nothing, everywhere,
 * except once.
 *
 * The format cuts hard. A dissolve between two shots says "time passed"; this
 * format's shots are consecutive sentences and there is no time between them.
 * The single exception is the join immediately BEFORE the payoff — the first
 * scene that names the effect — which dips through black. That is the whole
 * grammar: twelve cuts and one beat of silence in the picture, landing exactly
 * where the narration lands its point.
 *
 * Returns one entry per boundary, so `boundary i` sits between cue `i` and cue
 * `i + 1` — the indexing `planRender` uses. `null` is a hard cut, and a hard cut
 * costs nothing at all: no stub encoded, no tail donated, no trim.
 *
 * A script with no `NAME_IT` at all gets cuts throughout rather than an
 * arbitrary dip. So does one whose very first scene is the payoff: there is no
 * boundary before scene one, and dipping *after* it instead would put the beat
 * on the wrong side of the line it exists to set up. `validateInsightScript` is
 * what refuses a script missing the beat; this function's job is only to place
 * the dip, and placing it wrongly is worse than not placing it.
 */
export function insightTransitions(
  beats: readonly (string | undefined)[],
): (TransitionStyle | null)[] {
  const boundaries = Math.max(0, beats.length - 1);
  const payoff = beats.indexOf(PAYOFF_BEAT);
  // The join before the payoff scene, which is the boundary one index lower.
  const dipAt = payoff > 0 ? payoff - 1 : -1;

  return Array.from({ length: boundaries }, (_, boundary) =>
    boundary === dipAt
      ? { enabled: true, durationSeconds: PAYOFF_DIP_SECONDS, kind: "fadeblack" as const }
      : null,
  );
}

/** A script in the shape `ScriptVersion` actually stores: the narration as one
 *  string, and one cue per scene pointing into it. */
export interface ParsedInsightScript {
  content: string;
  cues: ScriptCue[];
}

/**
 * Turns the model's scene array into the two columns the pipeline reads.
 *
 * The mapping is one scene to one cue, and that is the whole reason this format
 * needed no new render path: `ScriptVersion.cues` is already a per-section
 * record of "what to show while these words are read", which is what a scene
 * is. `visualBrief` becomes the cue, the beat and the emphasis ride along on it
 * (see `CueMeta`), and the declared `duration` is deliberately dropped — the
 * render derives a clip's length from where its section actually falls in the
 * ElevenLabs alignment, so a model's guess about timing would be a second,
 * disagreeing answer to a question that already has a real one. The validator
 * above is the only thing that reads `duration`, and it reads it as a signal
 * that the script will run long rather than as an instruction.
 *
 * Every narration is run through `normalise` before being joined, and each
 * anchor is taken from the same normalised text, for the reason
 * `gateway.provider.ts` gives at its own join: an anchor that does not occur
 * byte-for-byte in `content` is orphaned by `anchorCues` on the very first
 * lookup, and a model that emits a double space inside a scene's opening would
 * otherwise cost that scene its picture for a reason no operator could see.
 *
 * Pure and total — it validates nothing. `validateInsightScript` is the gate
 * and runs before this, so a script that reaches here has already been judged.
 */
/**
 * Breaks multi-word emphasis into the words a caption can actually colour.
 *
 * The model reliably returns phrases — "Zeigarnik effect", "no clear reason",
 * "still open" — because that is how a person thinks about stress. The captions
 * match **per word**, stripping punctuation and case (see `kinetic-captions.ts`),
 * so "Zeigarnik effect" normalises to `zeigarnikeffect` and matches nothing at
 * all. The amber keyword simply never appears, and it never appears *most
 * loudly* on the NAME_IT line, where the concept is almost always two words.
 *
 * Nothing reports that. The caption renders, the word is just not coloured, and
 * the failure looks like the feature was never switched on.
 *
 * Splitting here rather than in `buildAss` because this is a fact about what the
 * model returns, and `buildAss` should keep answering one question — "is this
 * word stressed" — rather than growing a phrase matcher. The stored cue then
 * holds exactly what the renderer will look for.
 */
function splitEmphasis(emphasis: readonly string[]): string[] {
  const words = emphasis.flatMap((entry) => entry.split(/\s+/));

  // A phrase and one of its own words would otherwise colour the same word
  // twice, and an empty string matches everything.
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))];
}

export function insightScriptToScript(script: InsightScript): ParsedInsightScript {
  const narrations = script.scenes.map((scene) => normalise(scene.narration));

  return {
    content: narrations.join(" "),
    cues: script.scenes.map((scene, index) => ({
      anchor: extractAnchor(narrations[index]),
      cue: scene.visualBrief,
      beat: scene.beat,
      emphasis: splitEmphasis(scene.emphasis),
    })),
  };
}
