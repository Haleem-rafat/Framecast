import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beatClipPath } from "@/lib/beat-storage";
import { ProviderError, ValidationError } from "@/lib/errors";
import { MAX_BILLED_SECONDS_PER_VIDEO } from "@/lib/motion-spend";
import { prisma } from "@/lib/prisma";
import { MAX_CLIPS, type Manifest, type ManifestClip } from "@/lib/render-manifest";
import { removeObjects } from "@/lib/storage";
import { MotionService } from "@/services/motion.service";
import { DEFAULT_FAL_MODEL } from "@/services/providers/fal-video.provider";
import type { ProviderCredentialService } from "@/services/provider-credential.service";
import type { VideoGenerationProvider } from "@/services/providers/types";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The motion tier, against a real Postgres and no provider at all.
 *
 * Same discipline as auto-publish.service.test.ts: a throwaway `User` per test
 * (src/test/fixtures.ts), because the database is shared with real data. The
 * video provider, the FFmpeg spawner and the credential store are all injected,
 * so **nothing here contacts fal.ai and nothing here can spend a penny** — which
 * matters more in this file than in any other, since the thing under test is the
 * only code in Framecast that bills by the second.
 *
 * The assertions worth having are about money and about the seed:
 *
 *   - Neither gate may be passable. A malformed manifest and an over-budget one
 *     must both leave zero rows, because a row is the first artefact that leads
 *     to a bill.
 *   - A poll must never be mistaken for a submit. Eleven of the twelve ticks on
 *     a clip are polls, and a poll that counted an attempt — or worse, re-sent
 *     the request — would multiply the cost of the tier by ten.
 *   - A re-roll changes the seed; a retry does not. That distinction is the
 *     whole reason the seed is a column.
 */

vi.setConfig({ testTimeout: 40_000 });

let userId: string;
let projectId: string;
let videoId: string;

/** Objects written to the real bucket. `Asset` has no FK back to `User`, so
 *  `deleteTestUser`'s cascade cannot reach them. */
const storedPaths: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("motion");
  const project = await prisma.project.create({
    data: { userId, name: "Motion tier fixtures" },
    select: { id: true },
  });
  projectId = project.id;
  const video = await prisma.video.create({
    data: { userId, projectId, title: "Generated", status: "QUEUED", format: "VERTICAL" },
    select: { id: true },
  });
  videoId = video.id;
});

