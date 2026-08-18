import { z } from "zod";

import { VOICE_ID, VOICE_NAME_MAX } from "@/schemas/channel.schema";

export const createVideoSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1, "Title is required").max(120),
  topic: z.string().min(3, "Give the topic a few more words").max(300),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

/**
 * What Gate 1 accepts: the one irreversible choice approving a script makes.
 *
 * A closed enum rather than a free string, and validated on the server rather
 * than trusted from the dialog, because this value decides what the renderer
 * spends the next quarter of an hour producing. `VideoFormat` is mirrored here
 * as literals rather than imported from the generated Prisma enums so this
 * schema stays usable from a client component; `approveScript`'s parameter type
 * is the generated enum, so the two cannot drift without a type error.
 */
export const approveScriptSchema = z.object({
  format: z.enum(["LANDSCAPE", "VERTICAL"]),
});

export type ApproveScriptInput = z.infer<typeof approveScriptSchema>;

/**
 * What the "change the voice" dialog sends.
 *
 * `VOICE_ID` is imported from the branding schema rather than restated,
 * because the bound it applies is load-bearing in exactly the same way in both
 * places and for the same reason: this string is interpolated straight into
 * ElevenLabs' synthesis URL, so a slash or a `?` in it would be a different
 * request to a different endpoint. Two copies of that rule is one copy that
 * can be relaxed by someone who does not know why it is there. Unlike
 * branding's own field it is not nullable — there is no "no voice" answer to
 * "re-narrate in which voice", and an operator who wants the channel's voice
 * back picks it from the same list.
 *
 * Which ids are *real* is deliberately not validated, again as branding does
 * not: that is a fact about the operator's ElevenLabs account, the picker only
 * ever offers ids that account returned, and a voice deleted upstream after
 * being chosen is a synthesis failure no regex could have caught.
 *
 * `voiceName` is display only and nullable — a picker that could not reach
 * ElevenLabs has an id and no name. It is normalised against the id at the
 * write (see `VideoService.requestRenarration`) rather than trusted here,
 * because a schema can bound the string but cannot know it is meaningless
 * without the other one.
 */
export const renarrateVideoSchema = z.object({
  voiceId: z
    .string()
    .trim()
    .regex(VOICE_ID, "That is not an ElevenLabs voice id"),
  voiceName: z
    .union([z.string(), z.null()])
    .transform((value) => value?.trim() ?? "")
    .pipe(z.string().max(VOICE_NAME_MAX))
    .transform((value) => (value.length === 0 ? null : value)),
});

export type RenarrateVideoInput = z.infer<typeof renarrateVideoSchema>;

/** The list page's multi-select "Delete selected" — capped well above any
 * realistic single page of videos, just so a malformed client payload can't
 * ask the DB to match an unbounded `IN (...)` list. */
export const deleteVideosSchema = z.array(z.string().uuid()).min(1).max(500);

export type DeleteVideosInput = z.infer<typeof deleteVideosSchema>;

/**
 * The most shorts one Generate click may queue.
 *
 * There has to be a ceiling because nothing between the action and the worker
 * rate-limits this: the count decides how many `generateObject` moments the
 * model is asked to tell apart in a single call, and then how many rows the
 * worker must encode before anything else on the box renders. An unbounded
 * count is an unbounded queue, from a number the browser chose.
 *
 * Ten rather than seven, which is what an eight-minute video actually yields at
 * 12–60 seconds a clip: the ceiling is a guard, not the recommendation, and
 * pinning it to today's longest script would mean editing a schema the next
 * time someone writes a longer one. Ten is still a set an operator can review
 * in a sitting, which is the other half of what makes this number a cost.
 *
 * Over-asking is not an error, though — `generate` drops every moment that
 * overlaps one it already took, so a count larger than the narration can hold
 * simply returns fewer shorts.
 */
export const MAX_SHORT_COUNT = 10;

/**
 * How many moments one `generateShortsAction` asks for.
 *
 * No `.default()` here on purpose. The default lives in one place —
 * `shortsService.generate`'s own `count` parameter — and the action passes
 * `undefined` straight through to it rather than restating the number, so the
 * two cannot drift. A literal here would be a second answer to "how many
 * shorts is a Generate click", and the panel would then be a third.
 */
export const shortCountSchema = z
  .number()
  .int("Ask for a whole number of shorts.")
  .min(1, "Generate at least one short.")
  .max(MAX_SHORT_COUNT, `One click can queue at most ${MAX_SHORT_COUNT} shorts.`);
