import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Alignment } from "@/lib/captions";
import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { deleteRenderFile, renderPath, writeRenderFile } from "@/lib/render-storage";
import { extractAnchor, type ScriptCue } from "@/lib/script-cues";
import { MIN_SHORT_SECONDS } from "@/lib/shorts-plan";
import { deleteShortFile, shortPath } from "@/lib/shorts-storage";
import { putObject, storagePath } from "@/lib/storage";
import { projectService } from "@/services/project.service";
import type { ProcessSpawner } from "@/services/render.service";
import {
  type MomentCandidate,
  type MomentSelector,
  ShortsService,
} from "@/services/shorts.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database and the real storage root
// (see src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User (see
// src/test/fixtures.ts), so nothing here can collide with — or be mistaken for
// — the operator's real videos.
//
// Neither FFmpeg nor the model provider ever runs: both are injected through
// ShortsService's constructor, the same injection shape RenderService's
// spawner and ScriptService's provider use.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-shorts-${RUN}`;

// Each test makes several sequential round trips against a live remote Postgres
// plus real writes to the local storage and render roots — comfortably past
// Vitest's 5s default under any network variance.
vi.setConfig({ testTimeout: 30_000 });

/**
 * The narration fixture: eight sections of exactly 49 characters, joined by
 * single spaces exactly as gateway.provider.ts joins the model's sections.
 *
 * At 0.1s per character that is 4.9s of speech per section, sections starting
 * at 0s, 5s, 10s ... 35s, and 39.9s in total — so every expectation below is a
 * number you can check by counting characters rather than by trusting the code
 * under test. Eight rather than the four a smaller fixture would need, because
 * a four-section script cannot hold two non-overlapping shorts once the
 * MIN_SHORT_SECONDS floor is applied, and the overlap and ordering rules are
 * exactly what this file is here to check.
 */
const SECTIONS = [
  "Everyone thinks inflation is about prices rising.",
  "It is really about the supply of money expanding.",
  "The printing press is the clearest example here..",
  "Weimar Germany printed money to pay off war debts",
  "Prices doubled every few days by the autumn there",
  "A wheelbarrow of notes bought a single loaf again",
  "The lesson is that money is a claim on real goods",
  "Print more claims and each one is worth much less",
];
const CONTENT = SECTIONS.join(" ");
const NARRATION_SECONDS = CONTENT.length * 0.1;

function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => Number((i * 0.1).toFixed(6))),
    characterEndTimesSeconds: characters.map((_, i) => Number(((i + 1) * 0.1).toFixed(6))),
  };
}

/** The cues script.service.ts would have stored for the fixture narration —
 *  derived with the real `extractAnchor`, so a change to how anchors are cut
 *  breaks this file rather than silently producing a script whose cues no
 *  longer match its own text. */
function fixtureCues(): ScriptCue[] {
  return SECTIONS.map((text, index) => ({
    anchor: extractAnchor(text),
    cue: `clip ${index + 1}`,
  }));
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  command: string;
  args: string[];
}

/** Same shape as render.service.test.ts's spawner: `run` fires on a microtask,
 *  after the service has synchronously attached its listeners, so an event
 *  emitted inside it is never missed. */
function createSpawner(
  run: (child: FakeChildProcess, args: string[]) => void | Promise<void>,
): { spawner: ProcessSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: ProcessSpawner = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      void run(child, args);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawner, calls };
}

/** Writes the bytes FFmpeg would have produced at the output path, reports a
 *  progress line, then exits cleanly. */
function createSucceedingSpawner() {
  return createSpawner(async (child, args) => {
    child.stdout.emit("data", "out_time_ms=1000000\nprogress=continue\n");
    await writeFile(args[args.length - 1], `fake-short-bytes-${RUN}`);
    child.emit("close", 0);
  });
}

/** Fails the way a real FFmpeg failure arrives: some stderr, then a non-zero
 *  exit. */
function createFailingSpawner() {
  return createSpawner((child) => {
    child.stderr.emit("data", "Invalid data found when processing input");
    child.emit("close", 1);
  });
}

/** A selector that answers with whatever the test wants, without a model. */
function fakeSelector(moments: MomentCandidate[]): MomentSelector {
  return vi.fn(async () => moments);
}

function moment(startSection: number, endSection: number): MomentCandidate {
  return {
    startSection,
    endSection,
    title: `Sections ${startSection}-${endSection}`,
    description: "A description.",
    reason: "It stands alone.",
  };
}

