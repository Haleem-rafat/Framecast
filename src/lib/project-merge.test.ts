import { describe, expect, it } from "vitest";

import {
  chooseMergeTarget,
  isGeneratedProjectName,
  type MergeCandidate,
  normalizeProjectName,
  suggestedTargetName,
  suggestMerges,
} from "@/lib/project-merge";

/**
 * The judgement half of the merge feature: which rows are "the same project",
 * which one survives, and what it ends up called.
 *
 * Worth its own file because these are guesses an operator confirms without
 * reading closely, and because the ranking in `chooseMergeTarget` is load
 * bearing in a way that is not obvious from reading it — get the order of its
 * first two tests wrong and it starts nominating targets that
 * `ProjectService.merge` then refuses, which reads as a broken feature rather
 * than a bad suggestion.
 */

const EPOCH = new Date("2026-01-01T00:00:00Z");

function candidate(over: Partial<MergeCandidate> & { id: string }): MergeCandidate {
  return {
    name: over.id,
    channelId: null,
    status: "ACTIVE",
    videoCount: 0,
    createdAt: EPOCH,
    ...over,
  };
}

describe("isGeneratedProjectName", () => {
  it("recognises the name the one-click flow gives a project", () => {
    expect(isGeneratedProjectName("job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b")).toBe(
      true,
    );
    // Casing and stray whitespace are the app's own, not a person's.
    expect(isGeneratedProjectName(" JOB-3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B ")).toBe(
      true,
    );
  });

  it("leaves a real project that happens to start with 'job' alone", () => {
    // The reason the UUID shape is matched rather than the prefix. A careers
    // channel is a perfectly ordinary thing to have, and sweeping it into a
    // "this is clutter" list offers to dissolve somebody's actual work.
    expect(isGeneratedProjectName("job-hunting tips")).toBe(false);
    expect(isGeneratedProjectName("Jobs")).toBe(false);
    expect(isGeneratedProjectName("job-123")).toBe(false);
  });
});

describe("normalizeProjectName", () => {
  it("matches on case and spacing only", () => {
    expect(normalizeProjectName("  Money   Mechanics ")).toBe("money mechanics");
    expect(normalizeProjectName("MONEY MECHANICS")).toBe(
      normalizeProjectName("Money Mechanics"),
    );
  });

  it("does not treat a numbered name as a copy of an unnumbered one", () => {
    // Deliberate: "Season 2" is a name, not a duplicate of "Season".
    expect(normalizeProjectName("Season 2")).not.toBe(normalizeProjectName("Season"));
  });
});

describe("chooseMergeTarget", () => {
  it("never nominates an archived project", () => {
    // `ProjectService.merge` refuses an archived target outright — a series
    // moved into one could no longer be edited.
    const target = chooseMergeTarget([
      candidate({ id: "a", status: "ARCHIVED", channelId: "channel-1" }),
      candidate({ id: "b", status: "ACTIVE" }),
    ]);

    expect(target?.id).toBe("b");
  });

  it("returns null when every candidate is archived", () => {
    expect(
      chooseMergeTarget([
        candidate({ id: "a", status: "ARCHIVED" }),
        candidate({ id: "b", status: "ARCHIVED" }),
      ]),
    ).toBeNull();
  });

  it("prefers the project that has a channel over the one with a real name", () => {
    // The ordering that makes suggestions legal rather than merely sensible.
    // Merging a project that publishes to a channel into one that publishes
    // nowhere is refused, so a target picked on its name would produce a
    // suggestion the service rejects.
    const target = chooseMergeTarget([
      candidate({ id: "named", name: "Money Mechanics", channelId: null }),
      candidate({
        id: "channelled",
        name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        channelId: "channel-1",
      }),
    ]);

    expect(target?.id).toBe("channelled");
  });

  it("prefers a human name once the channel question is settled", () => {
    const target = chooseMergeTarget([
      candidate({
        id: "generated",
        name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        channelId: "channel-1",
        videoCount: 9,
      }),
      candidate({
        id: "named",
        name: "Money Mechanics",
        channelId: "channel-1",
        videoCount: 1,
      }),
    ]);

    expect(target?.id).toBe("named");
  });

  it("falls back to the biggest, then the oldest", () => {
    const bigger = chooseMergeTarget([
      candidate({ id: "small", name: "Same", videoCount: 1 }),
      candidate({ id: "big", name: "Same", videoCount: 7 }),
    ]);
    expect(bigger?.id).toBe("big");

    const older = chooseMergeTarget([
      candidate({ id: "new", name: "Same", createdAt: new Date("2026-06-01") }),
      candidate({ id: "old", name: "Same", createdAt: new Date("2026-01-01") }),
    ]);
    expect(older?.id).toBe("old");
  });

  it("is stable — the same group always nominates the same row", () => {
    const members = [
      candidate({ id: "b-id", name: "Same" }),
      candidate({ id: "a-id", name: "Same" }),
    ];

    expect(chooseMergeTarget(members)?.id).toBe("a-id");
    expect(chooseMergeTarget([...members].reverse())?.id).toBe("a-id");
  });
});

