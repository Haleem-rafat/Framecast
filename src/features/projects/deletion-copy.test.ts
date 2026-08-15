import { describe, expect, it } from "vitest";

import {
  describeDeletion,
  describeRefusal,
  type DeletionImpact,
} from "@/features/projects/deletion-copy";

/**
 * What an operator is told before they delete a project they cannot get back.
 *
 * Tested here rather than through the rendered dialog because the repo's
 * Vitest environment is `node` — the same reason `DataTable`'s pure helpers
 * are tested apart from the table. `projectService.deletionImpact` is held to
 * producing the right numbers in `project.service.test.ts`, and
 * `projectService.remove` to deleting exactly `videoCount` videos; this is the
 * other half, that the numbers reach the screen intact and mean what they say.
 */
function impact(over: Partial<DeletionImpact> = {}): DeletionImpact {
  return { videoCount: 0, publishedCount: 0, activeRenderCount: 0, ...over };
}

describe("describeDeletion", () => {
  it("states the video count, which is the part 'delete project' hides", () => {
    expect(describeDeletion(impact({ videoCount: 12 }))).toBe(
      "This permanently removes the project and its 12 videos — their scripts " +
        "and renders included — from Framecast. It cannot be undone.",
    );
  });

  it("does not say '1 videos'", () => {
    expect(describeDeletion(impact({ videoCount: 1 }))).toContain("its 1 video —");
  });

  it("says an empty project is empty rather than claiming '0 videos'", () => {
    expect(describeDeletion(impact())).toBe(
      "This permanently removes the project, which has no videos, from " +
        "Framecast. It cannot be undone.",
    );
  });

  it("always says it cannot be undone", () => {
    for (const count of [0, 1, 40]) {
      expect(describeDeletion(impact({ videoCount: count }))).toContain(
        "It cannot be undone.",
      );
    }
  });

  it("warns that published videos stay on YouTube", () => {
    // The assumption most likely to be wrong and most expensive to discover
    // afterwards: Framecast deleting its own record unpublishes nothing.
    const text = describeDeletion(impact({ videoCount: 5, publishedCount: 3 }));

    expect(text).toContain("3 of those videos are published on YouTube");
    expect(text).toContain("will stay there");
    expect(text).toContain("deleting the record here takes nothing down");
    expect(text).toContain("separate step in YouTube Studio");
  });

  it("keeps the YouTube warning grammatical for a single published video", () => {
    const text = describeDeletion(impact({ videoCount: 2, publishedCount: 1 }));

    expect(text).toContain("1 of those videos is published");
    expect(text).toContain("Removing it from YouTube");
  });

  it("stays silent about YouTube when nothing is published", () => {
    expect(describeDeletion(impact({ videoCount: 9 }))).not.toContain("YouTube");
  });
});

describe("describeRefusal", () => {
  it("says nothing when nothing is blocking", () => {
    // `null` is also what arms the confirm button, so a spurious message here
    // would be an operator unable to delete a project with no reason given.
    expect(describeRefusal(impact({ videoCount: 4, publishedCount: 4 }))).toBeNull();
  });

  it("explains the refusal before the click, not after it", () => {
    const text = describeRefusal(impact({ videoCount: 4, activeRenderCount: 2 }));

    expect(text).toBe(
      "2 videos in this project are being rendered right now, so this delete " +
        "will be refused. Cancel the renders on the Videos page first.",
    );
  });

  it("does not say '1 videos are'", () => {
    expect(describeRefusal(impact({ activeRenderCount: 1 }))).toBe(
      "1 video in this project is being rendered right now, so this delete " +
        "will be refused. Cancel the render on the Videos page first.",
    );
  });
});
