import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * Merging duplicate projects into one.
 *
 * Its own file rather than more of `project.service.test.ts` because the
 * subject is different: that file is about one project's own fields, this one
 * is about what happens to everything *filed under* a project when the project
 * stops existing. The properties worth holding onto are all of that second
 * kind — every child kind is reassigned, a refusal moves nothing at all, and a
 * failure at any point leaves the database exactly as it was.
 *
 * Runs against the same real, shared Postgres every other service test does
 * (src/test/setup.ts), so every test gets a throwaway `User` and never touches
 * the operator's real rows.
 */
const RUN = randomUUID().slice(0, 8);

// A merge test builds a channel, three or four projects and a handful of
// children before it asserts anything, which is a few dozen sequential round
// trips to a remote database.
vi.setConfig({ testTimeout: 40_000 });

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("project-merge");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
});

async function createChannel(title: string) {
  return channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title,
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
}

async function createProject(name: string, channelId?: string) {
  return projectService.create(userId, { name: `${name}-${RUN}`, channelId });
}

async function createVideo(
  projectId: string,
  over: Partial<{
    title: string;
    status: "DRAFT" | "GENERATING" | "RENDERING" | "PUBLISHED";
    leaseExpiresAt: Date;
    deletedAt: Date;
  }> = {},
) {
  return prisma.video.create({
    data: {
      userId,
      projectId,
      title: over.title ?? `video-${randomUUID().slice(0, 8)}`,
      status: over.status ?? "DRAFT",
      leaseExpiresAt: over.leaseExpiresAt ?? null,
      deletedAt: over.deletedAt ?? null,
    },
    select: { id: true },
  });
}

