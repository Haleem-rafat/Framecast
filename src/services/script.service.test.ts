import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScriptService } from "@/services/script.service";
import { videoService } from "@/services/video.service";

// Tests run against a real, shared Supabase database (see src/test/setup.ts).
// Every fixture this file creates is tagged with a run-unique token so that a
// concurrent test run — or the operator's own dev app — never has rows it owns
// touched, and this file never touches rows it doesn't own.
//
// ProviderUsage has no column of its own to carry an identifying token: the
// success-path row's `model` comes straight from the provider result, so the
// fake provider returns a model string embedding RUN, and cleanup/assertions
// key off that. The failure-path row (recorded by the service's catch block
// with no model, per the brief) carries no such marker, so it is scoped by the
// narrow time window this file itself opened instead — the best available
// approximation given the schema.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-script-${RUN}`;
const FAKE_MODEL = `test-model-${RUN}`;
const RUN_STARTED_AT = new Date();

function makeFakeProvider(): TextGenerationProvider {
  return {
    generateScript: vi.fn(async () => ({
      content: "Hook. Body. Sources on screen.",
      model: FAKE_MODEL,
      provider: "ANTHROPIC" as const,
      inputTokens: 100,
      outputTokens: 400,
      costUsd: 0.0063,
      latencyMs: 1200,
    })),
  };
}

let userId: string;
let projectId: string | undefined;
let videoId: string;
let service: ScriptService;

/** Deletes only the project/video/usage rows this file created for the current test. */
async function cleanupCurrentRun() {
  await prisma.providerUsage.deleteMany({
    where: {
      OR: [
        { model: FAKE_MODEL },
        {
          operation: "script.generate",
          succeeded: false,
          createdAt: { gte: RUN_STARTED_AT },
        },
      ],
    },
  });

  if (projectId) {
    await prisma.video.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    projectId = undefined;
  }
}

/** Safety net for a crashed test that never reached its own cleanup. */
async function cleanupAnyStrayRuns() {
  const strays = await prisma.project.findMany({
    where: { name: PROJECT_NAME },
    select: { id: true },
  });
  const strayIds = strays.map((p) => p.id);
  if (strayIds.length > 0) {
    await prisma.video.deleteMany({ where: { projectId: { in: strayIds } } });
    await prisma.project.deleteMany({ where: { id: { in: strayIds } } });
  }
  await prisma.providerUsage.deleteMany({
    where: {
      OR: [
        { model: FAKE_MODEL },
        {
          operation: "script.generate",
          succeeded: false,
          createdAt: { gte: RUN_STARTED_AT },
        },
      ],
    },
  });
}

beforeEach(async () => {
  await cleanupCurrentRun();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
  videoId = (
    await videoService.create(userId, {
      projectId: projectId as string,
      title: "How inflation actually works",
      topic: "inflation",
    })
  ).id;
  service = new ScriptService(makeFakeProvider());
});

afterEach(cleanupCurrentRun);
afterAll(cleanupAnyStrayRuns);

describe("scriptService.generate", () => {
  it("stores version 1 and makes it active", async () => {
    const version = await service.generate(userId, videoId, {});

    expect(version.version).toBe(1);
    expect(version.wordCount).toBe(5);

    const script = await prisma.script.findUniqueOrThrow({ where: { videoId } });
    expect(script.activeVersionId).toBe(version.id);
  });

  it("increments the version on regeneration", async () => {
    await service.generate(userId, videoId, {});
    const second = await service.generate(userId, videoId, {});

    expect(second.version).toBe(2);
  });

  it("records a ProviderUsage row with the cost", async () => {
    await service.generate(userId, videoId, {});

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: { model: FAKE_MODEL },
    });
    expect(usage.succeeded).toBe(true);
    expect(Number(usage.costUsd)).toBeCloseTo(0.0063, 6);
  });

  it("records a failed ProviderUsage row when the provider throws", async () => {
    const failing = new ScriptService({
      generateScript: vi.fn(async () => {
        throw new Error("upstream down");
      }),
    });

    const before = new Date();
    await expect(failing.generate(userId, videoId, {})).rejects.toThrow();
    const after = new Date();

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: {
        operation: "script.generate",
        succeeded: false,
        createdAt: { gte: before, lte: after },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(usage.succeeded).toBe(false);
  });

  it("retains the rendered prompt for reproducibility", async () => {
    const version = await service.generate(userId, videoId, {});

    expect(version.prompt).toContain("inflation");
  });
});
