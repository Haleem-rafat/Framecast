import { describe, expect, it } from "vitest";

import {
  CHECKLIST_KEY,
  HELP_PREFIX,
  TOUR_KEY,
  helpKey,
  isHelpKey,
  withDismissed,
  withEverythingRestored,
  withHelpHintsRestored,
  withRestored,
} from "@/features/onboarding/dismissal";

/**
 * The whole of "don't show me that again" is these six functions, and the two
 * properties worth protecting are the ones an operator would actually notice:
 * a dismissed thing stays dismissed, and asking for it back gets it back.
 *
 * Pure functions rather than a rendered component on purpose — the repo's
 * Vitest environment is `node`, so there is no DOM to click a dismiss button
 * in, and in any case the decision is here and the button is plumbing.
 */
describe("onboarding dismissal keys", () => {
  it("namespaces screen hints so they can be cleared without the tour", () => {
    expect(helpKey("channels")).toBe(`${HELP_PREFIX}channels`);
    expect(isHelpKey(helpKey("channels"))).toBe(true);
    expect(isHelpKey(TOUR_KEY)).toBe(false);
    expect(isHelpKey(CHECKLIST_KEY)).toBe(false);
  });
});

describe("withDismissed", () => {
  it("records a key that was not there", () => {
    expect(withDismissed([], TOUR_KEY)).toEqual([TOUR_KEY]);
  });

  it("does not re-appear once dismissed", () => {
    const after = withDismissed([], TOUR_KEY);

    expect(after.includes(TOUR_KEY)).toBe(true);
    // The read every surface performs: `isDismissed(key)`.
    expect(withDismissed(after, CHECKLIST_KEY).includes(TOUR_KEY)).toBe(true);
  });

  it("is idempotent, so a double click cannot grow the set", () => {
    const once = withDismissed([], TOUR_KEY);
    const twice = withDismissed(once, TOUR_KEY);

    expect(twice).toEqual([TOUR_KEY]);
  });

  it("never mutates the array it was given", () => {
    const original = [TOUR_KEY];
    withDismissed(original, CHECKLIST_KEY);

    expect(original).toEqual([TOUR_KEY]);
  });
});

describe("restoring", () => {
  const seen = [TOUR_KEY, CHECKLIST_KEY, helpKey("channels"), helpKey("videos")];

  it("puts back exactly the keys named and nothing else", () => {
    expect(withRestored(seen, [helpKey("channels")])).toEqual([
      TOUR_KEY,
      CHECKLIST_KEY,
      helpKey("videos"),
    ]);
  });

  it("ignores a key that was never dismissed", () => {
    expect(withRestored([TOUR_KEY], [helpKey("admin")])).toEqual([TOUR_KEY]);
  });

  it("brings every screen note back without summoning the tour", () => {
    // The distinction the two reset buttons exist for: "show me the quiet
    // notes again" must not re-open a modal walkthrough.
    expect(withHelpHintsRestored(seen)).toEqual([TOUR_KEY, CHECKLIST_KEY]);
  });

  it("restores everything, tour and checklist included", () => {
    expect(withEverythingRestored()).toEqual([]);
  });
});
