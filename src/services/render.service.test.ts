import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteRenderFile, getRenderFile, renderBlobPathname } from "@/lib/blob-render-storage";
import type { Alignment } from "@/lib/captions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { projectService } from "@/services/project.service";
import type { ProcessSpawner } from "@/services/render.service";
import { RenderService } from "@/services/render.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Supabase database and storage bucket (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts). FFmpeg itself never runs: the process spawner
// is injected everywhere below (per RenderService's constructor), following
// the same injection shape as ScriptService's provider and
// VoiceOverService's provider.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-render-${RUN}`;

// Several tests wait out the real 1s progress-write throttle and/or make
// several sequential storage round trips against a live bucket. On top of
// that, every "happy path" test now makes a real multipart upload to Blob
// (see blob-render-storage.ts's writeRenderFile) — a few seconds in
// isolation, but this file's tests run back-to-back against the same live
// store, and the concurrency test at the bottom (which does its own real
// Blob write, right after eight others already have) was observed taking
// 47s under that cumulative load despite running in well under 15s alone.
// 60s leaves real margin rather than pinning this to whatever the store's
// latency happened to be during one measurement.
vi.setConfig({ testTimeout: 60_000 });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds an alignment where every character takes exactly 0.1s, mirroring
 * captions.test.ts's fixture helper. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

interface SpawnCall {
  command: string;
  args: string[];
}

/**
 * Builds an injectable `ProcessSpawner` whose behaviour is fully controlled
 * by `run`. `run` is invoked on a microtask after `spawn()` returns — after
 * RenderService has synchronously attached its `stdout`/`stderr`/`close`
 * listeners — so events emitted from within `run` are never missed.
 */
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

/** A spawner that succeeds immediately: writes fake bytes to the output path
 * FFmpeg would have produced, then closes with code 0. */
function createSucceedingSpawner() {
  return createSpawner(async (child, args) => {
    const outputPath = args[args.length - 1];
    child.stdout.emit("data", "out_time_ms=1000000\nprogress=continue\n");
    await writeFile(outputPath, "fake-rendered-mp4-bytes");
    child.emit("close", 0);
  });
}

/**
 * The input-level `-t` of every segment pass, in play order.
 *
 * A segment pass is the one that carries `-vf`: the crossfade stubs also take
 * a `-t`, but build their picture with `-filter_complex`, and the assemble
 * pass's `-t` is an output-side cut rather than a slot length. Filtering on
 * `-vf` is therefore what isolates "how long does this clip hold the screen".
 */
function segmentSeconds(calls: SpawnCall[]): number[] {
  return calls
    .filter((call) => call.args.includes("-vf"))
    .map((call) => Number(call.args[call.args.indexOf("-t") + 1]));
}

let userId: string;

/** Every video id `makeRenderableVideo` hands out, so the Blob object a
 * successful render leaves behind (see blob-render-storage.ts) is cleaned up
 * alongside the test user rather than accumulating in the real store across
 * test runs. Deleted by the deterministic pathname (`renderBlobPathname`),
 * not a captured `url` — every test id lands here regardless of whether its
 * render actually got as far as `writeRenderFile`, and `del()` on a pathname
 * that was never written is nothing to clean up, hence the `.catch`. */
const renderedVideoIds: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("render");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);

  const videoIds = renderedVideoIds.splice(0);

  // Asset carries no videoId column, so the user cascade above cannot reach
  // the narration, caption and clip rows these fixtures wrote — they would
  // otherwise accumulate in the shared database run after run. Scoped by the
  // storage prefix, and every one of these ids was minted by this run.
  if (videoIds.length > 0) {
    await prisma.asset.deleteMany({
      where: {
        OR: videoIds.map((id) => ({ storagePath: { startsWith: `videos/${id}/` } })),
      },
    });
  }

  await Promise.all(
    videoIds.map((id) => deleteRenderFile(renderBlobPathname(id)).catch(() => {})),
  );
});