describe("suggestedTargetName", () => {
  it("carries a human name onto a target chosen for its channel", () => {
    // The whole point: the survivor is picked on where it publishes, which can
    // easily be a `job-<uuid>` row, and a machine name must not win a merge
    // with something a person named.
    const target = candidate({
      id: "generated",
      name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      channelId: "channel-1",
    });
    const members = [target, candidate({ id: "named", name: "Money Mechanics" })];

    expect(suggestedTargetName(target, members)).toBe("Money Mechanics");
  });

  it("keeps the target's own name when a person wrote it", () => {
    const target = candidate({ id: "a", name: "Money Mechanics" });

    expect(
      suggestedTargetName(target, [
        target,
        candidate({ id: "b", name: "Something Else" }),
      ]),
    ).toBe("Money Mechanics");
  });

  it("keeps the generated name when there is nothing better in the group", () => {
    // No lie invented, and the dialog's name field is pre-filled with this for
    // the operator to replace.
    const target = candidate({
      id: "a",
      name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    });
    const members = [
      target,
      candidate({ id: "b", name: "job-9e8d7c6b-5a4f-4321-8765-0f1e2d3c4b5a" }),
    ];

    expect(suggestedTargetName(target, members)).toBe(target.name);
  });
});

describe("suggestMerges", () => {
  it("groups the staging case: three copies, only one with a channel", () => {
    // Measured on staging. The one with the channel must survive, and the two
    // without must ride along rather than being split off — their videos
    // cannot publish at all today.
    const suggestions = suggestMerges([
      candidate({ id: "a", name: "Money Mechanics", channelId: null, videoCount: 2 }),
      candidate({
        id: "b",
        name: "Money Mechanics",
        channelId: "channel-1",
        videoCount: 5,
      }),
      candidate({ id: "c", name: "money mechanics ", channelId: null, videoCount: 1 }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      kind: "duplicate-name",
      targetId: "b",
      name: "Money Mechanics",
      videoCount: 8,
    });
    expect(suggestions[0]!.sourceIds.slice().sort()).toEqual(["a", "c"]);
  });

  it("groups every job-<uuid> project together despite no two sharing a name", () => {
    // The production case, and the reason a name-only matcher solves half the
    // problem: sixteen machine-named projects, a video apiece, no duplicates
    // by name at all.
    const suggestions = suggestMerges([
      candidate({
        id: "j1",
        name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        channelId: "channel-1",
        videoCount: 1,
      }),
      candidate({
        id: "j2",
        name: "job-9e8d7c6b-5a4f-4321-8765-0f1e2d3c4b5a",
        channelId: "channel-1",
        videoCount: 1,
      }),
      candidate({
        id: "j3",
        name: "job-11112222-3333-4444-5555-666677778888",
        channelId: "channel-1",
        videoCount: 1,
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.kind).toBe("generated-name");
    expect(suggestions[0]!.sourceIds).toHaveLength(2);
    expect(suggestions[0]!.videoCount).toBe(3);
  });

  it("splits a group that spans two channels, and drops the channel-less rows", () => {
    // A suggestion spanning two channels is one `ProjectService.merge` would
    // refuse, so it is never offered. The channel-less row is left out because
    // there is no honest way to guess which side it belongs to.
    const suggestions = suggestMerges([
      candidate({ id: "a1", name: "Shorts", channelId: "channel-1" }),
      candidate({ id: "a2", name: "Shorts", channelId: "channel-1" }),
      candidate({ id: "b1", name: "Shorts", channelId: "channel-2" }),
      candidate({ id: "b2", name: "Shorts", channelId: "channel-2" }),
      candidate({ id: "orphan", name: "Shorts", channelId: null }),
    ]);

    expect(suggestions).toHaveLength(2);
    for (const suggestion of suggestions) {
      expect([suggestion.targetId, ...suggestion.sourceIds]).not.toContain("orphan");
      expect(suggestion.sourceIds).toHaveLength(1);
    }
  });

  it("offers nothing for a project that is merely unique", () => {
    expect(
      suggestMerges([
        candidate({ id: "a", name: "Money Mechanics" }),
        candidate({ id: "b", name: "KIDO FUN ZONE" }),
      ]),
    ).toEqual([]);
  });

  it("offers nothing when the whole duplicate group is archived", () => {
    // There is no legal survivor, and a suggestion the service would refuse is
    // worse than no suggestion.
    expect(
      suggestMerges([
        candidate({ id: "a", name: "Money Mechanics", status: "ARCHIVED" }),
        candidate({ id: "b", name: "Money Mechanics", status: "ARCHIVED" }),
      ]),
    ).toEqual([]);
  });

  it("never puts a project in a suggestion twice, or in two suggestions", () => {
    const suggestions = suggestMerges([
      candidate({ id: "a1", name: "Shorts", channelId: "channel-1" }),
      candidate({ id: "a2", name: "Shorts", channelId: "channel-1" }),
      candidate({
        id: "j1",
        name: "job-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
        channelId: "channel-1",
      }),
      candidate({
        id: "j2",
        name: "job-9e8d7c6b-5a4f-4321-8765-0f1e2d3c4b5a",
        channelId: "channel-1",
      }),
    ]);

    const seen = suggestions.flatMap((one) => [one.targetId, ...one.sourceIds]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice().sort()).toEqual(["a1", "a2", "j1", "j2"]);
  });
});
