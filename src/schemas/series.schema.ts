import { z } from "zod";

import {
  autoPublishShape,
  MAX_TOPICS,
  recurrenceShape,
  requireMatchingDay,
  scheduleTopicSchema,
  scheduleVariablesSchema,
} from "@/schemas/schedule.schema";

/**
 * What one recurring show is, as a form submits it.
 *
 * Almost every field here is a reference to something that already exists —
 * a channel, a project, a script style — plus a cadence borrowed wholesale from
 * `schedule.schema.ts`. That is the shape of the feature: a series is a name
 * put on a bundle of existing settings, not a new pile of settings.
 *
 * The cadence fields, the topic bounds and the variable map are *imported*
 * rather than restated. A series' cadence is stored on a real `Schedule` row
 * and run by the real due-check, so a series that accepted a value a schedule
 * refuses would be a row the worker could not resolve.
 *
 * Deliberately absent: art style, voice, music, niche, tone, footage style,
 * language, category, made-for-kids. Those are the channel's, resolved through
 * `brandService.resolve` on the path every video already takes, and a series
 * cannot override them — see the `Series.channelId` comment in schema.prisma
 * for the argument. The form shows them, read-only, labelled as the channel's.
 */
const baseSeriesSchema = z.object({
  /** What the operator calls the show. Same 80-character working limit a
   *  schedule's name has, because in practice it names the same row in the
   *  same lists. */
  name: z.string().trim().min(1, "Give the series a name").max(80),
  /** The channel every episode inherits its look, voice and audience
   *  declaration from. Checked against the project's own channel by
   *  `SeriesService`, so the two can never disagree. */
  channelId: z.string().uuid(),
  /** Where the episodes are filed. */
  projectId: z.string().uuid(),
  /** The `PromptTemplate` that writes every episode. Validated by the service
   *  as owned, not deleted and in the SCRIPT category — this only bounds the
   *  shape. */
  promptTemplateId: z.string().uuid(),
  /** Landscape or vertical, decided once for the whole show rather than on
   *  every approve dialog. Mirrors the `VideoFormat` enum; kept as a literal
   *  union so this module stays importable from a client component. */
  format: z.enum(["LANDSCAPE", "VERTICAL"]),
  ...recurrenceShape,
  // Shared with `schedule.schema.ts` rather than restated, for the reason the
  // recurrence above is. Note this pair *is* read for a series, and is the pair
  // `resolveAutoPublish` prefers — the owned schedule's copy is dead data.
  ...autoPublishShape,
  variables: scheduleVariablesSchema,
});

/**
 * Creating a series seeds its topic queue in the same submission, for the same
 * reason creating a schedule does: a queue with nothing in it pauses itself on
 * the first occurrence, and nothing here will invent a subject to fill it.
 *
 * Unlike a schedule, at least one topic is *required*. A schedule can plausibly
 * be set up in advance of knowing what goes in it; a series that cannot make
 * anything is not a show, and "make one now" — the button the operator will
 * press the moment they land on the new page — has nothing to take.
 */
export const createSeriesSchema = baseSeriesSchema
  .extend({
    topics: z.array(scheduleTopicSchema).min(1).max(MAX_TOPICS),
  })
  .superRefine((value, ctx) => requireMatchingDay(value, ctx));

/** Editing never touches the queue — it is added to and removed from one topic
 *  at a time through the schedule's own actions, which the series page reuses
 *  unchanged. See `updateScheduleSchema` for why a bulk replace is worse. */
export const updateSeriesSchema = baseSeriesSchema.superRefine((value, ctx) =>
  requireMatchingDay(value, ctx),
);

export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;
export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;