/**
 * Creates a video with narration, alignment and stock footage already in
 * place — everything render() requires — and moves it to GENERATING, the
 * status the upstream narration/footage stages are expected to leave it in.
 * These rows are created directly (not through voiceover.service /
 * footage.service, which are owned by other concurrently-active tasks):
 * render.service only ever reads the rows those services produce.
 */
async function makeRenderableVideo(
  opts: {
    durationSeconds?: number;
    clipCount?: number;
    /** Insert the clip Assets back-to-front, so `createdAt` order is the
     *  reverse of the order their paths sort in. */
    reverseInsertion?: boolean;
  } = {},
): Promise<string> {
  const durationSeconds = opts.durationSeconds ?? 2;
  const clipCount = opts.clipCount ?? 2;

  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Render fixture video",
    topic: "testing",
  });

  await prisma.video.update({ where: { id: video.id }, data: { status: "GENERATING" } });

  const audioPath = storagePath(video.id, "audio", "narration.mp3");
  await putObject(audioPath, Buffer.from(`fake-audio-${RUN}`), "audio/mpeg");
  await prisma.voiceOver.create({
    data: {
      videoId: video.id,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      audioUrl: audioPath,
      durationSeconds,
    },
  });

  const alignmentPath = storagePath(video.id, "captions", "alignment.json");
  await putObject(
    alignmentPath,
    Buffer.from(JSON.stringify(evenAlignment("Hello there world"))),
    "application/json",
  );
  await prisma.asset.create({
    data: { kind: "SUBTITLE", storagePath: alignmentPath, provider: "ELEVENLABS" },
  });

  const clipIndices = Array.from({ length: clipCount }, (_clip, i) => i);
  if (opts.reverseInsertion) {
    clipIndices.reverse();
  }

  for (const i of clipIndices) {
    const clipPath = storagePath(video.id, "clips", `clip-${i}.mp4`);
    await putObject(clipPath, Buffer.from(`fake-clip-${i}-${RUN}`), "video/mp4");
    await prisma.asset.create({ data: { kind: "VIDEO", storagePath: clipPath } });
  }

  renderedVideoIds.push(video.id);
  return video.id;
}

interface CuedVideo {
  videoId: string;
  /** The narration verbatim — the same string the alignment indexes, so a
   *  test can convert a character position into the second it is spoken. */
  content: string;
  durationSeconds: number;
}

/** Every character takes 0.1s in `evenAlignment`, so this is where a section
 *  starting at `charIndex` lands on the finished timeline. */
const SECONDS_PER_CHAR = 0.1;

/**
 * A video whose script carries b-roll cues and whose footage was collected
 * per section — the arrangement Task 5's timing model is built for.
 *
 * Sections are deliberately different lengths (the filler grows with the
 * index) because equal ones would hide the whole point: a slot has to be as
 * long as its own section is spoken, not as long as some shared average.
 *
 * As with `makeRenderableVideo`, these rows are written directly rather than
 * through script.service / footage.service — render.service only ever reads
 * what those produce, and going through them would couple this suite to
 * their provider fakes.
 */
