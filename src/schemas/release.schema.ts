import { z } from "zod";

import { MINUTES_PER_DAY, parseSlot } from "@/lib/release-time";
import { isValidTimeZone } from "@/lib/schedule-time";

/**
 * The IANA zone the channel's audience is in.
 *
 * Same bounds and the same `isValidTimeZone` refinement schedule.schema.ts
 * uses, for the same reason: a typo'd zone throws inside `nextSlotAfter`, and
 * it would throw in the worker's poll loop days after the cadence was saved.
 * Not shared as a constant with that file only because the two schemas have no
 * other reason to depend on each other; the refinement — which is where the
 * behaviour actually lives — is the same function in both.
 */
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "That is not a timezone this system recognises.");

/**
 * How many release times one cadence may hold.
 *
 * The operator's case is three a day, and this is deliberately not three. The
 * number that matters is the *supply*: three long videos a week yield about
 * seven clips each, so twenty-one a week is what the bank can sustain, and
 * three a day is what spends exactly that. An operator who publishes four long
 * videos, or whose shorts generator returns more moments, should be able to
 * say so without a migration. Twelve is roughly hourly across a waking day —
 * past that the cadence is not a release schedule, it is a firehose, and the
 * cap is what stops a pasted list turning one tick into a hundred uploads.
 */
export const MAX_SLOTS = 12;

/**
 * One release time, as minutes past local midnight.
 *
 * Stored and validated as a number rather than a `"HH:MM"` string because that
 * is what the column holds and what `nextSlotAfter` sorts. `parseSlot` is the
 * one place the form's string becomes this number, so the form and the schema
 * can never disagree about what a time of day is.
 */
export const slotMinutesSchema = z
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY - 1);

/**
 * The set of times, normalised on the way in.
 *
 * Sorted and de-duplicated here rather than only in `release-time.ts`, so the
 * column itself is stored in the order the operator reads it. The duplicate
 * check is a refusal rather than a silent collapse: an operator who typed
 * 08:00 twice made a mistake worth pointing at, and quietly saving two slots as
 * one would leave the form showing something different from what was submitted.
 */
export const slotsSchema = z
  .array(slotMinutesSchema)
  .min(1, "Pick at least one time of day to release at")
  .max(MAX_SLOTS, `A cadence can hold at most ${MAX_SLOTS} release times.`)
  .refine(
    (slots) => new Set(slots).size === slots.length,
    "Two of these release times are the same.",
  )
  .transform((slots) => [...slots].sort((a, b) => a - b));

/**
 * What a dripped short goes out as.
 *
 * PRIVATE is offered and is not the default — see `ReleaseCadence.visibility`
 * in schema.prisma. It is here at all because it is the only way to rehearse a
 * cadence: an operator who wants to watch the timing work before anything is
 * visible can run a day at PRIVATE and switch it afterwards.
 */
export const releaseVisibilitySchema = z
  .enum(["PUBLIC", "UNLISTED", "PRIVATE"])
  .default("PUBLIC");

const baseCadenceShape = {
  slotMinutes: slotsSchema,
  timeZone: timeZoneSchema,
  visibility: releaseVisibilitySchema,
} as const;

/**
 * Creating a cadence names the channel it belongs to; editing one never can.
 *
 * Moving a cadence between channels would move its history with it — the runs
 * hang off the cadence, not the channel — so a row that said "nothing went out
 * on Tuesday" would come to be about a channel that was not even connected on
 * Tuesday. Deleting and recreating is the honest way to express it, and it is
 * one click.
 */
export const createReleaseCadenceSchema = z.object({
  channelId: z.string().uuid(),
  ...baseCadenceShape,
});

export const updateReleaseCadenceSchema = z.object(baseCadenceShape);

/** The form submits `"08:00"` strings; this is the one conversion, exported so
 *  the client component and the schema cannot drift. Returns null for anything
 *  that is not a time of day, which the caller reports against the field. */
export function parseSlotList(values: readonly string[]): number[] | null {
  const minutes: number[] = [];

  for (const value of values) {
    const parsed = parseSlot(value);

    if (parsed === null) {
      return null;
    }

    minutes.push(parsed);
  }

  return minutes;
}

export type CreateReleaseCadenceInput = z.infer<typeof createReleaseCadenceSchema>;
export type UpdateReleaseCadenceInput = z.infer<typeof updateReleaseCadenceSchema>;
