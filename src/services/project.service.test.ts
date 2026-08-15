import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/errors";
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
