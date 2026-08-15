/**
 * The sentences the delete confirmation puts in front of an operator, as
 * functions of `projectService.deletionImpact`'s counts.
 *
 * Pure and separate from `DeleteProjectButton` for the same reason
 * `DataTable`'s sorting and filtering are pure and separate from the table:
 * this repo's Vitest environment is `node`, so there is no DOM to render a
 * dialog into, and these strings are the part worth protecting from a future
 * edit. They are a promise about something irreversible — how many videos go,
 * and what happens to the ones on YouTube — so a wrong plural or a dropped
 * clause is a defect, not a typo.
 */
export interface DeletionImpact {
  videoCount: number;
  publishedCount: number;
  /** Videos the render worker is holding *right now*; the reason `remove` refuses. */
  activeRenderCount: number;
}

function videos(count: number) {
  return count === 1 ? "1 video" : `${count} videos`;
}

/**
 * What deleting removes, counted, and what it does not touch.
 *
 * The YouTube clause is not padding. Framecast deleting its own record does
 * not unpublish anything, and an operator reaching for "delete" on a project
 * full of published videos may well believe it does — this is the only place
 * they are told otherwise before it is too late to matter.
 */
export function describeDeletion(impact: DeletionImpact): string {
  const scope =
    impact.videoCount === 0
      ? "This permanently removes the project, which has no videos, from Framecast."
      : `This permanently removes the project and its ${videos(impact.videoCount)} — ` +
        "their scripts and renders included — from Framecast.";

  const undo = " It cannot be undone.";

  if (impact.publishedCount === 0) {
    return scope + undo;
  }

  const subject =
    impact.publishedCount === 1
      ? "1 of those videos is published"
      : `${impact.publishedCount} of those videos are published`;
  const pronoun = impact.publishedCount === 1 ? "it" : "them";

  return (
    scope +
    undo +
    ` ${subject} on YouTube and will stay there: deleting the record here takes ` +
    `nothing down. Removing ${pronoun} from YouTube is a separate step in ` +
    "YouTube Studio."
  );
}

/**
 * The refusal, said before the click rather than delivered as a toast after
 * it. `null` when nothing is blocking — the caller uses that to decide whether
 * to arm the confirm button at all, so "no message" and "safe to proceed" are
 * deliberately the same answer.
 */
export function describeRefusal(impact: DeletionImpact): string | null {
  if (impact.activeRenderCount === 0) return null;

  const subject =
    impact.activeRenderCount === 1
      ? "1 video in this project is being rendered"
      : `${impact.activeRenderCount} videos in this project are being rendered`;

  return (
    `${subject} right now, so this delete will be refused. Cancel the ` +
    `render${impact.activeRenderCount === 1 ? "" : "s"} on the Videos page first.`
  );
}