async function makeRenderableVideoWithCues(
  cues: { anchor: string; cue: string }[],
  options: {
    /** Section indices to leave without a clip, as a footage collection that
     *  found nothing for a leading section does. */
    skipSections?: number[];
    /** Name the clips the way the pre-cue topic-level collector did, as a
     *  video collected before per-section footage existed still has them. */
    topicNamedClips?: boolean;
    /** Filler words per section, overriding the default spread. A zero makes
     *  that section its anchor alone — spoken in well under a second, which is
     *  what puts `MIN_CLIP_SECONDS` in play. */
    fillerWords?: number[];
    /** Whitespace stored in front of `ScriptVersion.content` but absent from
     *  the narration, exactly as an operator's stray leading newline is: the
     *  alignment indexes what ElevenLabs was sent, which is `content.trim()`. */
    leadingWhitespace?: string;
  } = {},
): Promise<CuedVideo> {
  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Cued render fixture video",
    topic: "testing",
  });

  const sections = cues
    .map((cue, index) => {
      const words = options.fillerWords?.[index] ?? 3 + index * 4;
      return `${cue.anchor} ${"filler ".repeat(words)}`.trim();
    })
    .join(" ");

  // `VoiceOver.durationSeconds` is an integer column, so a narration of 13.6s
  // is stored as 13 and the render's idea of "the end" is a truncation of the
  // alignment's. Padding the script to a whole number of seconds (every
  // character is SECONDS_PER_CHAR in `evenAlignment`) keeps the two the same
  // number, so a test measuring slot lengths is measuring the timing model
  // rather than that rounding. Production lives with the truncation; the last
  // section simply runs to the stored duration.
  const padding = (10 - (sections.length % 10)) % 10;
  const content = padding === 0 ? sections : `${sections} ${"z".repeat(padding - 1)}`;
  const durationSeconds = Math.round(content.length * SECONDS_PER_CHAR);

  // What the column holds; `content` is what is spoken, and the two differ by
  // exactly the leading whitespace a real operator's edit can leave behind.
  const storedContent = `${options.leadingWhitespace ?? ""}${content}`;

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content: storedContent, cues },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  await prisma.video.update({ where: { id: video.id }, data: { status: "GENERATING" } });

  const audioPath = storagePath(video.id, "audio", "narration.mp3");
  await putObject(audioPath, Buffer.from(`fake-audio-${RUN}`), "audio/mpeg");
  await prisma.voiceOver.create({
    data: {
      videoId: video.id,
      provider: "ELEVENLABS",
      voiceId: "test-voice",
      audioUrl: audioPath,
      durationSeconds,
    },
  });

  // The alignment indexes the very same string the cues are anchored in —
  // that identity is what makes a character offset convertible to a time at
  // all (see cueWindows' doc comment).
  const alignmentPath = storagePath(video.id, "captions", "alignment.json");
  await putObject(
    alignmentPath,
    Buffer.from(JSON.stringify(evenAlignment(content))),
    "application/json",
  );
  await prisma.asset.create({
    data: { kind: "SUBTITLE", storagePath: alignmentPath, provider: "ELEVENLABS" },
  });

  const indices = cues
    .map((_cue, index) => index)
    .filter((index) => !(options.skipSections ?? []).includes(index));

  for (const index of indices) {
    const filename = options.topicNamedClips
      ? `pexels-${1000 + index}.mp4`
      : `section-${String(index).padStart(3, "0")}.mp4`;
    const clipPath = storagePath(video.id, "clips", filename);
    // Distinct bytes per section, so a test can tell which clip a segment
    // pass actually opened — the temp filenames alone only carry position.
    await putObject(clipPath, Buffer.from(`fake-section-${index}-${RUN}`), "video/mp4");
    await prisma.asset.create({
      data: { kind: "VIDEO", storagePath: clipPath, provider: "PEXELS", externalId: `s${index}` },
    });
  }

  renderedVideoIds.push(video.id);
  return { videoId: video.id, content, durationSeconds };
}

describe("renderService.render — guards", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("refuses to render a video that is not GENERATING", async () => {
    const project = await projectService.create(userId, { name: PROJECT_NAME });
    const video = await videoService.create(userId, {
      projectId: project.id,
      title: "Still a draft",
      topic: "testing",
    });

    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, video.id)).rejects.toThrow(ConflictError);
  });

  it("refuses to render when stock footage has not been collected", async () => {
    const videoId = await makeRenderableVideo({ clipCount: 0 });
    const service = new RenderService(createSucceedingSpawner().spawner);
    await expect(service.render(userId, videoId)).rejects.toThrow(ConflictError);
  });
});

