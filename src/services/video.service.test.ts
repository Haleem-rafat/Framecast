import { beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";

let userId: string;
let projectId: string;

beforeEach(async () => {
  await prisma.video.deleteMany();
  await prisma.project.deleteMany();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  projectId = (await projectService.create(userId, { name: "Money Mechanics" })).id;
});

describe("videoService", () => {
  it("creates a video in DRAFT", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "How inflation actually works",
      topic: "inflation",
    });

    expect(video.status).toBe("DRAFT");
  });

  it("refuses approval while there is no script", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "No script yet",
      topic: "x",
    });

    await expect(videoService.approveScript(userId, video.id)).rejects.toThrow(
      ConflictError,
    );
  });

  it("hides another user's videos", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "Mine",
      topic: "x",
    });

    await expect(
      videoService.get("00000000-0000-4000-8000-000000000001", video.id),
    ).rejects.toThrow();
  });
});
