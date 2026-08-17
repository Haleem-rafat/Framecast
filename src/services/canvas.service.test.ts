import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { canvasService } from "@/services/canvas.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The canvas read model, against a real Postgres.
 *
 * What is asserted here is the grouping and the positions — the two things this
 * service adds. The per-automation facts it groups are
 * `automation-list.service.ts`'s and are tested there; re-asserting them would
 * be testing that a `Promise.all` returns what it was given.
 */

vi.setConfig({ testTimeout: 40_000 });

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("canvas");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

/** A channel with a project on it and a standalone schedule in that project —
 *  the smallest arrangement that produces one rooted branch. */
async function makeChannelWithSchedule(title: string) {
  const channel = await prisma.channel.create({
    data: {
      userId,
      youtubeChannelId: `UC_canvas_${randomUUID().slice(0, 12)}`,
      title,
      accessToken: "ya29.test",
      refreshToken: "1//test",
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: { userId, name: `${title} project`, channelId: channel.id },
    select: { id: true },
  });
  const schedule = await prisma.schedule.create({
    data: {
      userId,
      name: `${title} queue`,
      projectId: project.id,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timeZone: "UTC",
      status: "ACTIVE",
    },
    select: { id: true },
  });

  return { channelId: channel.id, projectId: project.id, scheduleId: schedule.id };
}

describe("read", () => {
  it("returns nothing for an account with no automations", async () => {
    const model = await canvasService.read(userId);

    expect(model.branches).toEqual([]);
    expect(model.positions).toEqual({});
  });

  it("puts a channel's automations in one branch", async () => {
    const { channelId } = await makeChannelWithSchedule("Kids");

    const model = await canvasService.read(userId);

    expect(model.branches).toHaveLength(1);
    expect(model.branches[0].channel?.id).toBe(channelId);
    expect(model.branches[0].automations).toHaveLength(1);
  });

  it("gives each channel its own branch", async () => {
    await makeChannelWithSchedule("Kids");
    await makeChannelWithSchedule("Finance");

    const model = await canvasService.read(userId);

    expect(model.branches).toHaveLength(2);
    const titles = model.branches.map((branch) => branch.channel?.title).sort();
    expect(titles).toEqual(["Finance", "Kids"]);
  });

  it("groups two automations on one channel into one branch", async () => {
    const { channelId, projectId } = await makeChannelWithSchedule("Kids");
    await prisma.schedule.create({
      data: {
        userId,
        name: "Second queue",
        projectId,
        frequency: "WEEKLY",
        dayOfWeek: 3,
        hour: 9,
        minute: 0,
        timeZone: "UTC",
        status: "ACTIVE",
      },
    });

    const model = await canvasService.read(userId);

    expect(model.branches).toHaveLength(1);
    expect(model.branches[0].channel?.id).toBe(channelId);
    expect(model.branches[0].automations).toHaveLength(2);
  });

  it("draws an automation with no channel last, in its own unrooted branch", async () => {
    // A schedule whose project has no channel publishes nowhere. Hiding it
    // would hide exactly the thing worth looking at — but it is a footnote, so
    // it must not push a working channel down the canvas.
    const orphanProject = await prisma.project.create({
      data: { userId, name: "No channel" },
      select: { id: true },
    });
    await prisma.schedule.create({
      data: {
        userId,
        name: "Orphan queue",
        projectId: orphanProject.id,
        frequency: "WEEKLY",
        dayOfWeek: 1,
        hour: 9,
        minute: 0,
        timeZone: "UTC",
        status: "ACTIVE",
      },
    });
    await makeChannelWithSchedule("Kids");

    const model = await canvasService.read(userId);

    expect(model.branches).toHaveLength(2);
    expect(model.branches.at(-1)?.channel).toBeNull();
    expect(model.branches[0].channel?.title).toBe("Kids");
  });

  it("carries a saved position back under its node key", async () => {
    await canvasService.moveNode(userId, "series:abc", 120, 340);

    const model = await canvasService.read(userId);

    expect(model.positions["series:abc"]).toEqual({ x: 120, y: 340 });
  });
});

describe("moveNode", () => {
  it("overwrites a position rather than accumulating rows", async () => {
    await canvasService.moveNode(userId, "series:abc", 10, 10);
    await canvasService.moveNode(userId, "series:abc", 99, 99);

    const rows = await prisma.canvasNode.findMany({ where: { userId } });

    expect(rows).toHaveLength(1);
    expect(rows[0].x).toBe(99);
    expect(rows[0].y).toBe(99);
  });

  it("accepts a key naming nothing that exists", async () => {
    // Deliberate: the key is opaque, and a position for a deleted series is
    // read by nobody. Refusing would mean a second copy of the key vocabulary
    // here, free to disagree with the canvas that builds it.
    await expect(
      canvasService.moveNode(userId, "series:deleted-long-ago", 1, 1),
    ).resolves.toBeUndefined();
  });

  it("keeps one operator's canvas out of another's", async () => {
    const otherId = await createTestUser("canvas-other");

    try {
      await canvasService.moveNode(userId, "series:abc", 10, 10);

      const other = await canvasService.read(otherId);

      expect(other.positions).toEqual({});
    } finally {
      await deleteTestUser(otherId);
    }
  });

  it("lets two operators hold the same node key independently", async () => {
    const otherId = await createTestUser("canvas-other");

    try {
      await canvasService.moveNode(userId, "series:shared", 10, 10);
      await canvasService.moveNode(otherId, "series:shared", 77, 77);

      const mine = await canvasService.read(userId);
      const theirs = await canvasService.read(otherId);

      expect(mine.positions["series:shared"]).toEqual({ x: 10, y: 10 });
      expect(theirs.positions["series:shared"]).toEqual({ x: 77, y: 77 });
    } finally {
      await deleteTestUser(otherId);
    }
  });
});