describe("renderService.render — happy path", () => {
  it("moves the RenderJob to SUCCEEDED and the video GENERATING → RENDERING → READY, uploading the output", async () => {
    const videoId = await makeRenderableVideo();
    const updateSpy = vi.spyOn(prisma.renderJob, "update");
    const { spawner } = createSucceedingSpawner();
    const service = new RenderService(spawner);

    const result = await service.render(userId, videoId);

    expect(result.durationSeconds).toBe(2);
    // The finished MP4 now lands in Vercel Blob (see blob-render-storage.ts),
    // not local disk — outputUrl is the same value RenderJob.outputUrl stores.
    expect(result.outputUrl).toContain(renderBlobPathname(videoId));

    const written = await getRenderFile(videoId, result.outputUrl);
    expect(written).not.toBeNull();
    const writtenBytes = await new Response(written!.stream).text();
    expect(writtenBytes).toBe("fake-rendered-mp4-bytes");

    // The job passed through RUNNING on its way to SUCCEEDED — RenderJob's
    // schema default is QUEUED, so combined with the final status below this
    // covers the full QUEUED → RUNNING → SUCCEEDED path.
    const statusesWritten = updateSpy.mock.calls
      .map((call) => (call[0] as { data?: { status?: string } }).data?.status)
      .filter(Boolean);
    expect(statusesWritten).toContain("RUNNING");

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.progress).toBe(100);
    expect(job.outputUrl).toBe(result.outputUrl);
    expect(job.startedAt).toBeTruthy();
    expect(job.finishedAt).toBeTruthy();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");

    const events = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { createdAt: "asc" },
    });
    const transitions = events.map((e) => `${e.from}->${e.to}`);
    expect(transitions).toContain("GENERATING->RENDERING");
    expect(transitions).toContain("RENDERING->READY");

    const uploaded = await prisma.asset.count(); // sanity: no crash reading DB post-render
    expect(uploaded).toBeGreaterThanOrEqual(0);
  });

  it("stretches the clips it has over the whole narration instead of repeating them", async () => {
    // A video with no cues has no section boundaries to cut on, so its clips
    // divide the narration evenly — one clip, one 30s slot. The old fixed
    // 12s slot would have needed the list repeated three times to reach the
    // end; anything short of the end and `-shortest` silently truncates the
    // output mid-sentence.
    const videoId = await makeRenderableVideo({ durationSeconds: 30, clipCount: 1 });

    // The concat list has to be read while FFmpeg would be running: render()
    // deletes its temp directory on the way out, so reading afterwards finds
    // nothing.
    let concatList = "";
    const { spawner, calls } = createSpawner(async (child, args) => {
      const formatIndex = args.indexOf("-f");
      if (formatIndex !== -1 && args[formatIndex + 1] === "concat") {
        concatList = await readFile(args[args.indexOf("-i") + 1], "utf-8");
      }
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    const service = new RenderService(spawner);

    await service.render(userId, videoId);

    // One clip, one segment pass, and it opens that clip exactly once —
    // opening a decoder per slot is what OOM-killed the worker.
    const segmentCalls = calls.filter((call) => call.args.includes("-vf"));
    expect(segmentCalls).toHaveLength(1);
    for (const segment of segmentCalls) {
      const clipInputs = segment.args.filter(
        (arg, index) => segment.args[index - 1] === "-i" && arg.endsWith("clip-0.mp4"),
      );
      expect(clipInputs).toHaveLength(1);
    }

    // That single slot covers the whole narration; `-stream_loop -1` is what
    // fills 30 seconds from a shorter clip.
    expect(segmentCalls[0].args[segmentCalls[0].args.indexOf("-t") + 1]).toBe("30");

    // The assemble pass opens the list, not the clips.
    const assemble = calls.at(-1)!;
    expect(assemble.args[assemble.args.indexOf("-f") + 1]).toBe("concat");

    // Each `file` line may be followed by inpoint/outpoint directives, so
    // count the file lines rather than every line. One clip means one entry
    // and no boundary for a stub to sit on.
    const fileLines = concatList
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("file "));

    expect(fileLines.filter((line) => line.includes("segment-"))).toHaveLength(1);
    expect(fileLines.filter((line) => line.includes("stub-"))).toHaveLength(0);
  });

  it("divides the narration evenly between the clips of a video with no cues", async () => {
    const videoId = await makeRenderableVideo({ durationSeconds: 30, clipCount: 3 });

    const { spawner, calls } = createSpawner(async (child, args) => {
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });

    await new RenderService(spawner).render(userId, videoId);

    // 30s over three clips. The first two are generated half a second longer
    // than their slot because they donate that tail to the crossfade after
    // them (see planRender) — what must hold is that no clip is favoured.
    const slots = segmentSeconds(calls);
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBeCloseTo(10.5, 5);
    expect(slots[1]).toBeCloseTo(10.5, 5);
    expect(slots[2]).toBeCloseTo(10, 5);
  });

  it("plays a no-cue video's clips in path order, not in the order they were stored", async () => {
    // This is the path the clip query's ordering actually decides: with no
    // cues there is no section-to-clip mapping, so the query alone determines
    // which clips survive the cap and what order they play in. Re-fetch one
    // clip of a legacy video and insertion order changes; the paths do not.
    const videoId = await makeRenderableVideo({
      durationSeconds: 30,
      clipCount: 3,
      reverseInsertion: true,
    });

    // Temp clip filenames only carry position, so read the bytes each segment
    // pass actually opened — those are unique per clip.
    const opened: string[] = [];
    const { spawner } = createSpawner(async (child, args) => {
      if (args.includes("-vf")) {
        opened.push(await readFile(args[args.indexOf("-i") + 1], "utf-8"));
      }
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });

    await new RenderService(spawner).render(userId, videoId);

    expect(opened).toEqual([
      `fake-clip-0-${RUN}`,
      `fake-clip-1-${RUN}`,
      `fake-clip-2-${RUN}`,
    ]);
  });

  it("writes progress as parsed FFmpeg output advances, throttled to at most one write per second", async () => {
    const videoId = await makeRenderableVideo({ durationSeconds: 2 });
    const updateSpy = vi.spyOn(prisma.renderJob, "update");

    const { spawner } = createSpawner(async (child, args) => {
      const outputPath = args[args.length - 1];

      // Only the assemble pass reports a percentage; the segment passes run
      // with no duration to measure against. Emitting progress for them here
      // would test a path production never takes.
      if (!args.includes("-progress")) {
        await writeFile(outputPath, "fake-segment-bytes");
        child.emit("close", 0);
        return;
      }

      // Two lines in immediate succession: only the first should produce a
      // write, the second falls inside the same throttle window.
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.3 * 1_000_000)}\n`);
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.35 * 1_000_000)}\n`);
      await sleep(1100); // clear the 1s throttle window
      child.stdout.emit("data", `out_time_ms=${Math.round(2 * 0.9 * 1_000_000)}\n`);
      await writeFile(outputPath, "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    const service = new RenderService(spawner);

    await service.render(userId, videoId);

    const progressWrites = updateSpy.mock.calls
      .map((call) => (call[0] as { data?: { progress?: number } }).data?.progress)
      .filter((value): value is number => typeof value === "number");

    // Exactly two real writes: the throttled-down first burst, and the one
    // after the window passed. The forced 100% on success goes through a
    // transaction client (tx.renderJob.update), a different object from the
    // one spied on here, so it never appears in this list.
    expect(progressWrites.length).toBe(2);
    expect(progressWrites[0]).toBeGreaterThan(0);
    expect(progressWrites[0]).toBeLessThan(50);
    expect(progressWrites[1]).toBeGreaterThan(progressWrites[0]);
    expect(progressWrites[1]).toBeLessThan(100);

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.progress).toBe(100);
  });
});