/** Generates one short and claims it, which is the state `renderShort`
 *  requires — it refuses anything not already RENDERING. */
async function claimOne(service: ShortsService, videoId: string): Promise<string> {
  const [queued] = await service.generate(userId, videoId);
  const claimed = await service.claimNext();
  expect(claimed?.shortId).toBe(queued.id);
  return queued.id;
}

/** The SRT path out of an argv's `-vf`, which is where `buildShortArgs` puts
 *  it — as the `subtitles=` filter's first, positional option. */
function srtPathOf(args: string[]): string {
  return args[args.indexOf("-vf") + 1].split("subtitles=")[1].split(":")[0];
}

let userId: string;

/** Every video id and short id this file mints, so the files they leave under
 *  RENDER_ROOT are cleaned up rather than accumulating across runs. Deleting a
 *  path that was never written is nothing to clean up, hence the `.catch`. */
const createdVideoIds: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("shorts");
});

afterEach(async () => {
  vi.restoreAllMocks();

  const videoIds = createdVideoIds.splice(0);

  // Read before the user cascade removes the rows: a short's file is named by
  // its own id, which is only knowable from the row.
  const shorts =
    videoIds.length > 0
      ? await prisma.short.findMany({
          where: { videoId: { in: videoIds } },
          select: { id: true },
        })
      : [];

  await deleteTestUser(userId);

  // Asset carries no videoId column (see its comment in schema.prisma), so the
  // user cascade cannot reach the alignment rows these fixtures wrote. Scoped
  // by the storage prefix, and every id here was minted by this run.
  if (videoIds.length > 0) {
    await prisma.asset.deleteMany({
      where: {
        OR: videoIds.map((id) => ({ storagePath: { startsWith: `videos/${id}/` } })),
      },
    });
  }

  await Promise.all([
    ...videoIds.map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
    ...shorts.map((short) => deleteShortFile(shortPath(short.id)).catch(() => {})),
  ]);
});

/**
 * A video in exactly the state shorts are cut from: READY, with narration, a
 * stored alignment, a cued script and a finished render on disk.
 *
 * These rows are created directly rather than through the services that
 * normally write them — ShortsService only ever reads them, and going through
 * the real pipeline would make this file a test of the pipeline.
 */
async function makeClippableVideo(
  opts: { cues?: ScriptCue[]; status?: "READY" | "PUBLISHED" | "DRAFT" } = {},
): Promise<string> {
  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Shorts fixture video",
    topic: "inflation",
  });
  createdVideoIds.push(video.id);

  await prisma.video.update({
    where: { id: video.id },
    data: { status: opts.status ?? "READY" },
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: {
      scriptId: script.id,
      version: 1,
      content: CONTENT,
      wordCount: CONTENT.split(" ").length,
      cues: (opts.cues ?? fixtureCues()) as never,
    },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  await prisma.voiceOver.create({
    data: {
      videoId: video.id,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      audioUrl: storagePath(video.id, "audio", "narration.mp3"),
      // Stored as an integer, exactly as VoiceOverService stores it — so this
      // fixture exercises the same rounding the real pipeline produces.
      durationSeconds: Math.floor(NARRATION_SECONDS),
    },
  });

  const alignmentPath = storagePath(video.id, "captions", "alignment.json");
  await putObject(
    alignmentPath,
    Buffer.from(JSON.stringify(evenAlignment(CONTENT))),
    "application/json",
  );
  await prisma.asset.create({
    data: { kind: "SUBTITLE", storagePath: alignmentPath, provider: "ELEVENLABS" },
  });

  const outputUrl = await writeRenderFile(video.id, Buffer.from(`fake-render-${RUN}`));
  await prisma.renderJob.create({
    data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl },
  });

  return video.id;
}

