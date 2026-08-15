import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * `ProjectService.update` shipped with no caller for long enough that the
 * owner hit the gap it left: a project created before a channel was connected
 * could never be given one. It has a caller now (the projects table's Edit
 * dialog), and archiving has a bulk caller as well — so both are worth holding
 * to their contract, and in particular to the `userId` in their `where`, which
 * is the only thing scoping either of them to the operator who asked.
 *
 * Tests run against a real, shared Postgres database (see src/test/setup.ts)
 * that also holds the operator's real data, so every test here gets its own
 * throwaway User — see src/test/fixtures.ts for what happened before that was
 * true.
 */
const RUN = randomUUID().slice(0, 8);

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("project");
});

afterEach(() => deleteTestUser(userId));

async function createChannel(ownerId: string, title: string) {
  return channelService.connect(ownerId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title,
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
}

describe("projectService.update", () => {
  it("assigns a default channel to a project that had none", async () => {
    // The exact gap the edit dialog exists to close.
    const project = await projectService.create(userId, {
      name: `no-channel-${RUN}`,
    });
    expect(project.channelId).toBeNull();

    const channel = await createChannel(userId, "Money Mechanics");
    await projectService.update(userId, project.id, {
      name: project.name,
      channelId: channel.id,
    });

    const updated = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(updated.channelId).toBe(channel.id);
  });

  it("clears the channel when the form submits none", async () => {
    // "None" in the picker sends `undefined`, and the service's `?? null` is
    // what turns that into an actual unassignment rather than a no-op.
    const channel = await createChannel(userId, "Money Mechanics");
    const project = await projectService.create(userId, {
      name: `has-channel-${RUN}`,
      channelId: channel.id,
    });

    await projectService.update(userId, project.id, { name: project.name });

    const updated = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(updated.channelId).toBeNull();
  });

  it("cannot edit a project another operator owns", async () => {
    const strangerId = await createTestUser("project-stranger");
    try {
      const theirs = await projectService.create(strangerId, {
        name: `stranger-${RUN}`,
      });

      await expect(
        projectService.update(userId, theirs.id, { name: "Renamed by a stranger" }),
      ).rejects.toThrow(NotFoundError);

      const row = await prisma.project.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.name).toBe(`stranger-${RUN}`);
    } finally {
      await deleteTestUser(strangerId);
    }
  });
});

describe("projectService.archive", () => {
  /**
   * The projects table's bulk Archive is a loop of `archiveProjectAction`, so
   * every id it posts arrives here individually. A checked row the operator
   * does not own has to bounce off this `where` — nothing above it re-checks.
   */
  it("cannot archive a project another operator owns", async () => {
    const strangerId = await createTestUser("archive-stranger");
    try {
      const theirs = await projectService.create(strangerId, {
        name: `stranger-archive-${RUN}`,
      });

      await expect(projectService.archive(userId, theirs.id)).rejects.toThrow(
        NotFoundError,
      );

      const row = await prisma.project.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.status).toBe("ACTIVE");
      expect(row.archivedAt).toBeNull();
    } finally {
      await deleteTestUser(strangerId);
    }
  });

  it("leaves the project's videos alone", async () => {
    // The distinction the bulk confirmation states out loud, and the reason
    // bulk stops at archiving rather than offering the cascading delete.
    const project = await projectService.create(userId, {
      name: `archive-keeps-videos-${RUN}`,
    });
    const video = await prisma.video.create({
      data: {
        userId,
        projectId: project.id,
        title: "Still here",
        topic: "archiving",
      },
    });

    await projectService.archive(userId, project.id);

    const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.deletedAt).toBeNull();
  });
});

/**
 * Restoring existed nowhere until the projects table grew a Restore button:
 * `archive` set ARCHIVED and nothing in the tree ever set a project back, so
 * one click retired a project for good and the confirmation that offered it
 * said nothing about that. These hold the way back to the same contract its
 * counterpart above has — in particular the `userId` in the `where`, which is
 * the only thing stopping one operator un-retiring another's project.
 */
