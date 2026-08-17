import type { AutomationKind } from "@/services/automation-list.service";

/**
 * Which drops the canvas accepts, as a pure function.
 *
 * ## Why this exists at all
 *
 * The operator asked for a canvas they can arrange, and the positions are
 * theirs. The *edges* are not: every one of them is a foreign key.
 * `ReleaseCadence.channelId` is `@unique`, a series must agree with its
 * project's channel (`SeriesService.assertRecipe` enforces exactly that and
 * stays the only place that does), and a publish step belongs to precisely one
 * automation.
 *
 * In n8n any output reaches any input. Here most conceivable drops have to be
 * refused, and a canvas that refuses most drops *after* you make them teaches
 * the operator not to trust it. So this runs during the drag — React Flow's
 * `isValidConnection` — and every invalid target greys out before a drop
 * happens. The affordance and the rule agree at all times, which is the only
 * version of free positioning that stays honest.
 *
 * Pure, and separately tested, because it is the whole of the canvas's
 * correctness. Everything else in this folder is drawing.
 *
 * ## Every refusal carries a sentence
 *
 * Not a boolean. A greyed-out target answers "no" and the tooltip has to answer
 * "why not" — "this channel already has a shorts drip" is actionable, and a
 * target that simply will not light up is the operator wondering whether the
 * canvas is broken.
 */

export type CanvasNodeKind = "CHANNEL" | "AUTOMATION" | "PUBLISH";

export interface CanvasNodeRef {
  kind: CanvasNodeKind;
  /**
   * The underlying row's id. For a PUBLISH node this is its *automation's* id
   * rather than an id of its own — the publish step is a facet of the
   * automation, not a record. Sharing the id is what makes "wire this show to
   * that show's publish step" expressible, and therefore refusable, instead of
   * silently turning on auto-publish for a show the operator was not pointing
   * at.
   */
  id: string;
  automationKind?: AutomationKind;
  /** Only meaningful on a CHANNEL: whether it already has a shorts drip. */
  hasReleaseCadence?: boolean;
}

export type ConnectionOutcome =
  | { valid: true; action: "REPARENT" | "ENABLE_PUBLISH" | "ATTACH_CADENCE" }
  | { valid: false; reason: string };

const refuse = (reason: string): ConnectionOutcome => ({ valid: false, reason });

export function connectionOutcome(
  source: CanvasNodeRef,
  target: CanvasNodeRef,
): ConnectionOutcome {
  // A publish step is a leaf: nothing flows out of it. Checked first so none of
  // the branches below ever has to consider it as a source.
  if (source.kind === "PUBLISH") {
    return refuse(
      "A publish step is the end of a branch. Drag from the automation instead.",
    );
  }

  if (source.kind === "CHANNEL") {
    if (target.kind === "CHANNEL") {
      return refuse(
        "Channels do not connect to each other — each one is its own branch.",
      );
    }

    if (target.kind === "PUBLISH") {
      return refuse(
        "Drop this on the automation itself, not on its publish step.",
      );
    }

    if (target.automationKind === "RELEASE_CADENCE") {
      // `ReleaseCadence.channelId` is @unique per channel. Refusing here, mid
      // drag, is the whole point of this module: the alternative is a dialog
      // after the drop explaining a constraint the canvas already knew about.
      return source.hasReleaseCadence
        ? refuse(
            "This channel already has a shorts drip, and a channel can only " +
              "have one. Edit the existing drip instead of attaching a second.",
          )
        : { valid: true, action: "ATTACH_CADENCE" };
    }

    return { valid: true, action: "REPARENT" };
  }

  // source.kind === "AUTOMATION"
  if (target.kind !== "PUBLISH") {
    return refuse(
      "Automations do not feed each other. Drop this on its publish step, or " +
        "drag from a channel to move it.",
    );
  }

  if (source.automationKind === "RELEASE_CADENCE") {
    return refuse(
      "A shorts drip already publishes — that is the whole of what it does. " +
        "There is nothing here to switch on.",
    );
  }

  // See `CanvasNodeRef.id`: a publish step shares its automation's id, so a
  // mismatch means the operator dragged across branches.
  if (source.id !== target.id) {
    return refuse("That publish step belongs to a different automation.");
  }

  return { valid: true, action: "ENABLE_PUBLISH" };
}