describe("generate — mapping chosen sections onto the video's timeline", () => {
  it("turns a run of sections into the seconds they are spoken", async () => {
    const videoId = await makeClippableVideo();
    // Sections 2..4 of the prompt's 1-based numbering: spoken from 5s onward.
    const service = new ShortsService(fakeSelector([moment(2, 4)]));

    const [short] = await service.generate(userId, videoId);

    // Sections start every 5s in this fixture, so section 2 begins at 5.0 and
    // section 4 ends at 20.0. Anything else means the service anchored against
    // the wrong string, read the wrong alignment, or got the 1-based to 0-based
    // conversion wrong — each of which would cut every short in the wrong place.
    expect(short.startSeconds).toBeCloseTo(5, 3);
    expect(short.endSeconds).toBeCloseTo(20, 3);
    expect(short.endSeconds - short.startSeconds).toBeGreaterThanOrEqual(MIN_SHORT_SECONDS);
    expect(short.status).toBe("QUEUED");
    expect(short.title).toBe("Sections 2-4");
  });

  it("keeps the model's own title, description and reason", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));

    const [short] = await service.generate(userId, videoId);

    expect(short.description).toBe("A description.");
    expect(short.reason).toBe("It stands alone.");
  });

  it("shows the model 1-based section numbers with their spoken lengths", async () => {
    const videoId = await makeClippableVideo();
    const selector = fakeSelector([moment(1, 3)]);
    const service = new ShortsService(selector);

    await service.generate(userId, videoId);

    const { sections } = vi.mocked(selector).mock.calls[0][0];
    const lines = sections.split("\n");

    expect(lines).toHaveLength(8);
    // 1-based, because this string is read by a language model. Getting this
    // wrong by one shifts every generated short by a whole section.
    expect(lines[0]).toContain("1. ");
    expect(lines[0]).toContain("Everyone thinks inflation");
    expect(lines[7]).toContain("8. ");
  });

  it("drops a moment whose section numbers do not exist", async () => {
    const videoId = await makeClippableVideo();
    // A model hallucinating section 12 of an eight-section script must produce
    // no short — never a short of some other, arbitrary moment.
    const service = new ShortsService(fakeSelector([moment(1, 3), moment(11, 12)]));

    const shorts = await service.generate(userId, videoId);

    expect(shorts).toHaveLength(1);
  });

  it("drops a moment that overlaps one already accepted", async () => {
    const videoId = await makeClippableVideo();
    // Three near-identical uploads are worse than one good one.
    const service = new ShortsService(
      fakeSelector([moment(1, 3), moment(2, 4), moment(1, 2)]),
    );

    const shorts = await service.generate(userId, videoId);

    expect(shorts).toHaveLength(1);
  });

  it("orders shorts by where they fall in the video, not by the model's ranking", async () => {
    const videoId = await makeClippableVideo();
    // Answered latest-first; `index` must still run in play order, which is
    // the only ordering an operator can follow while scrubbing the source.
    const service = new ShortsService(fakeSelector([moment(6, 8), moment(1, 3)]));

    const shorts = await service.generate(userId, videoId);

    expect(shorts.map((short) => short.index)).toEqual([0, 1]);
    expect(shorts[0].startSeconds).toBeCloseTo(0, 3);
    expect(shorts[1].startSeconds).toBeCloseTo(25, 3);
  });

  it("refuses when every moment the model chose is unusable", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(20, 20), moment(-1, 0)]));

    // Silently returning zero shorts would leave the operator staring at an
    // empty panel with no idea whether anything happened.
    await expect(service.generate(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("generate — the states it refuses", () => {
  it("refuses a script with no section cues", async () => {
    const videoId = await makeClippableVideo({ cues: [] });
    const service = new ShortsService(fakeSelector([moment(1, 2)]));

    // Without cues there is no sentence boundary to cut on. Slicing the
    // narration into equal chunks would produce something, and what it
    // produced would start mid-clause.
    await expect(service.generate(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a script whose cues no longer match its text", async () => {
    const videoId = await makeClippableVideo({
      cues: [{ anchor: "Nothing in this script says any of this", cue: "orphan" }],
    });
    const service = new ShortsService(fakeSelector([moment(1, 1)]));

    await expect(service.generate(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a video that has not finished rendering", async () => {
    const videoId = await makeClippableVideo({ status: "DRAFT" });
    const service = new ShortsService(fakeSelector([moment(1, 2)]));

    await expect(service.generate(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows a published video", async () => {
    // Publishing reclaims the section clips but leaves the render itself, and
    // a live video is the one an operator most wants shorts from.
    const videoId = await makeClippableVideo({ status: "PUBLISHED" });
    const service = new ShortsService(fakeSelector([moment(1, 3)]));

    await expect(service.generate(userId, videoId)).resolves.toHaveLength(1);
  });

  it("refuses while one of the previous set is still rendering", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [short] = await service.generate(userId, videoId);

    await prisma.short.update({
      where: { id: short.id },
      data: { status: "RENDERING" },
    });

    // Deleting a row underneath a worker would have that worker write READY to
    // a row that no longer exists.
    await expect(service.generate(userId, videoId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("never reveals another user's video", async () => {
    const videoId = await makeClippableVideo();
    const otherUserId = await createTestUser("shorts-other");
    const service = new ShortsService(fakeSelector([moment(1, 3)]));

    try {
      await expect(service.generate(otherUserId, videoId)).rejects.toThrow();
      await expect(service.list(otherUserId, videoId)).rejects.toThrow();
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("generate — regeneration", () => {
  it("replaces the previous set outright", async () => {
    const videoId = await makeClippableVideo();
    const first = await new ShortsService(fakeSelector([moment(1, 3)])).generate(
      userId,
      videoId,
    );

    const second = await new ShortsService(
      fakeSelector([moment(1, 3), moment(6, 8)]),
    ).generate(userId, videoId);

    // Not six shorts of which three are known-rejected — and `index` restarts
    // from zero, which the unique constraint would refuse if the old rows were
    // only soft-deleted.
    expect(second).toHaveLength(2);
    expect(second.map((short) => short.id)).not.toContain(first[0].id);

    const stored = await prisma.short.count({ where: { videoId } });
    expect(stored).toBe(2);
  });
});

describe("claimNext", () => {
  it("claims a queued short and marks it rendering", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    const claimed = await service.claimNext();

    expect(claimed?.shortId).toBe(queued.id);
    expect(claimed?.videoId).toBe(videoId);
    expect(claimed?.userId).toBe(userId);

    const stored = await prisma.short.findUniqueOrThrow({ where: { id: queued.id } });
    expect(stored.status).toBe("RENDERING");
    expect(stored.attempts).toBe(1);
    expect(stored.leaseExpiresAt).not.toBeNull();
  });

  it("lets only one of two concurrent workers win the same short", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    // The conditional update IS the lock — see claimNext's own comment. Two
    // workers both reading the row as claimable must not both believe they
    // won it, or the same short is encoded twice.
    const [a, b] = await Promise.all([service.claimNext(), service.claimNext()]);
    const winners = [a, b].filter((result) => result?.shortId === queued.id);

    expect(winners).toHaveLength(1);
  });

  it("retakes a short whose worker died holding it", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    await prisma.short.update({
      where: { id: queued.id },
      data: { status: "RENDERING", leaseExpiresAt: new Date(Date.now() - 60_000) },
    });

    // A lapsed lease is proof no worker holds it. A lock would strand it.
    const claimed = await service.claimNext();
    expect(claimed?.shortId).toBe(queued.id);
  });

  it("leaves a short alone while its lease is live", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    await prisma.short.update({
      where: { id: queued.id },
      data: { status: "RENDERING", leaseExpiresAt: new Date(Date.now() + 120_000) },
    });

    const claimed = await service.claimNext();
    expect(claimed?.shortId).not.toBe(queued.id);
  });

  it("stops claiming a short that has exhausted its attempts", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    // Otherwise a deterministically-failing short re-encodes on every poll,
    // forever.
    await prisma.short.update({
      where: { id: queued.id },
      data: { attempts: 3 },
    });

    const claimed = await service.claimNext();
    expect(claimed?.shortId).not.toBe(queued.id);
  });

  it("skips a short whose parent video was deleted", async () => {
    const videoId = await makeClippableVideo();
    const service = new ShortsService(fakeSelector([moment(1, 3)]));
    const [queued] = await service.generate(userId, videoId);

    await prisma.video.update({
      where: { id: videoId },
      data: { deletedAt: new Date() },
    });

    const claimed = await service.claimNext();
    expect(claimed?.shortId).not.toBe(queued.id);
  });
});

describe("renderShort", () => {
  it("cuts the stored window out of the parent's render at 1080x1920", async () => {
    const videoId = await makeClippableVideo();
    const { spawner, calls } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const shortId = await claimOne(service, videoId);

    await service.renderShort(shortId);

    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    const filter = args[args.indexOf("-vf") + 1];

    expect(filter).toContain("crop=1080:1920");
    // The seek must match the row, not some recomputed value: the row is what
    // the operator sees in the panel beside the clip.
    const stored = await prisma.short.findUniqueOrThrow({ where: { id: shortId } });
    expect(Number(args[args.indexOf("-ss") + 1])).toBeCloseTo(stored.startSeconds, 3);
  });

  it("burns captions cut to the clip and rebased to zero", async () => {
    const videoId = await makeClippableVideo();

    // The SRT is read from inside the spawner, which is the only moment it
    // exists: `renderShort` deletes its temp directory in a `finally`.
    let srt = "";
    const { spawner } = createSpawner(async (child, args) => {
      srt = await readFile(srtPathOf(args), "utf8").catch(() => "");
      await writeFile(args[args.length - 1], `fake-short-bytes-${RUN}`);
      child.emit("close", 0);
    });
    const service = new ShortsService(fakeSelector([moment(3, 5)]), spawner);
    const shortId = await claimOne(service, videoId);

    await service.renderShort(shortId);

    // The clip is encoded with `-ss` before `-i`, which resets output
    // timestamps to zero, so its SRT has to be numbered from zero too —
    // otherwise every caption in every short is off by where it was cut from.
    expect(srt).toContain("00:00:00,000 --> ");
    // Section 3's own words, not the video's opening line.
    expect(srt).toContain("printing");
    expect(srt).not.toContain("Everyone thinks");
  });

  it("commits READY and the output path in one write", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const shortId = await claimOne(service, videoId);

    await service.renderShort(shortId);

    // A short that read READY with nothing to play would give the panel a
    // player pointed at a 404.
    const stored = await prisma.short.findUniqueOrThrow({ where: { id: shortId } });
    expect(stored.status).toBe("READY");
    expect(stored.outputPath).toBe(shortPath(shortId));
    expect(stored.leaseExpiresAt).toBeNull();
  });

  it("refuses a short nobody has claimed", async () => {
    const videoId = await makeClippableVideo();
    const { spawner, calls } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const [queued] = await service.generate(userId, videoId);

    await expect(service.renderShort(queued.id)).rejects.toBeInstanceOf(ConflictError);
    expect(calls).toHaveLength(0);
  });

  it("names the missing render rather than surfacing an ffmpeg exit code", async () => {
    const videoId = await makeClippableVideo();
    const { spawner, calls } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const shortId = await claimOne(service, videoId);

    await deleteRenderFile(renderPath(videoId));

    await expect(service.renderShort(shortId)).rejects.toBeInstanceOf(ConflictError);
    // Checked before an encoder is ever spawned.
    expect(calls).toHaveLength(0);
  });

  it("surfaces ffmpeg's stderr when the encode fails", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createFailingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const shortId = await claimOne(service, videoId);

    await expect(service.renderShort(shortId)).rejects.toThrow(/Invalid data found/);
  });
});

describe("release — and what a failed short may not touch", () => {
  it("records the failure on the short and clears its lease", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createFailingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const [queued] = await service.generate(userId, videoId);
    await service.claimNext();

    await service.release(queued.id, "failed", "ffmpeg exited with code 1");

    const stored = await prisma.short.findUniqueOrThrow({ where: { id: queued.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.error).toContain("code 1");
    // Cleared so the next attempt can claim it, subject to MAX_ATTEMPTS.
    expect(stored.leaseExpiresAt).toBeNull();
  });

  it("leaves the parent video untouched when a short fails", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createFailingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const [queued] = await service.generate(userId, videoId);
    await service.claimNext();

    await service.renderShort(queued.id).catch(() => {});
    await service.release(queued.id, "failed", "ffmpeg exited with code 1");

    // The whole reason shorts are a separate claim rather than a seventh
    // pipeline stage: a finished, publishable video must not be turned into a
    // failed one by a derivative that could not be encoded.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
    expect(video.failureReason).toBeNull();
  });

  it("does not overwrite a short another worker has since finished", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const shortId = await claimOne(service, videoId);

    await service.renderShort(shortId);
    // A stale failure report arriving after the winner committed READY.
    await service.release(shortId, "failed", "too late");

    const stored = await prisma.short.findUniqueOrThrow({ where: { id: shortId } });
    expect(stored.status).toBe("READY");
  });
});

describe("list", () => {
  it("reports whether each short has a file to play", async () => {
    const videoId = await makeClippableVideo();
    const { spawner } = createSucceedingSpawner();
    const service = new ShortsService(fakeSelector([moment(2, 4)]), spawner);
    const [queued] = await service.generate(userId, videoId);

    expect((await service.list(userId, videoId))[0].hasFile).toBe(false);

    await service.claimNext();
    await service.renderShort(queued.id);

    expect((await service.list(userId, videoId))[0].hasFile).toBe(true);
  });
});
