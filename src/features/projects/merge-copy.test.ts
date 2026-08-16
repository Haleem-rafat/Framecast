import { describe, expect, it } from "vitest";

import {
  describeChannelGain,
  describeMerge,
  describeMergeRefusal,
  joinNames,
  type MergeImpactCopy,
} from "@/features/projects/merge-copy";

/**
 * The sentences the merge confirmation shows. Held to their contract for the
 * same reason `deletion-copy.test.ts` holds the delete confirmation's: they
 * are a promise about something irreversible, and the clause most likely to be
 * dropped in a future edit — that schedules and series move too — is the one
 * an operator has no other way of learning.
 */
function impact(over: Partial<MergeImpactCopy> = {}): MergeImpactCopy {
  return {
    target: { name: "Money Mechanics", channelTitle: "Money Mechanics TV" },
    sources: [
      {
        name: "Money Mechanics (old)",
        channelId: "channel-1",
        channelTitle: "Money Mechanics TV",
        videoCount: 3,
      },
    ],
    videoCount: 3,
    scheduleCount: 0,
    seriesCount: 0,
    blockers: [],
    ...over,
  };
}

describe("joinNames", () => {
  it("reads as a list a person would write", () => {
    expect(joinNames(["a"])).toBe("a");
    expect(joinNames(["a", "b"])).toBe("a and b");
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
    expect(joinNames([])).toBe("");
  });
});

describe("describeMerge", () => {
  it("names what is deleted and counts what moves", () => {
    const text = describeMerge(impact());

    expect(text).toContain('"Money Mechanics (old)"');
    expect(text).toContain("is deleted");
    expect(text).toContain("3 videos");
    expect(text).toContain('into "Money Mechanics"');
  });

  it("says schedules and series move, not just videos", () => {
    // The clause that matters most. "Merge two projects" reads as tidying a
    // folder; it also moves the thing that fires every Tuesday morning, and
    // nothing else in the app would tell the operator that.
    const text = describeMerge(impact({ scheduleCount: 2, seriesCount: 1 }));

    expect(text).toContain("2 schedules");
    expect(text).toContain("1 series");
  });

  it("does not mention children that do not exist", () => {
    const text = describeMerge(impact({ videoCount: 1, scheduleCount: 0 }));

    expect(text).toContain("1 video");
    expect(text).not.toContain("schedule");
    expect(text).not.toContain("series");
    // One thing moving takes a singular verb.
    expect(text).toContain("moves into");
  });

  it("says plainly that an empty project takes nothing with it", () => {
    const text = describeMerge(impact({ videoCount: 0 }));

    expect(text).toContain("Nothing is filed under it");
    expect(text).not.toContain("0 videos");
  });

  it("promises that nothing is unpublished", () => {
    // Framecast deleting its own record takes nothing down from YouTube, and
    // an operator reaching for "merge" over published videos may well believe
    // otherwise.
    expect(describeMerge(impact())).toContain("nothing is removed from YouTube");
  });

  it("pluralises across several sources", () => {
    const text = describeMerge(
      impact({
        sources: [
          { name: "A", channelId: null, channelTitle: null, videoCount: 1 },
          { name: "B", channelId: null, channelTitle: null, videoCount: 1 },
        ],
        videoCount: 2,
      }),
    );

    expect(text).toContain('"A" and "B" are deleted');
    expect(text).toContain("filed under them move into");
  });
});

describe("describeChannelGain", () => {
  it("says out loud that videos with no channel gain one", () => {
    // Not a refusal — those videos could not publish anywhere before — but it
    // is still a change to where something uploads, and this feature never
    // makes one of those quietly.
    const text = describeChannelGain(
      impact({
        sources: [
          { name: "Drafts", channelId: null, channelTitle: null, videoCount: 4 },
        ],
        videoCount: 4,
      }),
    );

    expect(text).toContain("4 videos");
    expect(text).toContain("cannot be published at all");
    expect(text).toContain("Money Mechanics TV");
  });

  it("says nothing when every source already publishes where the target does", () => {
    expect(describeChannelGain(impact())).toBeNull();
  });

  it("says nothing when the target has no channel either", () => {
    // There is no gain to report: the videos still publish nowhere.
    expect(
      describeChannelGain(
        impact({
          target: { name: "Scratch", channelTitle: null },
          sources: [
            { name: "Drafts", channelId: null, channelTitle: null, videoCount: 4 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("says nothing about an empty project", () => {
    expect(
      describeChannelGain(
        impact({
          sources: [
            { name: "Empty", channelId: null, channelTitle: null, videoCount: 0 },
          ],
          videoCount: 0,
        }),
      ),
    ).toBeNull();
  });
});

describe("describeMergeRefusal", () => {
  it("returns null when the merge would go through", () => {
    // "No message" and "safe to arm the button" are deliberately the same
    // answer — the dialog uses this to decide whether to enable Merge at all.
    expect(describeMergeRefusal(impact())).toBeNull();
  });

  it("passes the service's own refusals through unchanged", () => {
    // Not reworded here. These are the same strings `ProjectService.merge`
    // throws, so a pre-check can never drift into disagreeing with the check
    // that actually holds.
    const text = describeMergeRefusal(
      impact({ blockers: ["First reason.", "Second reason."] }),
    );

    expect(text).toBe("First reason. Second reason.");
  });
});