async function createSchedule(projectId: string, name = "Weekly") {
  return prisma.schedule.create({
    data: {
      userId,
      projectId,
      name: `${name}-${RUN}`,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timeZone: "Europe/London",
      nextRunAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
}

/**
 * A series, written directly rather than through `SeriesService.create`.
 *
 * Deliberate: `create` would build a schedule, a script style and a set of
 * reconciled answers, none of which this file is about, and it would refuse
 * some of the shapes that need testing here. What matters is that the row
 * exists with a `projectId` and a `channelId`, which is what a merge has to
 * keep in agreement.
 */
async function createSeries(projectId: string, channelId: string, name = "Show") {
  const template = await prisma.promptTemplate.create({
    data: {
      userId,
      name: `style-${randomUUID().slice(0, 8)}`,
      category: "SCRIPT",
      content: "Write about {{topic}}.",
    },
    select: { id: true },
  });

  return prisma.series.create({
    data: {
      userId,
      projectId,
      channelId,
      name: `${name}-${RUN}`,
      promptTemplateId: template.id,
    },
    select: { id: true },
  });
}

describe("projectService.merge", () => {
  it("reassigns every kind of child, then soft-deletes the sources", async () => {
    // The whole contract in one test. Video, Schedule and Series are the
    // complete set of tables carrying a `projectId`; if a fourth is ever
    // added, this is the test that should start looking incomplete.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const sourceA = await createProject("copy-a", channel.id);
    const sourceB = await createProject("copy-b", channel.id);

    const video = await createVideo(sourceA.id);
    const schedule = await createSchedule(sourceA.id);
    const series = await createSeries(sourceB.id, channel.id);

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [sourceA.id, sourceB.id],
    });

    expect(result).toMatchObject({
      mergedProjectCount: 2,
      videoCount: 1,
      scheduleCount: 1,
      seriesCount: 1,
    });

    const [movedVideo, movedSchedule, movedSeries] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
      prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } }),
      prisma.series.findUniqueOrThrow({ where: { id: series.id } }),
    ]);

    expect(movedVideo.projectId).toBe(target.id);
    expect(movedSchedule.projectId).toBe(target.id);
    expect(movedSeries.projectId).toBe(target.id);

    const sources = await prisma.project.findMany({
      where: { id: { in: [sourceA.id, sourceB.id] } },
      select: { id: true, deletedAt: true },
    });
    expect(sources.every((project) => project.deletedAt !== null)).toBe(true);

    // The target itself is untouched apart from gaining children.
    const kept = await prisma.project.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.deletedAt).toBeNull();
    expect(kept.channelId).toBe(channel.id);
  });

  it("leaves no schedule or series pointing at a deleted project", async () => {
    // The failure mode this feature is most able to cause. `ProjectService.remove`
    // cascades to videos only, so a "merge" built as move-the-videos-then-delete
    // would leave a live schedule due, claimable by the worker, and filing its
    // videos into a project the operator can no longer see.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);

    await createSchedule(source.id);
    await createSeries(source.id, channel.id);

    await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    const [strandedSchedules, strandedSeries] = await Promise.all([
      prisma.schedule.count({
        where: { userId, project: { deletedAt: { not: null } } },
      }),
      prisma.series.count({
        where: { userId, project: { deletedAt: { not: null } } },
      }),
    ]);

    expect(strandedSchedules).toBe(0);
    expect(strandedSeries).toBe(0);
  });

  it("moves soft-deleted children too", async () => {
    // They are invisible either way, but a deleted video whose project is also
    // deleted is a row nobody can ever resolve back to anything.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);

    const live = await createVideo(source.id);
    const gone = await createVideo(source.id, { deletedAt: new Date() });

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    // Counted as one, because one is what the operator can see.
    expect(result.videoCount).toBe(1);

    for (const id of [live.id, gone.id]) {
      const video = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(video.projectId).toBe(target.id);
    }
  });

  it("ignores the target when it is listed among the sources", async () => {
    // "Merge these three rows" is how an operator thinks about it when the
    // survivor is one of the three. Dropped, not refused.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    const video = await createVideo(source.id);

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [target.id, source.id, source.id],
    });

    expect(result.mergedProjectCount).toBe(1);
    expect(result.videoCount).toBe(1);

    const kept = await prisma.project.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.deletedAt).toBeNull();
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
    ).resolves.toMatchObject({ projectId: target.id });
  });

  it("refuses a merge whose only source is the target itself", async () => {
    const target = await createProject("only");

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [target.id] }),
    ).rejects.toThrow(ConflictError);

    const kept = await prisma.project.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.deletedAt).toBeNull();
  });

  it("refuses to merge projects that publish to different channels", async () => {
    // The rule the whole operation is shaped around. `Project.channelId` is
    // what `PublishService.resolvePublishTarget` reads, so moving these videos
    // would redirect every one of them — and an upload cannot be taken back.
    const finance = await createChannel("Money Mechanics TV");
    const kids = await createChannel("KIDO FUN ZONE");
    const target = await createProject("finance", finance.id);
    const source = await createProject("kids", kids.id);
    const video = await createVideo(source.id);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(/KIDO FUN ZONE.*Money Mechanics TV/);

    // Nothing moved, and the source is still there.
    const untouched = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(untouched.projectId).toBe(source.id);
    const stillThere = await prisma.project.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(stillThere.deletedAt).toBeNull();
  });

  it("refuses to merge a project with a channel into one without", async () => {
    // The other direction, and refused for a different reason: it would not
    // redirect these videos, it would quietly take away their ability to
    // publish at all.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("no-channel");
    const source = await createProject("has-channel", channel.id);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(/no channel/);
  });

  it("merges into a project with no channel when no source has one either", async () => {
    // Legal, and the common shape of a duplicate created before any channel
    // was connected. Nothing about where anything publishes changes: it was
    // nowhere and it stays nowhere.
    const target = await createProject("scratch");
    const source = await createProject("scratch-copy");
    const video = await createVideo(source.id);

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    expect(result.videoCount).toBe(1);
    const moved = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(moved.projectId).toBe(target.id);

    const kept = await prisma.project.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.channelId).toBeNull();
  });

  it("allows a channel-less source into a target with a channel", async () => {
    // The staging case: three copies of one project, only one of which has a
    // channel. The videos in the other two cannot publish anywhere today, so
    // this is a gain rather than a redirection — but it is still stated in the
    // dialog (see `describeChannelGain`).
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("with-channel", channel.id);
    const source = await createProject("without-channel");
    const video = await createVideo(source.id);

    await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    const moved = await prisma.video.findUniqueOrThrow({
      where: { id: video.id },
      select: { project: { select: { channelId: true } } },
    });
    expect(moved.project.channelId).toBe(channel.id);
  });

  it("never leaves a series whose channel disagrees with its project's", async () => {
    // The invariant `SeriesService.assertRecipe` establishes and
    // `PublishService` refuses to publish through. A merge must not be the way
    // it gets broken — including through a legacy row whose project's channel
    // no longer matches its own, which is why this is checked on the series
    // rather than inferred from its project.
    const finance = await createChannel("Money Mechanics TV");
    const kids = await createChannel("KIDO FUN ZONE");
    const target = await createProject("finance", finance.id);
    const source = await createProject("also-finance", finance.id);

    // A series that says "kids" while its project says "finance" — the exact
    // legacy shape.
    const series = await createSeries(source.id, kids.id);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(ConflictError);

    const untouched = await prisma.series.findUniqueOrThrow({
      where: { id: series.id },
    });
    expect(untouched.projectId).toBe(source.id);
    expect(untouched.channelId).toBe(kids.id);
  });

  it("keeps every merged series in agreement with the target's channel", async () => {
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    await createSeries(source.id, channel.id);

    await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    const disagreeing = await prisma.series.count({
      where: {
        userId,
        deletedAt: null,
        NOT: { channelId: channel.id },
      },
    });
    expect(disagreeing).toBe(0);
  });

  it("refuses while the render worker is holding one of the videos", async () => {
    // Same guard, and the same reasoning, as `ProjectService.remove`: the
    // render resolves its look and voice through `video -> project -> channel`,
    // so reparenting a video mid-render is a question nobody should have to
    // answer.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    await createVideo(source.id, {
      status: "RENDERING",
      leaseExpiresAt: new Date(Date.now() + 600_000),
    });

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(/render worker/);
  });

  it("refuses an archived target", async () => {
    // A series moved into an archived project could no longer be edited —
    // `SeriesService.assertRecipe` requires an ACTIVE project — and nothing
    // new could be filed there.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    await projectService.archive(userId, target.id);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(/archived/);
  });

  it("merges archived sources happily", async () => {
    // The other direction is fine, and likely: archiving a duplicate is what
    // an operator does before they discover merging exists.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    await createVideo(source.id);
    await projectService.archive(userId, source.id);

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    expect(result.videoCount).toBe(1);
  });

  it("will not touch another operator's project", async () => {
    // The `userId` in every `where` is the only thing scoping this operation.
    const stranger = await createTestUser("project-merge-stranger");
    try {
      const target = await createProject("mine");
      const theirs = await prisma.project.create({
        data: { userId: stranger, name: `theirs-${RUN}` },
        select: { id: true },
      });

      await expect(
        projectService.merge(userId, { targetId: target.id, sourceIds: [theirs.id] }),
      ).rejects.toThrow(NotFoundError);

      const untouched = await prisma.project.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(untouched.deletedAt).toBeNull();
    } finally {
      await deleteTestUser(stranger);
    }
  });

  it("renames the surviving project in the same call", async () => {
    // The answer to "what should the target be called when sixteen
    // `job-<uuid>` projects merge into one". The survivor is chosen for its
    // channel, so it can easily be one of the machine-named rows; the rename
    // rides along rather than being a second step somebody forgets.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("job-4f2c", channel.id);
    const source = await createProject("copy", channel.id);

    const result = await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
      name: "Money Mechanics",
    });

    expect(result.name).toBe("Money Mechanics");
    const kept = await prisma.project.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.name).toBe("Money Mechanics");
  });

  it("records the names it dissolved", async () => {
    // The merged-away names are not kept as a field anywhere — nothing would
    // read one — but they are not dropped silently either. This row is where
    // "what happened to the other Money Mechanics?" is answerable, and it is
    // written inside the merge's own transaction.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);

    await projectService.merge(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { userId, action: "project.merge" },
    });
    expect(log.entityId).toBe(target.id);
    expect(log.message).toContain(`copy-${RUN}`);
  });

  it("rolls the whole merge back when anything in it fails", async () => {
    // One transaction is the point: a half-merged pair — videos moved, sources
    // still live, or sources deleted with their schedules left behind — is not
    // a state any other part of this app knows how to read.
    //
    // The failure is injected at the last write in the transaction (the record
    // of what was dissolved) precisely because everything else has already
    // succeeded by then, so a missing rollback would be visible in every
    // table.
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    const video = await createVideo(source.id);
    const schedule = await createSchedule(source.id);

    const runTransaction = prisma.$transaction.bind(prisma);

    vi.spyOn(prisma, "$transaction").mockImplementation(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      runTransaction((tx) =>
        callback(
          new Proxy(tx, {
            get(inner, property) {
              if (property === "activityLog") {
                return {
                  create: () => {
                    throw new Error("injected failure");
                  },
                };
              }
              return Reflect.get(inner, property);
            },
          }),
        ),
      )) as typeof prisma.$transaction);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow("injected failure");

    vi.restoreAllMocks();

    const [stillFiled, stillScheduled, stillLive] = await Promise.all([
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
      prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id } }),
      prisma.project.findUniqueOrThrow({ where: { id: source.id } }),
    ]);

    expect(stillFiled.projectId).toBe(source.id);
    expect(stillScheduled.projectId).toBe(source.id);
    expect(stillLive.deletedAt).toBeNull();

    const logs = await prisma.activityLog.count({
      where: { userId, action: "project.merge" },
    });
    expect(logs).toBe(0);
  });
});