describe("renderService.render — cut on the sentence", () => {
  /** A spawner that succeeds, recording what each pass was given. */
  function recordingSpawner() {
    return createSpawner(async (child, args) => {
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
  }

  it("gives each section a segment as long as that section is spoken", async () => {
    const { videoId, content, durationSeconds } = await makeRenderableVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
      { anchor: "second section opening words here", cue: "cash" },
    ]);

    const { spawner, calls } = recordingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    // Where the second section's first word is spoken — the boundary the
    // picture has to cut on.
    const boundary = content.indexOf("second section opening words here") * SECONDS_PER_CHAR;

    const slots = segmentSeconds(calls);
    expect(slots).toHaveLength(2);
    // The first slot runs from zero to the boundary, plus the half-second it
    // donates to the crossfade after it (see planRender). The second runs
    // from the boundary to the end of the narration.
    expect(slots[0]).toBeCloseTo(boundary + 0.5, 5);
    expect(slots[1]).toBeCloseTo(durationSeconds - boundary, 5);
    // Two sections, two segments, and their lengths differ because the
    // sections take different times to say.
    expect(new Set(slots).size).toBe(2);
  });

  it("cuts on the same second whether or not the stored script has leading whitespace", async () => {
    // The single invariant the timing model rests on: character offsets are
    // only convertible to times because the alignment indexes exactly what
    // ElevenLabs was sent, and voiceover.service.ts sends `content.trim()`.
    // Anchoring against the untrimmed column shifts every offset by the
    // leading whitespace — a tenth of a second of picture per character,
    // playing against the wrong words for the rest of the video.
    const { videoId, content } = await makeRenderableVideoWithCues(
      [
        { anchor: "first section opening words here", cue: "money" },
        { anchor: "second section opening words here", cue: "cash" },
      ],
      { leadingWhitespace: "\n\n  " },
    );

    const { spawner, calls } = recordingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const boundary = content.indexOf("second section opening words here") * SECONDS_PER_CHAR;
    const slots = segmentSeconds(calls);

    expect(slots[0]).toBeCloseTo(boundary + 0.5, 5);
  });

  it("covers the narration exactly, no matter how the sections divide it", async () => {
    const { videoId, durationSeconds } = await makeRenderableVideoWithCues([
      { anchor: "opening section words appear right here", cue: "sunrise" },
      { anchor: "middle section words appear right here", cue: "traffic" },
      { anchor: "closing section words appear right here", cue: "sunset" },
    ]);

    const { spawner, calls } = recordingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    // Every segment but the last is generated a crossfade longer than its
    // slot and gives that tail back at the boundary, so the timeline is the
    // sources minus one overlap per boundary. That total is what has to equal
    // the narration: short, and `-shortest` cuts the last words off; long, and
    // the picture runs on past them.
    const slots = segmentSeconds(calls);
    const donated = (slots.length - 1) * 0.5;
    const timeline = slots.reduce((sum, seconds) => sum + seconds, 0) - donated;

    expect(slots).toHaveLength(3);
    expect(timeline).toBeCloseTo(durationSeconds, 5);
  });

  it("keeps a section too short to encode from stealing time from the rest", async () => {
    // The middle section is its anchor alone — under a second of narration,
    // which FFmpeg cannot turn into a usable segment. Widening it has to be
    // paid for by the section after it, not added to the timeline: the
    // assemble pass cuts the output at the narration's length either way, so
    // a longer total does not show up as a longer video, it shows up as every
    // later section running late against its own words.
    const { videoId, content, durationSeconds } = await makeRenderableVideoWithCues(
      [
        { anchor: "opening section words appear right here", cue: "sunrise" },
        { anchor: "blink", cue: "traffic" },
        { anchor: "closing section words appear right here", cue: "sunset" },
      ],
      { fillerWords: [8, 0, 8] },
    );

    const { spawner, calls } = recordingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const slots = segmentSeconds(calls);
    const timeline = slots.reduce((sum, seconds) => sum + seconds, 0) - (slots.length - 1) * 0.5;

    // The floor fired (the section is spoken in 0.6s), and the total is still
    // the narration exactly.
    expect(slots[1]).toBeCloseTo(1 + 0.5, 5);
    expect(timeline).toBeCloseTo(durationSeconds, 5);

    // Paid for by the following section alone: the one before it still runs
    // for exactly as long as it is spoken.
    const boundary = content.indexOf("blink") * SECONDS_PER_CHAR;
    expect(slots[0]).toBeCloseTo(boundary + 0.5, 5);
    // And the last section gives up only the shortfall, nothing more.
    expect(slots[2]).toBeCloseTo(durationSeconds - boundary - 1, 5);
  });

  it("refuses to render when a section in the middle has no footage", async () => {
    // The defect this whole feature exists to prevent: FFmpeg would happily
    // play two clips over three sections, every later section sliding forward
    // into the gap, and the result is a finished video whose picture is
    // seconds ahead of its words.
    const { videoId } = await makeRenderableVideoWithCues(
      [
        { anchor: "opening section words appear right here", cue: "sunrise" },
        { anchor: "middle section words appear right here", cue: "traffic" },
        { anchor: "closing section words appear right here", cue: "sunset" },
      ],
      { skipSections: [1] },
    );

    const { spawner, calls } = recordingSpawner();

    await expect(new RenderService(spawner).render(userId, videoId)).rejects.toThrow(
      ConflictError,
    );
    // Named, so the operator knows which section to collect again.
    await expect(
      new RenderService(spawner).render(userId, videoId),
    ).rejects.toThrow(/section\(s\) 2 of 3/);

    // Refused before anything was spawned or the video was moved, so
    // collecting the missing clip and rendering again is all it takes.
    expect(calls).toHaveLength(0);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("GENERATING");
    expect(await prisma.renderJob.count({ where: { videoId } })).toBe(0);
  });

  it("falls back to even slots when a cued video's footage predates per-section clips", async () => {
    // Cues exist, but the clips on disk are the old topic-level pool — a
    // video collected in the window between the two features. There is no
    // section-to-clip mapping to honour, so this is a no-cues render, not a
    // failed one.
    const { videoId, durationSeconds } = await makeRenderableVideoWithCues(
      [
        { anchor: "opening section words appear right here", cue: "sunrise" },
        { anchor: "closing section words appear right here", cue: "sunset" },
      ],
      { topicNamedClips: true },
    );

    const { spawner, calls } = recordingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const slots = segmentSeconds(calls);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toBeCloseTo(durationSeconds / 2 + 0.5, 5);
    expect(slots[1]).toBeCloseTo(durationSeconds / 2, 5);
  });
});

