import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
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

// This file runs several generate() calls per test (and the concurrency test
// runs twenty), each several sequential round trips against a live, shared
// remote Postgres instance — comfortably past Vitest's 5s default under any
// network variance. Raising it here avoids flaking on latency rather than on
// a real regression.
vi.setConfig({ testTimeout: 20_000 });

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

  // generate() unconditionally resolves a real ANTHROPIC credential for the
  // shared operator before ever reaching the (injected, mocked) provider.
  // That row is genuinely shared and externally mutable — decryptSecret()
  // throws InternalError on a rotated/tampered ciphertext, which another
  // agent's concurrent work against the same live database has observed to
  // trigger intermittently here. providerCredentialService's own correctness
  // is covered by provider-credential.service.test.ts, so it's stubbed out
  // rather than left as an unrelated, flaky dependency of these tests.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCurrentRun();
});
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

  it("records a zero-cost failed ProviderUsage row when the provider throws before returning, and rethrows the original error unchanged", async () => {
    const upstreamError = new Error("upstream down");
    const failing = new ScriptService({
      generateScript: vi.fn(async () => {
        throw upstreamError;
      }),
    });

    const before = new Date();
    let caught: unknown;
    try {
      await failing.generate(userId, videoId, {});
    } catch (error) {
      caught = error;
    }
    const after = new Date();

    // Nothing was billed — the provider never returned — so the original
    // error must propagate unchanged (not converted to a ConflictError, not
    // wrapped) and zero is the truthful cost.
    expect(caught).toBe(upstreamError);

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: {
        operation: "script.generate",
        succeeded: false,
        createdAt: { gte: before, lte: after },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(usage.succeeded).toBe(false);
    expect(Number(usage.costUsd)).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it("records the provider's real cost when a later transaction step fails after billing", async () => {
    // The provider has already resolved (and, in production, already been
    // billed) by the time this fires — simulating a step *inside* the
    // transaction failing after generateScript() succeeded. $transaction is
    // mocked rather than forcing a real constraint violation because the
    // point under test is the catch block's bookkeeping (does it use the
    // captured result or fall back to zeros), independent of which specific
    // downstream step failed.
    const forcedError = new Error("transaction blew up after billing");
    const transactionSpy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce(async () => {
        throw forcedError;
      });

    try {
      const before = new Date();
      let caught: unknown;
      try {
        await service.generate(userId, videoId, {});
      } catch (error) {
        caught = error;
      }
      const after = new Date();

      expect(caught).toBe(forcedError);

      const usage = await prisma.providerUsage.findFirstOrThrow({
        where: {
          operation: "script.generate",
          succeeded: false,
          createdAt: { gte: before, lte: after },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(usage.succeeded).toBe(false);
      expect(Number(usage.costUsd)).toBeCloseTo(0.0063, 6);
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(400);
      expect(usage.model).toBe(FAKE_MODEL);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("retains the rendered prompt for reproducibility", async () => {
    const version = await service.generate(userId, videoId, {});

    expect(version.prompt).toContain("inflation");
  });

  it(
    "converts a concurrent version collision into ConflictError rather than a raw Prisma error",
    async () => {
      const attempts = 10;
      let collisions = 0;

      for (let i = 0; i < attempts; i++) {
        const results = await Promise.allSettled([
          service.generate(userId, videoId, {}),
          service.generate(userId, videoId, {}),
        ]);

        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        if (rejected.length > 0) {
          collisions++;
        }

        for (const result of rejected) {
          expect(result.reason).toBeInstanceOf(ConflictError);
        }
      }

      // eslint-disable-next-line no-console -- surfaced for the report's literal output
      console.info(
        `[collision-rate] ${collisions}/${attempts} concurrent pairs collided`,
      );

      // Two concurrent generate() calls racing the same script's version
      // number collide on the DB unique constraint almost every time; this
      // asserts the race is actually being exercised rather than silently
      // serialising.
      expect(collisions).toBeGreaterThan(0);
    },
    60_000,
  );
});
