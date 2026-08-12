import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { TITLE_MAX } from "@/lib/youtube-limits";
import { MetadataService } from "@/services/metadata.service";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

let userId: string;
let videoId: string;

async function makeVideoWithScript(content = "Money is weirder than you think.") {
  const project = await projectService.create(userId, { name: `meta-${RUN}` });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Operator's own title",
    topic: "money",
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return video.id;
}

beforeEach(async () => {
  userId = await createTestUser("metadata");
  videoId = await makeVideoWithScript();
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("MetadataService.generate", () => {
  it("stores the generated fields without touching the operator's title", async () => {
    const service = new MetadataService({
      generateMetadata: async () => ({
        title: "How inflation actually works",
        description: "The full explanation.",
        tags: ["money", "inflation"],
      }),
    });

    await service.generate(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBe("How inflation actually works");
    expect(video.tags).toEqual(["money", "inflation"]);
    // The human's title survives, by construction rather than by convention.
    expect(video.title).toBe("Operator's own title");
  });

  it("clamps an over-long title rather than letting YouTube reject it", async () => {
    const service = new MetadataService({
      generateMetadata: async () => ({
        title: `${"word ".repeat(40)}end`,
        description: "Body",
        tags: [],
      }),
    });

    await service.generate(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle!.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it("retries once with the limits restated before clamping", async () => {
    const generateMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        title: "x".repeat(300),
        description: "Body",
        tags: [],
      })
      .mockResolvedValueOnce({
        title: "A title that fits",
        description: "Body",
        tags: [],
      });

    await new MetadataService({ generateMetadata }).generate(userId, videoId);

    expect(generateMetadata).toHaveBeenCalledTimes(2);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBe("A title that fits");
  });

  it("returns null and leaves the video publishable when generation fails", async () => {
    const service = new MetadataService({
      generateMetadata: async () => {
        throw new Error("gateway down");
      },
    });

    // Metadata is an enhancement: a video with none still publishes under the
    // operator's own title.
    expect(await service.generate(userId, videoId)).toBeNull();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBeNull();
    expect(video.title).toBe("Operator's own title");
  });

  it("refuses a video with no approved script", async () => {
    const project = await projectService.create(userId, { name: `meta-bare-${RUN}` });
    const bare = await videoService.create(userId, {
      projectId: project.id,
      title: "No script",
      topic: "a video with no script yet",
    });

    const service = new MetadataService({
      generateMetadata: async () => ({ title: "t", description: "d", tags: [] }),
    });

    expect(await service.generate(userId, bare.id)).toBeNull();
  });
});
