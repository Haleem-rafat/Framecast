import { z } from "zod";

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

/** The list page's multi-select "Delete selected" — capped well above any
 * realistic single page of videos, just so a malformed client payload can't
 * ask the DB to match an unbounded `IN (...)` list. */
export const deleteVideosSchema = z.array(z.string().uuid()).min(1).max(500);

export type DeleteVideosInput = z.infer<typeof deleteVideosSchema>;