describe("renderService.render — failure path", () => {
  it("sets the RenderJob FAILED, batches stderr into one RenderLog, and fails the video", async () => {
    const videoId = await makeRenderableVideo();
    const { spawner } = createSpawner(async (child) => {
      // Two stderr chunks arriving close together must land as one RenderLog
      // row, not one row per line/chunk.
      child.stderr.emit("data", "ffmpeg: error: something broke\n");
      child.stderr.emit("data", "additional detail line\n");
      child.emit("close", 1);
    });
    const service = new RenderService(spawner);

    await expect(service.render(userId, videoId)).rejects.toThrow(/exited with code 1/);

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("exited with code 1");
    expect(job.finishedAt).toBeTruthy();

    const logs = await prisma.renderLog.findMany({ where: { renderJobId: job.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("something broke");
    expect(logs[0].message).toContain("additional detail line");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.failureReason).toContain("exited with code 1");

    const events = await prisma.videoStatusEvent.findMany({
      where: { videoId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("RENDERING->FAILED");
  });

  it("names the signal and still flushes captured stderr when ffmpeg is killed rather than exiting", async () => {
    // Mirrors what an OOM-killed ffmpeg looks like to Node: `close` fires
    // with code null and a signal, not a normal exit code. See
    // render-oom-report.md — this is exactly what silently produced
    // `RenderJob.error: "terminated"` with an empty RenderLog before the fix.
    const videoId = await makeRenderableVideo();
    const { spawner } = createSpawner(async (child) => {
      child.stderr.emit("data", "some output written before the kill\n");
      child.emit("close", null, "SIGKILL");
    });
    const service = new RenderService(spawner);

    await expect(service.render(userId, videoId)).rejects.toThrow(/killed by signal SIGKILL/);

    const job = await prisma.renderJob.findFirstOrThrow({ where: { videoId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("killed by signal SIGKILL");

    const logs = await prisma.renderLog.findMany({ where: { renderJobId: job.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("some output written before the kill");
  });
});

describe("renderService.render — concurrency", () => {
  it("refuses a second concurrent render for the same video; only one succeeds", async () => {
    const videoId = await makeRenderableVideo();

    const results = await Promise.allSettled([
      new RenderService(createSucceedingSpawner().spawner).render(userId, videoId),
      new RenderService(createSucceedingSpawner().spawner).render(userId, videoId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);

    // Only the winner ever created a RenderJob — the loser's transaction
    // rolled back before reaching RenderJob.create.
    const jobs = await prisma.renderJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("SUCCEEDED");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
  });
});
