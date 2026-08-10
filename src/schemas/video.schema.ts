import { z } from "zod";

export const createVideoSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1, "Title is required").max(120),
  topic: z.string().min(3, "Give the topic a few more words").max(300),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

/** The list page's multi-select "Delete selected" — capped well above any
 * realistic single page of videos, just so a malformed client payload can't
 * ask the DB to match an unbounded `IN (...)` list. */
export const deleteVideosSchema = z.array(z.string().uuid()).min(1).max(500);

export type DeleteVideosInput = z.infer<typeof deleteVideosSchema>;
