import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScriptService } from "@/services/script.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// that also holds the operator's real data. Every test in this file gets its
// own private, throwaway User (see src/test/fixtures.ts) instead of the
// operator's real account, so this file's fixtures can never collide with —
// or be mistaken for — the operator's real projects/videos/usage.
//
// ProviderUsage rows are still keyed off a run-unique token even though the
// user is private: the model.generate() code path writes them outside the
// video/project tree (no userId column of its own — see
// src/test/fixtures.ts's note on ProviderUsage.credentialId), so
// deleteTestUser()'s cascade alone would not catch them without going
// through the credential relation this file never populates. The
// success-path row's `model` comes straight from the provider result, so the
// fake provider returns a model string embedding RUN, and cleanup/assertions
// key off that. The one failure-path row recorded when the provider throws
// before returning (per the brief) carries no such marker — `model` is
// null — so it can't be told apart from a *concurrent* `pnpm test` process's
// identically-shaped row by any query. That test captures and deletes its
// own row by id inline instead of relying on a query-based sweep, so a
// concurrent run's row is never at risk of being deleted out from under it.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-script-${RUN}`;
const FAKE_MODEL = `test-model-${RUN}`;

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

/**
 * Deletes only the ProviderUsage rows this file created for the current
 * test, identified by this run's FAKE_MODEL marker. Project/video fixtures
 * need no equivalent function: they hang off the private test user created
 * in beforeEach, so deleteTestUser() cascades them away. The one test whose
 * row carries no such marker cleans up its own row by id — see the file
 * header comment.
 */
async function cleanupProviderUsage() {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
}

