import { z } from "zod";

/**
 * What the automation canvas is allowed to send back.
 *
 * The canvas is the first surface in this app that writes on a *gesture* rather
 * than on a Save button, which is why these bounds are tighter than a form's.
 * A drag emits a position per animation frame; a malformed or hostile payload
 * reaches the same action the honest one does.
 */

/**
 * A node position as the canvas reports it.
 *
 * `.finite()` is the load-bearing half. React Flow's transform arithmetic can
 * produce `NaN` or `Infinity` from a degenerate viewport — a zoom of zero, a
 * container measured at zero width during a layout thrash — and Postgres
 * accepts both into a `DOUBLE PRECISION` column quite happily. The canvas then
 * reads back a node it cannot lay out, on every load, with no way to fix it
 * from the UI because the node is not on screen to drag. Refusing the write is
 * the only outcome that stays recoverable.
 *
 * The range is a sanity bound rather than a real limit: a hundred thousand
 * pixels is far past any arrangement a person would make, and far short of
 * where floating point gets interesting.
 */
const coordinate = z.number().finite().min(-100_000).max(100_000);

export const moveCanvasNodeSchema = z.object({
  /** Opaque by design — see `CanvasNode.nodeKey`. Bounded in length only,
   *  because validating its shape here would mean a second copy of the key
   *  vocabulary that could disagree with the one the canvas builds. */
  nodeKey: z.string().min(1).max(120),
  x: coordinate,
  y: coordinate,
});

export const setAutomationViewSchema = z.object({
  view: z.enum(["CANVAS", "TABLE"]),
});

/**
 * Turning auto-publish on or off from the canvas.
 *
 * `kind` is part of the payload rather than inferred from the id because the
 * two kinds live in different tables and their ids are unique only within one.
 * The action uses it to pick the table; ownership is still checked there, so a
 * lie about the kind reaches a `where` that will not match.
 *
 * `RELEASE_CADENCE` is deliberately absent from the union. A shorts drip has no
 * switch — publishing is the whole of what it does — and `connectionOutcome`
 * already refuses to draw the edge that would ask for one.
 */
export const setAutoPublishSchema = z.object({
  kind: z.enum(["SERIES", "TOPIC_QUEUE"]),
  id: z.string().uuid(),
  enabled: z.boolean(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]),
});

export type MoveCanvasNodeInput = z.infer<typeof moveCanvasNodeSchema>;
export type SetAutomationViewInput = z.infer<typeof setAutomationViewSchema>;
export type SetAutoPublishInput = z.infer<typeof setAutoPublishSchema>;