afterEach(async () => {
  if (storedPaths.length > 0) {
    await removeObjects(storedPaths.splice(0));
  }
  await prisma.asset.deleteMany({
    where: { storagePath: { startsWith: `videos/${videoId}/` } },
  });
  await deleteTestUser(userId);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A prompt of a legal length naming exactly one allowed camera move — the
 *  shape `checkManifest` insists on, built the way its own test builds it. */
function prompt(): string {
  const filler = Array.from({ length: 44 }, (_, index) => `word${index}`).join(" ");

  return `Medium shot of a man ${filler} slow push in`;
}

/**
 * Twelve words, and the count is load-bearing rather than arbitrary.
 *
 * `checkManifest`'s drift check compares the clips' declared seconds against how
 * long their words take to say at `WORDS_PER_SECOND`. Eleven clips at 4.5s is
 * 49.5s declared; 12 x 11 = 132 words is 50.8s spoken, 1.3s apart and inside the
 * 2s tolerance. Eleven words per clip drifts by 3.0s and the fixture fails its
 * own gate.
 */
const NARRATION = "Your brain keeps an open file for anything you left unfinished today";

function clip(id: number, beat: string): ManifestClip {
  return {
    id,
    beat,
    start: 0,
    duration: 4.5,
    narration: NARRATION,
    caption: "AN OPEN FILE",
    captionHighlight: "OPEN",
    emphasis: ["open"],
    cameraMove: "slow push in",
    prompt: prompt(),
    seed: 100001,
  };
}

/** Eleven clips, six beats in order, and a total that matches its own words —
 *  a manifest `checkManifest` accepts. */
function manifest(overrides: Partial<Manifest> = {}): Manifest {
  const beats = [
    "HOOK",
    "HOOK",
    "TENSION",
    "TENSION",
    "MECHANISM",
    "MECHANISM",
    "MECHANISM",
    "NAME_IT",
    "TURN",
    "TURN",
    "LOOP",
  ];

  return {
    conceptName: "The Zeigarnik effect",
    aspectRatio: "9:16",
    styleLock: "35mm, f/2.0, shallow depth of field, cinematic documentary",
    negativePrompt: "text, watermark, logo",
    clips: beats.map((beat, index) => ({ ...clip(index + 1, beat), start: index * 4.5 })),
    ...overrides,
  };
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  kill(signal?: string) {
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
}

/** A spawner that writes plausible bytes to the output path and exits 0 — the
 *  same shape thumbnail.service.test.ts uses, so no encoder ever runs. */
function conformingSpawner() {
  const calls: string[][] = [];

  const spawner = (_command: string, args: string[]) => {
    const child = new FakeChildProcess();
    calls.push(args);
    queueMicrotask(async () => {
      await writeFile(args[args.length - 1], `conformed-${randomUUID()}`);
      child.emit("close", 0);
    });
    return child as never;
  };

  return { spawner, calls };
}

interface FakeProviderOptions {
  submit?: VideoGenerationProvider["submit"];
  checkStatus?: VideoGenerationProvider["checkStatus"];
  fetchResult?: VideoGenerationProvider["fetchResult"];
}

/** Every method fails the test if it is reached without being asked for. Most
 *  cases here never get as far as a generation, and a stub that silently
 *  succeeded would hide that. */
function fakeProvider(options: FakeProviderOptions = {}): VideoGenerationProvider {
  return {
    provider: "FAL",
    submit:
      options.submit ??
      (async () => {
        throw new Error("submit should not have been called");
      }),
    checkStatus:
      options.checkStatus ??
      (async () => {
        throw new Error("checkStatus should not have been called");
      }),
    fetchResult:
      options.fetchResult ??
      (async () => {
        throw new Error("fetchResult should not have been called");
      }),
    verifyKey: async () => true,
  };
}

type Credentials = Pick<ProviderCredentialService, "resolveKey">;

const KEY: Credentials = { resolveKey: async () => "fal-test-key" };
const NO_KEY: Credentials = { resolveKey: async () => null };

function service(options: FakeProviderOptions = {}, credentials: Credentials = KEY) {
  return new MotionService(fakeProvider(options), conformingSpawner().spawner, credentials);
}

async function jobRow(clipId: number) {
  return prisma.motionClipJob.findFirstOrThrow({ where: { videoId, clipId } });
}

/**
 * Enqueues the manifest and then leaves exactly one row standing.
 *
 * `claimDue` picks the oldest *due* job, and eleven rows written in the same
 * millisecond are ordered by nothing in particular. A test that follows one
 * row's attempts across several ticks has to be the only row there is, or it is
 * really asserting about whichever sibling the ordering happened to surface.
 */
async function enqueueOne(motion: MotionService) {
  await motion.enqueue(userId, videoId, manifest());
  await prisma.motionClipJob.deleteMany({ where: { videoId, clipId: { not: 1 } } });
}

// ---------------------------------------------------------------------------

describe("MotionService.enqueue", () => {
  it("writes one job per clip, with the style lock already appended and the seed pinned", async () => {
    const spend = await service().enqueue(userId, videoId, manifest());

    const rows = await prisma.motionClipJob.findMany({
      where: { videoId },
      orderBy: { slotIndex: "asc" },
    });

    expect(rows).toHaveLength(11);
    expect(spend.billedSeconds).toBe(88);
    expect(rows[0].seed).toBe(100001);
    expect(rows[0].model).toBe(DEFAULT_FAL_MODEL);
    // Appended in code, once, so all eleven clips carry byte-identical look
    // instructions — and stored, so a later edit to the look does not rewrite
    // what this clip was asked for.
    expect(rows[0].prompt).toContain("cinematic documentary");
    // One generation's worth. The 1.6x reject multiplier is a fleet-level
    // planning number and lives in the total, not on a row.
    expect(rows[0].billedSeconds).toBe(5);
    expect(rows.map((row) => row.slotIndex)).toEqual([...Array(11).keys()]);
  });

  it("refuses a malformed manifest without writing a single row", async () => {
    const bad = manifest();
    bad.clips[3].seed = Number.NaN;

    await expect(service().enqueue(userId, videoId, bad)).rejects.toThrow(ValidationError);
    expect(await prisma.motionClipJob.count({ where: { videoId } })).toBe(0);
  });

  it("refuses a manifest past the spend ceiling, and says so as a refusal rather than a warning", async () => {
    // The ceiling is the largest manifest checkManifest accepts, so the only
    // way to exceed it is to lower it — which is exactly how a per-video budget
    // would be imposed.
    await expect(
      service().enqueue(userId, videoId, manifest(), { ceilingSeconds: 40 }),
    ).rejects.toThrow(/Refusing to generate/);
    expect(await prisma.motionClipJob.count({ where: { videoId } })).toBe(0);
  });

  it("lets the largest manifest the format allows through, so the two gates cannot disagree", async () => {
    const full = manifest();
    // Twelve clips, six beats still in order: a second MECHANISM inserted among
    // the others, which is MAX_CLIPS exactly.
    full.clips = [...full.clips.slice(0, 7), clip(0, "MECHANISM"), ...full.clips.slice(7)];
    full.clips.forEach((entry, index) => {
      entry.id = index + 1;
      entry.start = index * 4.5;
    });
    // 12 x 4.5 = 54s declared against 144 words, which is 55.4s spoken — still
    // inside the drift tolerance, so this exercises the ceiling and not the
    // validator.
    const spend = await service().enqueue(userId, videoId, full);

    expect(full.clips).toHaveLength(MAX_CLIPS);
    expect(spend.billedSeconds).toBe(MAX_BILLED_SECONDS_PER_VIDEO);
    expect(spend.withinCeiling).toBe(true);
  });

  it("is a no-op the second time, so a retried enqueue is not a second bill", async () => {
    const reseeded = manifest();
    reseeded.clips.forEach((entry) => {
      entry.seed = 999;
    });

    await service().enqueue(userId, videoId, manifest());
    await service().enqueue(userId, videoId, reseeded);

    expect(await prisma.motionClipJob.count({ where: { videoId } })).toBe(11);
    // The FIRST wins. A retry must not rewrite the seed a clip is being
    // generated under.
    expect((await jobRow(1)).seed).toBe(100001);
  });
});

describe("MotionService.claimDue", () => {
  it("wins a job once, and a second caller gets a different one", async () => {
    await service().enqueue(userId, videoId, manifest());

    const first = await service().claimDue();
    const second = await service().claimDue();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The conditional update is the lock. Two callers must never hold the same
    // row — here that would mean buying the same generation twice.
    expect(first?.jobId).not.toBe(second?.jobId);
    expect((await jobRow(first!.clipId)).status).toBe("CLAIMED");
  });

  it("retakes a lapsed claim without counting an attempt against it", async () => {
    await enqueueOne(service());
    const claim = await service().claimDue();

    await prisma.motionClipJob.update({
      where: { id: claim!.jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const retaken = await service().claimDue();

    expect(retaken?.jobId).toBe(claim!.jobId);
    // A worker that died mid-call is not a generation that was refused.
    expect(retaken?.attempts).toBe(0);
  });
});

describe("MotionService.executeClaim — submitting", () => {
  it("sends the stored prompt and seed, then records the request id before anything else", async () => {
    const sent: unknown[] = [];
    const motion = service({
      submit: async (request) => {
        sent.push(request);
        return "req-abc";
      },
    });

    await motion.enqueue(userId, videoId, manifest());
    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await jobRow(result.clipId);

    expect(result.outcome).toBe("SUBMITTED");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ seed: 100001, aspectRatio: "9:16", durationSeconds: 4.5 });
    // The most consequential write in the file. A row that lost its request id
    // would be submitted again, and a duplicate submit is a duplicate bill.
    expect(row.requestId).toBe("req-abc");
    expect(row.status).toBe("SUBMITTED");
    expect(row.submittedAt).not.toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("gives up immediately when no credential is stored, rather than retrying forever", async () => {
    const motion = service({}, NO_KEY);

    await motion.enqueue(userId, videoId, manifest());
    const result = await motion.executeClaim((await motion.claimDue())!);

    // No number of retries produces a credential. A queue backing off every
    // half hour against a provider nobody configured looks busy and does
    // nothing.
    expect(result.outcome).toBe("FAILED");
    expect(result.reason).toContain("No FAL credential is stored");
    expect((await jobRow(result.clipId)).attempts).toBe(0);
  });

  it("backs off a transient submit failure and gives up at the third", async () => {
    const motion = service({
      submit: async () => {
        throw new ProviderError("FAL", "Could not reach fal.ai.", true);
      },
    });

    await enqueueOne(motion);
    const first = await motion.executeClaim((await motion.claimDue())!);
    expect(first.outcome).toBe("DEFERRED");

    let row = await jobRow(first.clipId);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("WAITING");
    // Five minutes, then thirty. Pushed far enough out that the row is no
    // longer due, which is the whole point of a backoff.
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    for (const attempt of [2, 3]) {
      await prisma.motionClipJob.update({
        where: { id: first.jobId },
        data: { runAfter: new Date(Date.now() - 1000) },
      });
      const next = await motion.executeClaim((await motion.claimDue())!);
      row = await jobRow(first.clipId);
      expect(row.attempts).toBe(attempt);
      expect(next.outcome).toBe(attempt === 3 ? "FAILED" : "DEFERRED");
    }

    expect(row.status).toBe("FAILED");
  });

  it("ends a job on a refusal a retry cannot fix, without paying for it twice", async () => {
    const motion = service({
      submit: async () => {
        throw new ProviderError("FAL", "veo3 cannot render 1:1.", false);
      },
    });

    await motion.enqueue(userId, videoId, manifest());
    const result = await motion.executeClaim((await motion.claimDue())!);

    expect(result.outcome).toBe("FAILED");
    expect((await jobRow(result.clipId)).attempts).toBe(1);
  });
});

describe("MotionService.executeClaim — polling", () => {
  /** A job already submitted, which is where every poll test starts. */
  async function submitted() {
    const motion = service({ submit: async () => "req-abc" });
    await motion.enqueue(userId, videoId, manifest());
    const result = await motion.executeClaim((await motion.claimDue())!);

    await prisma.motionClipJob.update({
      where: { id: result.jobId },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    return result.jobId;
  }

  it("polls a running generation without counting an attempt or re-submitting it", async () => {
    const jobId = await submitted();
    const motion = service({
      checkStatus: async () => ({ state: "PENDING", detail: null }),
      // `submit` throws if reached. Eleven of the twelve ticks on a clip are
      // polls; one that re-sent the request would multiply this tier's cost by
      // ten.
    });

    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await prisma.motionClipJob.findFirstOrThrow({ where: { id: jobId } });

    expect(result.outcome).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.requestId).toBe("req-abc");
    expect(row.status).toBe("SUBMITTED");
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("abandons a generation that is still running past the deadline", async () => {
    const jobId = await submitted();
    await prisma.motionClipJob.update({
      where: { id: jobId },
      // Submitted an hour ago and still queued. The deadline is thirty minutes,
      // roughly eight times the one generation anybody has timed.
      data: { submittedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const motion = service({ checkStatus: async () => ({ state: "PENDING", detail: null }) });
    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await prisma.motionClipJob.findFirstOrThrow({ where: { id: jobId } });

    expect(result.outcome).toBe("DEFERRED");
    expect(row.attempts).toBe(1);
    // Cleared, so the next attempt is a fresh submit rather than another poll
    // of a dead id.
    expect(row.requestId).toBeNull();
    // NOT cleared. A retry is still trying to make the same clip; changing what
    // it asks for behind the operator's back is `reroll`'s job.
    expect(row.seed).toBe(100001);
  });

  it("treats a poll it could not make as a poll, not as a failed generation", async () => {
    const jobId = await submitted();
    const motion = service({
      checkStatus: async () => {
        throw new ProviderError("FAL", "Could not reach fal.ai.", true);
      },
    });

    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await prisma.motionClipJob.findFirstOrThrow({ where: { id: jobId } });

    // The generation is still running and still paid for. Counting an attempt
    // would eventually abandon a healthy clip that was merely unreachable.
    expect(result.outcome).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.requestId).toBe("req-abc");
  });

  it("stores a finished clip, conformed, under the beats prefix the renderer already reads", async () => {
    const jobId = await submitted();
    const { spawner, calls } = conformingSpawner();
    const motion = new MotionService(
      fakeProvider({
        checkStatus: async () => ({ state: "COMPLETED", detail: null }),
        fetchResult: async () => ({
          data: Buffer.from("raw-16fps-720p-bytes"),
          contentType: "video/mp4",
          seed: 100001,
        }),
      }),
      spawner,
      KEY,
    );

    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await prisma.motionClipJob.findFirstOrThrow({ where: { id: jobId } });
    storedPaths.push(result.storagePath!);

    expect(result.outcome).toBe("STORED");
    expect(row.status).toBe("DONE");
    // Same prefix and same naming as the mixed collector's stock clips, which
    // is what makes this play with no renderer change: planRender reads the
    // extension.
    expect(result.storagePath).toBe(beatClipPath(videoId, row.slotIndex));

    // The conform is not optional. The measured clip was 720x1280 at ~16fps
    // against a 1080x1920/30fps pipeline; stored raw it is a timeline entry
    // moving at a different rate from every other entry.
    const filter = calls[0][calls[0].indexOf("-vf") + 1];
    expect(filter).toContain("fps=30");
    expect(filter).toContain("crop=1080:1920");

    const asset = await prisma.asset.findFirstOrThrow({
      where: { storagePath: result.storagePath! },
    });
    expect(asset).toMatchObject({ kind: "VIDEO", provider: "FAL", externalId: "req-abc" });

    const usage = await prisma.providerUsage.findFirst({
      where: { provider: "FAL", operation: "motion.generate" },
      orderBy: { createdAt: "desc" },
    });
    expect(usage?.succeeded).toBe(true);
    expect(usage?.model).toBe(DEFAULT_FAL_MODEL);
    // Zero, and deliberately. fal.ai publishes no price endpoint, so the only
    // figure available is a constant an operator typed — and every other row in
    // this table carries a cost the provider reported. One guess in that column
    // makes every total computed from it a guess. The real number is
    // MotionClipJob.billedSeconds, in the unit fal actually bills.
    expect(Number(usage?.costUsd)).toBe(0);
  });

  it("refuses a clip whose seed the provider did not honour", async () => {
    const jobId = await submitted();
    const motion = service({
      checkStatus: async () => ({ state: "COMPLETED", detail: null }),
      fetchResult: async () => ({
        data: Buffer.from("bytes"),
        contentType: "video/mp4",
        seed: 42,
      }),
    });

    const result = await motion.executeClaim((await motion.claimDue())!);
    const row = await prisma.motionClipJob.findFirstOrThrow({ where: { id: jobId } });

    // A provider that ignores the seed cannot re-roll one clip at a time, which
    // removes the only thing that makes this tier affordable to iterate on.
    // Better to learn it on clip one than on clip twelve.
    expect(result.outcome).toBe("FAILED");
    expect(result.reason).toContain("seed 42");
    expect(row.storagePath).toBeNull();
  });

  it("records a failed generation in the usage table, because a reject is billed too", async () => {
    await submitted();
    const motion = service({
      checkStatus: async () => ({ state: "FAILED", detail: "content policy" }),
    });

    const before = await prisma.providerUsage.count({ where: { provider: "FAL" } });
    const result = await motion.executeClaim((await motion.claimDue())!);
    const after = await prisma.providerUsage.count({ where: { provider: "FAL" } });

    expect(result.outcome).toBe("DEFERRED");
    // The rejects are precisely the seconds the 1.6x multiplier exists to
    // account for. Recording only successes would say this tier costs 60% less
    // than it does.
    expect(after).toBe(before + 1);
    expect(
      (
        await prisma.providerUsage.findFirstOrThrow({
          where: { provider: "FAL" },
          orderBy: { createdAt: "desc" },
        })
      ).succeeded,
    ).toBe(false);
  });
});

describe("MotionService.reroll", () => {
  it("changes one clip's seed and leaves every other clip untouched", async () => {
    const motion = service({ submit: async () => "req-abc" });
    await motion.enqueue(userId, videoId, manifest());
    await motion.executeClaim((await motion.claimDue())!);

    await motion.reroll(userId, videoId, 3, 555);

    const rerolled = await jobRow(3);
    expect(rerolled.seed).toBe(555);
    expect(rerolled.status).toBe("WAITING");
    expect(rerolled.requestId).toBeNull();
    expect(rerolled.attempts).toBe(0);
    // The whole economic argument for storing seeds: the other ten clips stay
    // exactly as they were and are not bought again.
    const others = await prisma.motionClipJob.findMany({
      where: { videoId, clipId: { not: 3 } },
    });
    expect(others.every((row) => row.seed === 100001)).toBe(true);
  });

  it("refuses a clip that is not this operator's", async () => {
    await service().enqueue(userId, videoId, manifest());
    const stranger = await createTestUser("motion-stranger");

    await expect(motionRerollAs(stranger)).rejects.toThrow(/was not found/);
    await deleteTestUser(stranger);
  });

  async function motionRerollAs(otherUserId: string) {
    return service().reroll(otherUserId, videoId, 3, 555);
  }
});

describe("MotionService.summary", () => {
  it("separates what was authorised from what was actually submitted", async () => {
    const motion = service({ submit: async () => "req-abc" });
    await motion.enqueue(userId, videoId, manifest());
    await motion.executeClaim((await motion.claimDue())!);

    const summary = await motion.summary(videoId);

    expect(summary.clips).toBe(11);
    expect(summary.inFlight).toBe(1);
    // 11 clips at 5 billed seconds each, one generation apiece.
    expect(summary.billedSecondsPlanned).toBe(55);
    // Only one has actually been sent anywhere. The gap between these two
    // numbers over a whole video is the reject rate, measured rather than
    // assumed.
    expect(summary.billedSecondsSubmitted).toBe(5);
  });
});