beforeEach(async () => {
  await cleanupProviderUsage();
  userId = await createTestUser("script");
  projectId = (await projectService.create(userId, { name: PROJECT_NAME })).id;
  videoId = (
    await videoService.create(userId, {
      projectId: projectId as string,
      title: "How inflation actually works",
      topic: "inflation",
    })
  ).id;

  // generate() renders the operator's default SCRIPT prompt template.
  // The seeded operator account has one; this private test user does not,
  // so the fixture provides its own — otherwise every generate() call below
  // fails with NotFoundError before ever reaching the (mocked) provider.
  await prisma.promptTemplate.create({
    data: {
      userId,
      name: "Default script",
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: true,
      variables: {
        create: [{ key: "topic", label: "Topic", required: true }],
      },
    },
  });

  service = new ScriptService(makeFakeProvider());

  // generate() unconditionally resolves an ANTHROPIC credential for the
  // caller before ever reaching the (injected, mocked) provider. This
  // private test user never stores one, so resolveKey() would legitimately
  // return null on its own — it's still stubbed here so a slow real lookup
  // isn't on the critical path of every test in this file.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupProviderUsage();
  await deleteTestUser(userId);
});
afterAll(cleanupProviderUsage);

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

    // No column on ProviderUsage carries a run-unique marker for this
    // zero-cost failure shape (see the file header comment), and a
    // concurrent `pnpm test` process can be running this exact test — or the
    // "records the provider's real cost..." test below, which also produces
    // a `succeeded: false` row — at the same instant, so a time-window query
    // alone can pick up the wrong row (both scenarios observed while
    // hardening this file for concurrent runs). Snapshotting every existing
    // row of this shape beforehand and diffing against what exists
    // afterward identifies "this" row exactly: two rows can never share an
    // id, so the one id that's new is unambiguously the one this call
    // created, regardless of what else is racing the same shared table.
    const shape = {
      operation: "script.generate" as const,
      succeeded: false,
      inputTokens: 0,
      outputTokens: 0,
      createdAt: { gte: new Date() },
    };
    const before = new Set(
      (await prisma.providerUsage.findMany({ where: shape, select: { id: true } })).map(
        (row) => row.id,
      ),
    );

    let caught: unknown;
    try {
      await failing.generate(userId, videoId, {});
    } catch (error) {
      caught = error;
    }

    // Nothing was billed — the provider never returned — so the original
    // error must propagate unchanged (not converted to a ConflictError, not
    // wrapped) and zero is the truthful cost.
    expect(caught).toBe(upstreamError);

    const after = await prisma.providerUsage.findMany({
      where: shape,
      select: { id: true },
    });
    const newId = after.map((row) => row.id).find((id) => !before.has(id));
    if (!newId) {
      throw new Error(
        "Expected a new zero-cost failed ProviderUsage row from this call, found none.",
      );
    }
    const usage = await prisma.providerUsage.findUniqueOrThrow({
      where: { id: newId },
    });

    try {
      expect(usage.succeeded).toBe(false);
      expect(Number(usage.costUsd)).toBe(0);
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    } finally {
      // Deleting by this specific id (rather than the shared cleanup's
      // model-scoped sweep, which can't see this row at all) means this test
      // can only ever remove the one row it just identified, never a wider
      // window of some other test's or process's rows.
      await prisma.providerUsage.deleteMany({ where: { id: usage.id } });
    }
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

      // Unlike the throws-before-returning case above, the provider here
      // actually resolved, so the row this test's own catch block wrote
      // carries this run's FAKE_MODEL marker — filtering on it (rather than
      // just the time window) is what keeps this assertion from reading a
      // concurrent run's identically-shaped row racing the same narrow
      // window against this shared, otherwise-unscoped table.
      const usage = await prisma.providerUsage.findFirstOrThrow({
        where: {
          operation: "script.generate",
          succeeded: false,
          model: FAKE_MODEL,
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

  it("stores one cue per section, anchored to that section's opening", async () => {
    // A provider whose result carries `sections`, unlike makeFakeProvider's
    // plain-prose stub — this is the shape a structured-output model
    // returns, one cue per section it wants illustrated.
    const sectioned = new ScriptService({
      generateScript: vi.fn(async () => ({
        content: "Inflation is not prices going up. It is money losing value.",
        model: FAKE_MODEL,
        provider: "ANTHROPIC" as const,
        inputTokens: 100,
        outputTokens: 400,
        costUsd: 0.0063,
        latencyMs: 1200,
        sections: [
          { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
          { text: "It is money losing value.", cue: "printing press running" },
        ],
      })),
    });

    const version = await sectioned.generate(userId, videoId, {});

    // Narration is unchanged in shape: the sections joined, nothing else.
    expect(version.content).toBe(
      "Inflation is not prices going up. It is money losing value.",
    );
    expect(version.cues).toEqual([
      { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
      { anchor: "It is money losing value.", cue: "printing press running" },
    ]);
  });

  it("stores no cues when the model returns no sections", async () => {
    // service (from beforeEach) uses makeFakeProvider, whose result has no
    // `sections` field at all — the shape prose-only providers, or older
    // prompts, produce.
    const version = await service.generate(userId, videoId, {});

    // Nothing to anchor, and nothing that would break an existing pipeline.
    expect(version.cues).toBeNull();
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

      console.info(`[collision-rate] ${collisions}/${attempts} concurrent pairs collided`);

      // Two concurrent generate() calls racing the same script's version
      // number collide on the DB unique constraint almost every time; this
      // asserts the race is actually being exercised rather than silently
      // serialising. The C2 Gate 1 guard deliberately takes its row lock as
      // the transaction's last statement precisely so this stays true —
      // taking it first serialised these calls and blew the transaction
      // timeout instead.
      expect(collisions).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("Gate 1 bypass — approval mid-generation must not overwrite the approved script (C2 regression)", () => {
  it("discards a regeneration that resolves after Approve won the DRAFT -> QUEUED race, and leaves activeVersionId on the approved version", async () => {
    // Reproduces: press Regenerate, then press Approve script while the
    // spinner is still running. Approve wins the atomic DRAFT -> QUEUED
    // update and reports success; seconds later the stale regeneration
    // resolves. Before the fix it repointed activeVersionId at content no
    // human ever read.
    const approved = await service.generate(userId, videoId, {});

    // A provider whose generateScript() we hold open until approval has
    // landed underneath it, so the approval is guaranteed to fall inside
    // the generation's in-flight window rather than racing it.
    let resolveGeneration!: (value: Awaited<ReturnType<TextGenerationProvider["generateScript"]>>) => void;
    const pendingGeneration = new Promise<
      Awaited<ReturnType<TextGenerationProvider["generateScript"]>>
    >((resolve) => {
      resolveGeneration = resolve;
    });
    const holdingProvider: TextGenerationProvider = {
      generateScript: vi.fn(() => pendingGeneration),
    };
    const holdingService = new ScriptService(holdingProvider);

    const generatePromise = holdingService.generate(userId, videoId, {});

    // Give generate() a tick to reach and await the (held-open) provider
    // call before Approve fires, so Approve genuinely lands mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await videoService.approveScript(userId, videoId);

    resolveGeneration({
      content: "Unapproved content nobody read.",
      model: FAKE_MODEL,
      provider: "ANTHROPIC",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      latencyMs: 1,
    });

    await expect(generatePromise).rejects.toThrow(ConflictError);

    const script = await prisma.script.findUniqueOrThrow({
      where: { videoId },
      include: { versions: true },
    });
    expect(script.activeVersionId).toBe(approved.id);
    expect(script.versions).toHaveLength(1);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("QUEUED");
  });
});

describe("Gate 1 — script is frozen once the video leaves DRAFT", () => {
  it("still allows both setActiveVersion and saveEdit while the video is DRAFT", async () => {
    const v1 = await service.generate(userId, videoId, {});
    const v2 = await service.generate(userId, videoId, {});

    await service.setActiveVersion(userId, videoId, v1.id);
    let script = await prisma.script.findUniqueOrThrow({ where: { videoId } });
    expect(script.activeVersionId).toBe(v1.id);

    const v3 = await service.saveEdit(userId, videoId, "Edited while still a draft.");
    script = await prisma.script.findUniqueOrThrow({ where: { videoId } });
    expect(script.activeVersionId).toBe(v3.id);
    expect(v3.content).toBe("Edited while still a draft.");

    // Sanity check that v2 really was in play — otherwise the assertions
    // above could pass by accident on a script with only one version.
    expect(v2.id).not.toBe(v1.id);
  });

  it("refuses setActiveVersion once the video leaves DRAFT, and leaves the active pointer untouched", async () => {
    const v1 = await service.generate(userId, videoId, {});
    const v2 = await service.generate(userId, videoId, {});
    await prisma.video.update({ where: { id: videoId }, data: { status: "QUEUED" } });

    await expect(
      service.setActiveVersion(userId, videoId, v1.id),
    ).rejects.toBeInstanceOf(ConflictError);

    // The refusal has to be more than "it threw" — the pointer a downstream
    // stage reads must still be exactly what it was before the refused call.
    const script = await prisma.script.findUniqueOrThrow({ where: { videoId } });
    expect(script.activeVersionId).toBe(v2.id);
  });

  it("refuses saveEdit once the video leaves DRAFT, and creates no new version", async () => {
    const v1 = await service.generate(userId, videoId, {});
    await prisma.video.update({ where: { id: videoId }, data: { status: "QUEUED" } });

    await expect(
      service.saveEdit(userId, videoId, "An edit nobody approved."),
    ).rejects.toBeInstanceOf(ConflictError);

    const script = await prisma.script.findUniqueOrThrow({
      where: { videoId },
      include: { versions: true },
    });
    expect(script.activeVersionId).toBe(v1.id);
    expect(script.versions).toHaveLength(1);
    expect(script.versions[0].content).not.toBe("An edit nobody approved.");
  });
});

describe("scriptService.saveEdit — re-anchoring cues (Task 3)", () => {
  // A provider whose result carries `sections`, mirroring the fake used by
  // "stores one cue per section, anchored to that section's opening" above.
  // The second section is nine words long — longer than script-cues.ts's
  // eight-word ANCHOR_WORDS — specifically so an edit can land after that
  // section's anchor without rewriting the anchor itself; a section shorter
  // than ANCHOR_WORDS has no such room, since its anchor is the whole
  // section and *any* edit to it changes the anchor.
  function sectionedProvider(): ScriptService {
    return new ScriptService({
      generateScript: vi.fn(async () => ({
        content:
          "Inflation is not prices going up. It is money losing value over time and space.",
        model: FAKE_MODEL,
        provider: "ANTHROPIC" as const,
        inputTokens: 100,
        outputTokens: 400,
        costUsd: 0.0063,
        latencyMs: 1200,
        sections: [
          { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
          {
            text: "It is money losing value over time and space.",
            cue: "printing press running",
          },
        ],
      })),
    });
  }

  it("carries cues onto an edited version when their openings survive", async () => {
    const sectioned = sectionedProvider();
    await sectioned.generate(userId, videoId, {});

    // Edits the tail of the second section, past its eight-word anchor;
    // both anchors are untouched.
    const result = await sectioned.saveEdit(
      userId,
      videoId,
      "Inflation is not prices going up. It is money losing value over time and " +
        "distance across the whole economy.",
    );

    expect(result.orphanedCueCount).toBe(0);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });
    expect(version.cues).toHaveLength(2);
  });

  it("reports a cue whose opening was rewritten instead of dropping it silently", async () => {
    const sectioned = sectionedProvider();
    await sectioned.generate(userId, videoId, {});

    // Rewrites the second section's opening outright; the first section's
    // anchor is untouched.
    const result = await sectioned.saveEdit(
      userId,
      videoId,
      "Inflation is not prices going up. Money buys less than it used to across " +
        "the whole economy.",
    );

    // The second cue's anchor is gone; the first still stands.
    expect(result.orphanedCueCount).toBe(1);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });
    expect(version.cues).toHaveLength(1);
  });
});