describe("projectService.unarchive", () => {
  it("restores an archived project to ACTIVE and clears archivedAt", async () => {
    const project = await projectService.create(userId, {
      name: `restore-${RUN}`,
    });
    await projectService.archive(userId, project.id);

    const archived = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();

    await projectService.unarchive(userId, project.id);

    const restored = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(restored.status).toBe("ACTIVE");
    // Not merely ACTIVE-with-a-stamp: a leftover `archivedAt` is a project
    // that reads as archived to anything that looks at the timestamp rather
    // than the enum.
    expect(restored.archivedAt).toBeNull();
  });

  it("cannot restore a project another operator owns", async () => {
    const strangerId = await createTestUser("unarchive-stranger");
    try {
      const theirs = await projectService.create(strangerId, {
        name: `stranger-restore-${RUN}`,
      });
      await projectService.archive(strangerId, theirs.id);

      await expect(projectService.unarchive(userId, theirs.id)).rejects.toThrow(
        NotFoundError,
      );

      const row = await prisma.project.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.status).toBe("ARCHIVED");
      expect(row.archivedAt).not.toBeNull();
    } finally {
      await deleteTestUser(strangerId);
    }
  });

  it("is a harmless no-op on a project that is already active", async () => {
    // The `where` matches on ownership, not on status, so this lands as an
    // idempotent write rather than a NotFoundError claiming the operator does
    // not own their own project.
    const project = await projectService.create(userId, {
      name: `already-active-${RUN}`,
    });

    await expect(
      projectService.unarchive(userId, project.id),
    ).resolves.toBeUndefined();

    const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.status).toBe("ACTIVE");
    expect(row.archivedAt).toBeNull();
  });

  it("refuses a soft-deleted project", async () => {
    // `remove` is the one path with no way back, and restoring must not
    // become an accidental undelete: `deletedAt: null` is in the `where` for
    // the same reason it is in `archive`'s.
    const project = await projectService.create(userId, {
      name: `deleted-then-restored-${RUN}`,
    });
    await projectService.remove(userId, project.id);

    await expect(projectService.unarchive(userId, project.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});

/**
 * `remove` has been in the tree, cascading and refusing, with no caller and no
 * test at all — the projects table's only mention of it was a comment
 * explaining why bulk delete was not offered. It has a caller now (Delete, on
 * archived rows), so what it actually does to the videos underneath is worth
 * pinning down, and so is the count it reports back: the confirmation quotes
 * that number to the operator before they commit.
 */
describe("projectService.remove", () => {
  it("cascades to every video and reports the count the confirmation quotes", async () => {
    const project = await projectService.create(userId, {
      name: `cascade-${RUN}`,
    });
    const videos = await Promise.all(
      ["one", "two", "three"].map((title) =>
        prisma.video.create({
          data: { userId, projectId: project.id, title, topic: "deleting" },
        }),
      ),
    );

    const { deletedVideoCount } = await projectService.remove(userId, project.id);

    expect(deletedVideoCount).toBe(3);

    const rows = await prisma.video.findMany({
      where: { id: { in: videos.map((video) => video.id) } },
      select: { deletedAt: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);

    const removed = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(removed.deletedAt).not.toBeNull();
  });

  it("counts only what it deletes — already-deleted videos are not double counted", async () => {
    // The number the dialog shows comes from `deletionImpact`, which scopes to
    // `deletedAt: null` exactly as this cascade does. If the two ever drifted,
    // the confirmation would promise a different number than it delivers.
    const project = await projectService.create(userId, {
      name: `count-matches-${RUN}`,
    });
    const live = await prisma.video.create({
      data: { userId, projectId: project.id, title: "live", topic: "counting" },
    });
    await prisma.video.create({
      data: {
        userId,
        projectId: project.id,
        title: "gone already",
        topic: "counting",
        deletedAt: new Date(),
      },
    });

    const impact = await projectService.deletionImpact(userId, project.id);
    expect(impact.videoCount).toBe(1);

    const { deletedVideoCount } = await projectService.remove(userId, project.id);
    expect(deletedVideoCount).toBe(impact.videoCount);

    const row = await prisma.video.findUniqueOrThrow({ where: { id: live.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it("refuses in full while the render worker holds a video, deleting nothing", async () => {
    const project = await projectService.create(userId, {
      name: `mid-render-${RUN}`,
    });
    const busy = await prisma.video.create({
      data: {
        userId,
        projectId: project.id,
        title: "being rendered",
        topic: "leases",
        status: "RENDERING",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const bystander = await prisma.video.create({
      data: { userId, projectId: project.id, title: "idle", topic: "leases" },
    });

    await expect(projectService.remove(userId, project.id)).rejects.toThrow(
      ConflictError,
    );

    // All or nothing: the point of the up-front check is that the operator
    // never ends up with a half-deleted project.
    for (const id of [busy.id, bystander.id]) {
      const row = await prisma.video.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).toBeNull();
    }
    const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.deletedAt).toBeNull();
  });

  it("proceeds once the lease has expired", async () => {
    // The refusal is about a worker actively holding the row, not about the
    // status alone — a RENDERING video whose lease lapsed is abandoned work,
    // and blocking on it forever would strand the project.
    const project = await projectService.create(userId, {
      name: `stale-lease-${RUN}`,
    });
    await prisma.video.create({
      data: {
        userId,
        projectId: project.id,
        title: "abandoned render",
        topic: "leases",
        status: "RENDERING",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    await expect(projectService.remove(userId, project.id)).resolves.toEqual({
      deletedVideoCount: 1,
    });
  });

  it("cannot delete a project another operator owns", async () => {
    const strangerId = await createTestUser("delete-stranger");
    try {
      const theirs = await projectService.create(strangerId, {
        name: `stranger-delete-${RUN}`,
      });
      const theirVideo = await prisma.video.create({
        data: {
          userId: strangerId,
          projectId: theirs.id,
          title: "not yours",
          topic: "scoping",
        },
      });

      await expect(projectService.remove(userId, theirs.id)).rejects.toThrow(
        NotFoundError,
      );

      const row = await prisma.project.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.deletedAt).toBeNull();
      const video = await prisma.video.findUniqueOrThrow({
        where: { id: theirVideo.id },
      });
      expect(video.deletedAt).toBeNull();
    } finally {
      await deleteTestUser(strangerId);
    }
  });
});

/**
 * The numbers the delete confirmation puts on screen. Each one is a claim made
 * to an operator about something they cannot take back, so each is worth
 * holding to the row it describes.
 */
describe("projectService.deletionImpact", () => {
  it("counts the videos, the published ones, and the ones mid-render", async () => {
    const project = await projectService.create(userId, {
      name: `impact-${RUN}`,
    });
    await prisma.video.create({
      data: { userId, projectId: project.id, title: "draft", topic: "impact" },
    });
    await prisma.video.createMany({
      data: [
        {
          userId,
          projectId: project.id,
          title: "live one",
          topic: "impact",
          status: "PUBLISHED",
        },
        {
          userId,
          projectId: project.id,
          title: "live two",
          topic: "impact",
          status: "PUBLISHED",
        },
        {
          userId,
          projectId: project.id,
          title: "in flight",
          topic: "impact",
          status: "RENDERING",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    await expect(
      projectService.deletionImpact(userId, project.id),
    ).resolves.toEqual({
      videoCount: 4,
      publishedCount: 2,
      activeRenderCount: 1,
    });
  });

  it("reports zeroes for an empty project rather than failing", async () => {
    const project = await projectService.create(userId, {
      name: `impact-empty-${RUN}`,
    });

    await expect(
      projectService.deletionImpact(userId, project.id),
    ).resolves.toEqual({
      videoCount: 0,
      publishedCount: 0,
      activeRenderCount: 0,
    });
  });

  it("cannot read another operator's project", async () => {
    // Counts are a disclosure too: how many videos a stranger's project holds,
    // and how many are published, is not this operator's to see.
    const strangerId = await createTestUser("impact-stranger");
    try {
      const theirs = await projectService.create(strangerId, {
        name: `stranger-impact-${RUN}`,
      });
      await prisma.video.create({
        data: {
          userId: strangerId,
          projectId: theirs.id,
          title: "not yours either",
          topic: "scoping",
        },
      });

      await expect(
        projectService.deletionImpact(userId, theirs.id),
      ).rejects.toThrow(NotFoundError);
    } finally {
      await deleteTestUser(strangerId);
    }
  });
});
