/**
 * The vocabulary of "I have read this, stop showing it to me".
 *
 * Everything onboarding remembers about a person is one string in
 * `UserSetting.onboardingSeen`. There is no per-surface column and no
 * per-surface table, because the only question any of these surfaces asks is
 * the same question: is this key in the set.
 *
 * Deliberately a plain module with no imports. The server writes these keys and
 * three client components read them, so the one thing this must not do is drag
 * `server-only`, Prisma or React into either half.
 */

/** The first-run walkthrough on /dashboard. */
export const TOUR_KEY = "tour";

/** The setup checklist card, hidden by hand before every step is done. */
export const CHECKLIST_KEY = "checklist";

/**
 * Prefix for the once-per-screen hints. Namespaced rather than bare so that
 * `resetHelpHints` can clear every hint without touching the tour or the
 * checklist — an operator who wants the screen tips back has not necessarily
 * asked to sit through the tour again.
 */
export const HELP_PREFIX = "help:";

/** The stored key for one screen hint, from its topic id. */
export function helpKey(topicId: string): string {
  return `${HELP_PREFIX}${topicId}`;
}

export function isHelpKey(key: string): boolean {
  return key.startsWith(HELP_PREFIX);
}

/**
 * Adding is idempotent, and that is load-bearing rather than tidy.
 *
 * Dismissing is fire-and-forget from the browser: the hint disappears on the
 * click and the write follows it. A double click, a retry after a flaky
 * response, or two tabs closing the same hint therefore all reach the server,
 * and none of them may turn the set into `["help:videos", "help:videos"]` —
 * which would still *read* correctly but would grow without bound.
 */
export function withDismissed(seen: readonly string[], key: string): string[] {
  return seen.includes(key) ? [...seen] : [...seen, key];
}

/** Removing keys is how every replay path is implemented — see `resetOnboarding`. */
export function withRestored(
  seen: readonly string[],
  keys: readonly string[],
): string[] {
  const removing = new Set(keys);
  return seen.filter((key) => !removing.has(key));
}

/** Everything the operator has put away, cleared: "show me all of it again". */
export function withEverythingRestored(): string[] {
  return [];
}

/**
 * Only the screen hints, cleared.
 *
 * The tour and the checklist survive on purpose. They are the two surfaces that
 * interrupt rather than sit quietly at the top of a page, so "show the screen
 * tips again" must not smuggle a modal walkthrough back in with them.
 */
export function withHelpHintsRestored(seen: readonly string[]): string[] {
  return seen.filter((key) => !isHelpKey(key));
}
