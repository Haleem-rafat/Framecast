import { z } from "zod";

import { isValidTimeZone } from "@/lib/schedule-time";

/**
 * Same character class `promptVariableSchema` (prompt.schema.ts) and
 * `automation.schema.ts` both enforce on a `PromptVariable.key`. A schedule
 * carries exactly the map the guided flow submits, so the two entry points must
 * not disagree about what a valid key is.
 */
const variableKeySchema = z.string().regex(/^[a-zA-Z0-9_]+$/);

/** Mirrors `startAutomationSchema`'s own ceiling, and for the same reason: a
 *  template can declare at most 20 variables, so double that bounds what an
 *  arbitrary POST can hand the service to iterate over. */
const MAX_VARIABLES = 40;

/**
 * How many topics one schedule may hold.
 *
 * Two years of weekly videos. The queue is meant to be a batch of subjects the
 * operator sat down and wrote, not a content calendar for the decade, and a cap
 * keeps a pasted spreadsheet from turning into a hundred-thousand-row insert.
 */
export const MAX_TOPICS = 104;

/**
 * Topic bounds copied verbatim from `startAutomationSchema`, not loosened. Each
 * one of these is eventually handed to `automationService.start` as its `topic`,
 * so a topic accepted here has to be one that call would also accept —
 * otherwise a schedule would take a topic happily on Tuesday and fail on it at
 * 09:00 the following Monday, in a worker, with nobody watching.
 */
export const scheduleTopicSchema = z
  .string()
  .trim()
  .min(3, "Give the topic a few more words")
  .max(300);

/**
 * The IANA zone the operator's wall clock is in.
 *
 * Validated against Node's own zone database rather than a regex. A typo'd zone
 * is not a cosmetic problem: `nextOccurrence` throws on it, and it would throw
 * inside the worker's poll loop weeks after the schedule was saved, which is
 * both the worst place to discover it and the hardest to trace back to the form
 * that caused it.
 */
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "That is not a timezone this system recognises.");

/**
 * The cadence fields, as a reusable shape rather than a finished schema.
 *
 * A `Series` names a cadence too, and it must be the *same* cadence: the
 * columns are the same columns, `ScheduleService` reads them with the same
 * `recurrenceOf`, and the worker resolves them with the same `advancePast`. A
 * second copy of these bounds in series.schema.ts is exactly how a series would
 * one day accept an hour of 24 that a schedule refuses.
 */
export const recurrenceShape = {
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getUTCDay` and
   *  `WEEKDAY_NAMES`. Required for WEEKLY, ignored otherwise. */
  dayOfWeek: z.number().int().min(0).max(6).nullable().default(null),
  /** 1–31. Required for MONTHLY, ignored otherwise. A day the chosen month does
   *  not have clamps to that month's last day — see `nextOccurrence`. */
  dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timeZone: timeZoneSchema,
} as const;

/**
 * Answers for the operator's own prompt variables, keyed by
 * `PromptVariable.key`. Never validated against a fixed list here, for the
 * same reason `startAutomationSchema` does not: which variables exist is a
 * property of a template the operator can edit at any time. `ScheduleService`
 * reconciles this against the real declarations.
 */
export const scheduleVariablesSchema = z
  .record(variableKeySchema, z.string().max(500))
  .refine((value) => Object.keys(value).length <= MAX_VARIABLES, {
    message: `A prompt cannot declare more than ${MAX_VARIABLES} variables.`,
  })
  .default({});

/**
 * Whether the videos this automation makes upload themselves, and as what.
 *
 * Exported and shared with `series.schema.ts` rather than restated there,
 * because the two forms are asking the operator the same question about the
 * same pair of columns. `recurrenceShape` above is shared for the same reason.
 *
 * Both defaults are the cautious end, and deliberately unlike
 * `releaseVisibilitySchema`, which defaults to PUBLIC. A shorts cadence is
 * spending clips cut from a video the operator already chose to publish; this
 * is the first time anything reaches a channel, so the default has to be the
 * one you can walk back from — this app has no unpublish path.
 */
export const autoPublishShape = {
  autoPublish: z.boolean().default(false),
  publishVisibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).default("PRIVATE"),
  /**
   * Whether reaching READY also cuts reels out of the video.
   *
   * Defaulted false like its neighbours, and for a milder version of the same
   * reason: selection spends a model call rather than reaching a channel, so
   * the cost of it being wrong is money rather than something published that
   * cannot be unpublished. Still off by default — nothing should start spending
   * because a column was added.
   */
  autoShorts: z.boolean().default(false),
} as const;

const baseScheduleSchema = z.object({
  name: z.string().trim().min(1, "Give the schedule a name").max(80),
  projectId: z.string().uuid(),
  ...recurrenceShape,
  ...autoPublishShape,
  variables: scheduleVariablesSchema,
});

/**
 * The cross-field rule the flat shape cannot express: each frequency needs
 * exactly the one day field it uses.
 *
 * Enforced rather than defaulted because a weekly schedule with no `dayOfWeek`
 * has no meaning at all — `nextOccurrence` would have to invent one, and an
 * invented answer to "which day does my video appear" is the single worst thing
 * this feature could get wrong quietly.
 */
export function requireMatchingDay(
  value: {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY";
    dayOfWeek: number | null;
    dayOfMonth: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.frequency === "WEEKLY" && value.dayOfWeek === null) {
    ctx.addIssue({
      code: "custom",
      path: ["dayOfWeek"],
      message: "Pick the day of the week this should run.",
    });
  }

  if (value.frequency === "MONTHLY" && value.dayOfMonth === null) {
    ctx.addIssue({
      code: "custom",
      path: ["dayOfMonth"],
      message: "Pick the day of the month this should run.",
    });
  }
}

/**
 * Creating a schedule optionally seeds its topic queue in the same submission.
 *
 * Deliberately part of `create` rather than a second step: a schedule with an
 * empty queue is a schedule that pauses itself on its first occurrence, so
 * asking for the first few topics up front is asking for the thing that makes
 * it work at all. It is still `.default([])` — an operator who wants to paste a
 * long list on the detail page afterwards is not blocked from saving.
 */
export const createScheduleSchema = baseScheduleSchema
  .extend({
    topics: z.array(scheduleTopicSchema).max(MAX_TOPICS).default([]),
  })
  .superRefine((value, ctx) => requireMatchingDay(value, ctx));

/**
 * Editing never touches the queue. Topics are added and removed one at a time
 * through their own actions, because the queue is partly *consumed* — a bulk
 * replace would have to decide what to do about the rows already spent, and
 * every answer to that is worse than not asking.
 */
export const updateScheduleSchema = baseScheduleSchema.superRefine(
  (value, ctx) => requireMatchingDay(value, ctx),
);

/** Appending to the queue. A textarea of one topic per line arrives here as an
 *  array, so a paste of ten subjects is one round trip. */
export const addScheduleTopicsSchema = z.object({
  topics: z.array(scheduleTopicSchema).min(1).max(MAX_TOPICS),
});

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type AddScheduleTopicsInput = z.infer<typeof addScheduleTopicsSchema>;