describe("projectService.mergeImpact", () => {
  it("counts every child kind, not just videos", async () => {
    const channel = await createChannel("Money Mechanics TV");
    const target = await createProject("keep", channel.id);
    const source = await createProject("copy", channel.id);
    await createVideo(source.id);
    await createVideo(source.id);
    await createSchedule(source.id);
    await createSeries(source.id, channel.id);

    const impact = await projectService.mergeImpact(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    expect(impact).toMatchObject({
      videoCount: 2,
      scheduleCount: 1,
      seriesCount: 1,
      blockers: [],
    });
    expect(impact.target.channelTitle).toBe("Money Mechanics TV");
    expect(impact.sources).toHaveLength(1);
  });

  it("reports the same refusal the merge would throw, before it is attempted", async () => {
    // A pre-check that can disagree with the check that actually holds is a
    // pre-check that will eventually lie, so both run the same code.
    const finance = await createChannel("Money Mechanics TV");
    const kids = await createChannel("KIDO FUN ZONE");
    const target = await createProject("finance", finance.id);
    const source = await createProject("kids", kids.id);

    const impact = await projectService.mergeImpact(userId, {
      targetId: target.id,
      sourceIds: [source.id],
    });

    expect(impact.blockers).toHaveLength(1);

    await expect(
      projectService.merge(userId, { targetId: target.id, sourceIds: [source.id] }),
    ).rejects.toThrow(impact.blockers[0]);
  });
});

describe("projectService.mergeSuggestions", () => {
  it("finds same-named copies and nominates the one with a channel", async () => {
    // Staging, reproduced: three "Money Mechanics", one of which has a
    // channel. The channel is what decides the survivor, because merging the
    // other way round is refused.
    const channel = await createChannel("Money Mechanics TV");
    const withChannel = await projectService.create(userId, {
      name: `Money Mechanics ${RUN}`,
      channelId: channel.id,
    });
    const first = await projectService.create(userId, {
      name: `Money Mechanics ${RUN}`,
    });
    const second = await projectService.create(userId, {
      name: `money mechanics ${RUN}`,
    });

    const suggestions = await projectService.mergeSuggestions(userId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.kind).toBe("duplicate-name");
    expect(suggestions[0]!.targetId).toBe(withChannel.id);
    expect(suggestions[0]!.sourceIds.slice().sort()).toEqual(
      [first.id, second.id].slice().sort(),
    );
  });

  it("groups job-<uuid> projects even though no two share a name", async () => {
    // The production case. Sixteen of these, a video apiece, no duplicate
    // names at all — which is why a suggestion that only matched names would
    // solve half the problem.
    const channel = await createChannel("Money Mechanics TV");
    await projectService.create(userId, {
      name: `job-${randomUUID()}`,
      channelId: channel.id,
    });
    await projectService.create(userId, {
      name: `job-${randomUUID()}`,
      channelId: channel.id,
    });

    const suggestions = await projectService.mergeSuggestions(userId);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.kind).toBe("generated-name");
    expect(suggestions[0]!.sourceIds).toHaveLength(1);
  });

  it("suggests a merge this service would actually accept", async () => {
    // The property that matters about a suggestion: following it works. A
    // suggestion the service then refuses reads as a broken feature.
    const channel = await createChannel("Money Mechanics TV");
    await projectService.create(userId, {
      name: `job-${randomUUID()}`,
      channelId: channel.id,
    });
    await projectService.create(userId, {
      name: `job-${randomUUID()}`,
      channelId: channel.id,
    });

    const [suggestion] = await projectService.mergeSuggestions(userId);

    const impact = await projectService.mergeImpact(userId, {
      targetId: suggestion!.targetId,
      sourceIds: suggestion!.sourceIds,
    });
    expect(impact.blockers).toEqual([]);

    await expect(
      projectService.merge(userId, {
        targetId: suggestion!.targetId,
        sourceIds: suggestion!.sourceIds,
        name: suggestion!.name,
      }),
    ).resolves.toMatchObject({ mergedProjectCount: 1 });
  });

  it("offers nothing when every project is genuinely distinct", async () => {
    await createProject("Money Mechanics");
    await createProject("KIDO FUN ZONE");

    await expect(projectService.mergeSuggestions(userId)).resolves.toEqual([]);
  });
});
