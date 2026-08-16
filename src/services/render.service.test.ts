import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteRenderFile, getRenderFile, renderPath } from "@/lib/render-storage";
import type { Alignment } from "@/lib/captions";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { anchorCues } from "@/lib/script-cues";
import { putObject, storagePath } from "@/lib/storage";
import { planStoryBeats } from "@/lib/story-beats";
import { DEFAULT_STYLE } from "@/lib/video-style";
import type { Prisma } from "@/generated/prisma/client";
import { MusicService } from "@/services/music.service";
import type { MusicProvider } from "@/services/providers/types";
import { projectService } from "@/services/project.service";
import type { ProcessSpawner } from "@/services/render.service";
import { RenderService } from "@/services/render.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database and the real storage root (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts). FFmpeg itself never runs: the process spawner
// is injected everywhere below (per RenderService's constructor), following
// the same injection shape as ScriptService's provider and
// VoiceOverService's provider.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-render-${RUN}`;

// Several tests wait out the real 1s progress-write throttle and/or make
// several sequential storage round trips against a live bucket, on top of a
// real write to the local render store (see render-storage.ts's
// writeRenderFile) each "happy path" test now makes. 60s leaves real margin
// over Vitest's 5s default for tests this file's own network-bound fixtures
// already needed a bumped timeout for.
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

/** Every video id `makeRenderableVideo` hands out, so the file a successful
 * render leaves behind (see render-storage.ts) is cleaned up alongside the
 * test user rather than accumulating under RENDER_ROOT across test runs.
 * Deleted by the deterministic path (`renderPath`), not a captured
 * `outputUrl` — every test id lands here regardless of whether its render
 * actually got as far as `writeRenderFile`, and deleting a path that was
 * never written is nothing to clean up, hence the `.catch`. */
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
    videoIds.map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
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
    /** What the operator approved at Gate 1. Absent means LANDSCAPE, which is
     *  what every video in this file was before formats existed. */
    format?: "LANDSCAPE" | "VERTICAL";
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

  await prisma.video.update({
    where: { id: video.id },
    data: { status: "GENERATING", format: opts.format ?? "LANDSCAPE" },
  });

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

/**
 * Connects a fresh `Channel` to `videoId`'s project and gives that channel a
 * `ChannelBrand` row — the arrangement `render()` reads its style and music
 * query from once Task 10 wires `brandService.resolve` in, in place of
 * `DEFAULT_STYLE` and the video's own title.
 *
 * The channel is created under the test's own `userId` (not a
 * `findFirstOrThrow` against whatever channel exists — see fixtures.ts's
 * warning) and both it and its brand cascade-delete with the test user, so
 * nothing extra needs cleaning up in `afterEach` beyond what already runs.
 */
async function assignChannelWithBrand(
  videoId: string,
  brand: {
    videoStyle?: Prisma.InputJsonValue;
    musicQuery?: string;
    tone?: string;
    niche?: string;
    primaryColour?: string;
    secondaryColour?: string;
    headlineFont?: string;
    logoPath?: string;
  } = {},
): Promise<string> {
  const video = await prisma.video.findUniqueOrThrow({
    where: { id: videoId },
    select: { projectId: true },
  });

  const channel = await prisma.channel.create({
    data: {
      userId,
      youtubeChannelId: `UC-brand-${randomUUID()}`,
      title: "Test brand channel",
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    },
  });

  await prisma.project.update({
    where: { id: video.projectId },
    data: { channelId: channel.id },
  });

  await prisma.channelBrand.create({ data: { channelId: channel.id, ...brand } });

  return channel.id;
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
    /** Store generated beat illustrations instead of per-section clips, as an
     *  ILLUSTRATED channel's collection run leaves behind. `skipBeats` omits
     *  one, which is what a refused generation looks like on disk. */
    illustrated?: { skipBeats?: number[] };
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

  await prisma.video.update({
    where: { id: video.id },
    data: { status: "GENERATING" },
  });

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

  if (options.illustrated) {
    // The same grouping `FootageService` would have reached, from the same two
    // inputs — which is the invariant the illustrated render path rests on.
    const beats = planStoryBeats(
      anchorCues(cues, content).anchored,
      durationSeconds,
    );
    const skip = new Set(options.illustrated.skipBeats ?? []);

    for (let index = 0; index < beats.length; index += 1) {
      if (skip.has(index)) continue;
      const beatPath = storagePath(video.id, "beats", `beat-${String(index).padStart(3, "0")}.png`);
      await putObject(beatPath, Buffer.from(`fake-beat-${index}-${RUN}`), "image/png");
      await prisma.asset.create({
        data: {
          kind: "IMAGE",
          storagePath: beatPath,
          provider: "OPENAI",
          externalId: "openai/gpt-image-2",
        },
      });
    }

    renderedVideoIds.push(video.id);
    return { videoId: video.id, content, durationSeconds };
  }

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
    // The finished MP4 lands on local disk under RENDER_ROOT (see
    // render-storage.ts) — outputUrl is the same value RenderJob.outputUrl
    // stores, now a path rather than a URL.
    expect(result.outputUrl).toBe(renderPath(videoId));

    const written = await getRenderFile(videoId, result.outputUrl);
    if (written === null || written === "unsatisfiable") {
      throw new Error(`Expected render file content, got ${JSON.stringify(written)}`);
    }
    const writtenBytes = await new Response(written.stream).text();
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

describe("renderService.render — output format", () => {
  /** The picture filter of every segment pass, in play order. */
  function segmentFilters(calls: SpawnCall[]): string[] {
    return calls
      .filter((call) => call.args.includes("-vf"))
      .map((call) => call.args[call.args.indexOf("-vf") + 1]);
  }

  function assembleGraph(calls: SpawnCall[]): string {
    const assemble = calls.filter((call) => call.args.includes("-filter_complex"));
    const last = assemble[assemble.length - 1];
    return last.args[last.args.indexOf("-filter_complex") + 1];
  }

  it("normalises every clip into a 1080x1920 frame for a vertical video", async () => {
    const videoId = await makeRenderableVideo({ format: "VERTICAL" });
    const { spawner, calls } = createSucceedingSpawner();

    await new RenderService(spawner).render(userId, videoId);

    const filters = segmentFilters(calls);
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      // Composed at 9:16 from the source clip, not cropped out of a landscape
      // frame afterwards.
      expect(filter).toContain("crop=w=1080:h=1920");
    }
  });

  it("sizes a vertical video's captions for the frame it is actually in", async () => {
    const videoId = await makeRenderableVideo({ format: "VERTICAL" });
    const { spawner, calls } = createSucceedingSpawner();

    await new RenderService(spawner).render(userId, videoId);

    // The same measured geometry a short uses — margins that clear YouTube's
    // action rail, a marginV floor that clears its bottom chrome. A 1080x1920
    // full render is in exactly the same frame as a 1080x1920 short.
    const graph = assembleGraph(calls);
    expect(graph).toContain("MarginL=60");
    expect(graph).toContain("MarginR=60");
    expect(graph).toContain("MarginV=68");
  });

  it("leaves a landscape render exactly as it was", async () => {
    // The compatibility claim, checked against the real service rather than
    // against `buildSegmentArgs` alone: no horizontal margins, no vertical
    // frame, nothing new in the command line at all.
    const videoId = await makeRenderableVideo();
    const { spawner, calls } = createSucceedingSpawner();

    await new RenderService(spawner).render(userId, videoId);

    for (const filter of segmentFilters(calls)) {
      expect(filter).toContain("1920");
      expect(filter).not.toContain("crop=w=1080:h=1920");
    }

    const graph = assembleGraph(calls);
    expect(graph).not.toContain("MarginL");
    expect(graph).not.toContain("MarginR");
  });

  it("still cuts the picture to the narration and lands a playable file", async () => {
    // A vertical render is a whole video, not a clip: same statuses, same
    // RenderJob, same file on disk. Publishing reads that file and knows
    // nothing about the shape of its frames.
    const videoId = await makeRenderableVideo({ format: "VERTICAL" });
    const { spawner } = createSucceedingSpawner();

    const result = await new RenderService(spawner).render(userId, videoId);

    expect(result.outputUrl).toBe(renderPath(videoId));
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
    expect(video.format).toBe("VERTICAL");
  });
});

describe("renderService.render — channel brand", () => {
  it("renders with the channel's own style, not the default", async () => {
    // Two clips so there is a crossfade to inspect at all — a single-clip
    // render (see the "stretches the clips" test above) never calls
    // buildTransitionArgs.
    const videoId = await makeRenderableVideo();
    await assignChannelWithBrand(videoId, {
      videoStyle: { transitions: { durationSeconds: 0.25 } },
    });

    const { spawner, calls } = createSpawner(async (child, args) => {
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    await new RenderService(spawner).render(userId, videoId);

    // A stub is built at the brand's crossfade length (0.25s), not
    // DEFAULT_STYLE's (0.5s, asserted distinctly below).
    expect(DEFAULT_STYLE.transitions.durationSeconds).not.toBe(0.25);
    const stub = calls.find((call) => call.args.join(" ").includes("xfade"));
    expect(stub!.args.join(" ")).toContain("duration=0.25");
  });

  it("searches for music the channel chose, not the video's title", async () => {
    // A title is not a musical description — searching Jamendo for "Render
    // fixture video" (makeRenderableVideo's title) is the same class of bug
    // that searching "Ada Lovelace wrote the first program" was: a real
    // render that found no usable bed. MusicService is injected into
    // RenderService here so this test can see the query without a live
    // Jamendo account or a live bucket.
    const videoId = await makeRenderableVideo();
    await assignChannelWithBrand(videoId, { musicQuery: "calm ambient documentary" });

    const search = vi.fn().mockResolvedValue([]);
    const music = new MusicService({ search } as MusicProvider);
    const { spawner } = createSucceedingSpawner();

    await new RenderService(spawner, music).render(userId, videoId);

    // Asked more than once because this fake answers empty every time, and an
    // empty answer from Jamendo is retried rather than believed (see
    // SEARCH_ATTEMPTS in music.service.ts). What this test is about is the
    // *query*, so every attempt has to carry the channel's own.
    expect(search).toHaveBeenCalledTimes(3);
    for (const call of search.mock.calls) {
      expect(call[0]).toBe("calm ambient documentary");
    }
  });

  it("falls back to defaults for a video whose project has no channel", async () => {
    // Every existing video — no `assignChannelWithBrand` call at all here —
    // must keep rendering exactly as it does today: brandService.resolve
    // sees `channelId: null` and returns DEFAULT_STYLE untouched, so the
    // crossfade stub still builds at DEFAULT_STYLE's own duration rather
    // than something a stray brand lookup invented.
    const videoId = await makeRenderableVideo();

    const { spawner, calls } = createSpawner(async (child, args) => {
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    await new RenderService(spawner).render(userId, videoId);

    const stub = calls.find((call) => call.args.join(" ").includes("xfade"));
    expect(stub!.args.join(" ")).toContain(
      `duration=${DEFAULT_STYLE.transitions.durationSeconds}`,
    );
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

  it("keeps later sound effects on their cuts when a transition stub fails", async () => {
    // A stub that cannot be built becomes a hard cut, and the segment keeps
    // the tail it would have donated — so half a second is played at that
    // boundary either way. Counting it only when the stub survived put every
    // later whoosh half a second early, once per failed stub. Sections are
    // deliberately long here (~30s) because planSfxCues thins cues that fall
    // too close together, so a short fixture would have no later whoosh left
    // to measure.
    const { videoId } = await makeRenderableVideoWithCues(
      [
        { anchor: "opening section words appear right here", cue: "sunrise" },
        { anchor: "middle section words appear right here", cue: "traffic" },
        { anchor: "closing section words appear right here", cue: "sunset" },
      ],
      { fillerWords: [45, 45, 45] },
    );

    // Fails only the first crossfade — the second still builds, so its whoosh
    // is the one whose position the drift would have moved.
    const { spawner, calls } = createSpawner(async (child, args) => {
      const outputPath = args[args.length - 1];
      if (outputPath.endsWith("stub-0.mp4")) {
        child.emit("close", 1);
        return;
      }
      await writeFile(outputPath, "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    await new RenderService(spawner).render(userId, videoId);

    // Each segment is generated a crossfade longer than its slot; the played
    // length of the first two, plus the half second at the boundary between
    // them, is where the second boundary lands.
    const sources = segmentSeconds(calls);
    const secondBoundary = sources[0] + sources[1] - 1;

    const sfxCall = calls.find((call) =>
      call.args.some((arg) => arg.includes("adelay")),
    );
    const graph = sfxCall!.args[sfxCall!.args.indexOf("-filter_complex") + 1];

    expect(graph).toContain(`adelay=${Math.round(secondBoundary * 1000)}:all=1`);
  });

  it("blames the script, not the crossfade, when there are more sections than seconds", async () => {
    // Six sections over two seconds of narration. No arrangement gives them
    // all the floor, so the slots come out as equal shares of a third of a
    // second — shorter than the half-second transition each has to make room
    // for. planRender would refuse this too, but only in terms of what it was
    // handed ("clip 3 is 0.33s, shorter than the 0.5s transition"), which
    // tells the operator nothing about the script that caused it.
    const { videoId } = await makeRenderableVideoWithCues(
      [
        { anchor: "aa", cue: "one" },
        { anchor: "bb", cue: "two" },
        { anchor: "cc", cue: "three" },
        { anchor: "dd", cue: "four" },
        { anchor: "ee", cue: "five" },
        { anchor: "ff", cue: "six" },
      ],
      { fillerWords: [0, 0, 0, 0, 0, 0] },
    );

    const { spawner } = recordingSpawner();
    const attempt = new RenderService(spawner).render(userId, videoId);

    await expect(attempt).rejects.toThrow(ConflictError);
    await expect(attempt).rejects.toThrow(/6 sections/);
    await expect(attempt).rejects.toThrow(/Edit the script/);
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

describe("renderService.render — illustrated videos", () => {
  /** Twelve sections is a real script's shape; `planStoryBeats` turns them
   *  into far fewer pictures, and the arithmetic is what these tests check
   *  reaches FFmpeg intact. */
  const CUES = Array.from({ length: 12 }, (_cue, index) => ({
    anchor: `Section number ${index} opens`,
    cue: `scene ${index}`,
  }));

  it("plays one still per beat, each held for as long as its sections are spoken", async () => {
    const { videoId, content, durationSeconds } = await makeRenderableVideoWithCues(CUES, {
      illustrated: {},
    });

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const expected = planStoryBeats(anchorCues(CUES, content).anchored, durationSeconds);
    const slots = segmentSeconds(calls);

    // One segment pass per beat, and far fewer of them than there are
    // sections — twelve sections became six pictures.
    expect(slots).toHaveLength(expected.length);
    expect(slots.length).toBeLessThan(CUES.length);

    // And they still cover the narration exactly. Every segment but the last
    // is generated a crossfade longer than its slot because it donates that
    // tail to the stub after it (see planRender), so the donations come back
    // off before the sum means anything.
    const overlap = DEFAULT_STYLE.transitions.durationSeconds;
    const total = slots.reduce((sum, seconds) => sum + seconds, 0) - overlap * (slots.length - 1);
    expect(total).toBeCloseTo(durationSeconds, 5);
  });

  it("opens each picture with -loop 1, never -stream_loop", async () => {
    // A PNG has no stream to rewind: `-stream_loop -1` would give every beat a
    // one-frame segment whatever `-t` said.
    const { videoId } = await makeRenderableVideoWithCues(CUES, { illustrated: {} });

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const segments = calls.filter((call) => call.args.includes("-vf"));
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.args).toContain("-loop");
      expect(segment.args).not.toContain("-stream_loop");
      expect(segment.args.some((arg) => arg.endsWith(".png"))).toBe(true);
    }
  });

  it("pans across every still, because the motion comes from the renderer", async () => {
    const { videoId } = await makeRenderableVideoWithCues(CUES, { illustrated: {} });

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    for (const segment of calls.filter((call) => call.args.includes("-vf"))) {
      const filter = segment.args[segment.args.indexOf("-vf") + 1];
      // The animated second crop is the pan — see PAN_EXPRESSIONS.
      expect(filter).toContain("crop=w=1920:h=1080");
      expect(filter).toContain("t/");
    }
  });

  it("refuses rather than rendering a video with a beat that has no picture", async () => {
    // The gap has to be named. FFmpeg would happily play what it was given,
    // every later beat sliding forward into the hole, and the result is a
    // finished video whose picture runs ahead of its words from the middle on.
    const { videoId } = await makeRenderableVideoWithCues(CUES, {
      illustrated: { skipBeats: [1] },
    });

    await expect(
      new RenderService(createSucceedingSpawner().spawner).render(userId, videoId),
    ).rejects.toThrow(/No picture for beat\(s\) 2 of/);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    // Refused before the status gate, so the video is still renderable once
    // the missing beat is drawn.
    expect(video.status).toBe("GENERATING");
  });

  it("composes a vertical illustrated video into the vertical frame", async () => {
    const { videoId } = await makeRenderableVideoWithCues(CUES, { illustrated: {} });
    await prisma.video.update({ where: { id: videoId }, data: { format: "VERTICAL" } });

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    for (const segment of calls.filter((call) => call.args.includes("-vf"))) {
      const filter = segment.args[segment.args.indexOf("-vf") + 1];
      expect(filter).toContain("crop=w=1080:h=1920");
    }
  });

  it("leaves a stock-footage video on the arguments it always had", async () => {
    // The safety property, stated as the two things that could have changed:
    // the illustrated path must not make a LIVE_ACTION video's clips open as
    // stills, and it must not regroup its sections into beats. Every other
    // test in this file is the rest of that assertion — they all run the same
    // path and all still pass.
    const { videoId } = await makeRenderableVideoWithCues(CUES);

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    const segments = calls.filter((call) => call.args.includes("-vf"));
    // One clip per section, not one per beat.
    expect(segments).toHaveLength(CUES.length);

    for (const segment of segments) {
      expect(segment.args).toContain("-stream_loop");
      expect(segment.args).not.toContain("-loop");
      expect(segment.args).not.toContain("-framerate");
      expect(segment.args.some((arg) => arg.endsWith(".png"))).toBe(false);
    }
  });
});

/**
 * The bed has to reach FFmpeg, on every branch.
 *
 * This file already asserted that the channel's *query* reaches
 * `MusicService.search` — and it passed, unbroken, through ten consecutive
 * renders that shipped with no music at all. That assertion stops one step too
 * early: it mocks the search to return `[]`, so the only path it can describe
 * is the one where there is no bed. Nothing anywhere checked that a bed which
 * *was* collected turns into an FFmpeg input, which is the step a refactor can
 * silently drop and which is the difference an operator can hear.
 *
 * These run the real `musicService` against a bed already in storage — the
 * reuse branch of `collectTrack`, no Jamendo account and no network — so what
 * is exercised is the whole path from the Asset row to the argv.
 */
describe("renderService.render — background music", () => {
  /** A bed already collected for this video, which `MusicService.collect`
   *  reuses rather than re-fetching. */
  async function giveVideoABed(videoId: string): Promise<void> {
    const bedPath = storagePath(videoId, "music", "bed.mp3");
    await putObject(bedPath, Buffer.from(`fake-bed-${RUN}`), "audio/mpeg");
    await prisma.asset.create({
      data: { kind: "MUSIC", storagePath: bedPath, mimeType: "audio/mpeg", provider: "JAMENDO" },
    });
  }

  /** The assemble pass — the only run that reads the concat list, hence
   *  `-safe`. The segment passes carry `-stream_loop` too, so filtering on
   *  that alone would match the wrong call. */
  function assembleCall(calls: SpawnCall[]): SpawnCall {
    const assemble = calls.filter((call) => call.args.includes("-safe"));
    expect(assemble).toHaveLength(1);
    return assemble[0];
  }

  /** What the bed contributes to the assemble argv: its own looped input, the
   *  gain stage, the ducking that keeps it under the words, and a third mix
   *  input. Asserted together because any one of them alone can be present
   *  while the audience still hears nothing. */
  function expectBedIsMixedIn(call: SpawnCall): void {
    // `-stream_loop -1 -i <path>`: three tokens on from the flag.
    const musicInput = call.args[call.args.indexOf("-stream_loop") + 3];
    expect(musicInput).toMatch(/music\.mp3$/);

    const graph = call.args[call.args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[bed]");
    expect(graph).toContain("sidechaincompress");
    // Narration, bed, effects. Two would mean the bed never joined the mix.
    expect(graph).toContain("amix=inputs=3");
  }

  it("mixes the bed into a landscape render", async () => {
    const videoId = await makeRenderableVideo();
    await giveVideoABed(videoId);

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    expectBedIsMixedIn(assembleCall(calls));
  });

  it("mixes the bed into a vertical render", async () => {
    // Vertical differs from landscape in the frame and the caption geometry
    // and in nothing else — the audio mix is meant to be identical, which is
    // exactly the kind of "obviously unchanged" that goes unchecked.
    const videoId = await makeRenderableVideo({ format: "VERTICAL" });
    await giveVideoABed(videoId);

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    expectBedIsMixedIn(assembleCall(calls));
  });

  it("mixes the bed into an illustrated render", async () => {
    const cues = Array.from({ length: 12 }, (_cue, index) => ({
      anchor: `Section number ${index} opens`,
      cue: `scene ${index}`,
    }));
    const { videoId } = await makeRenderableVideoWithCues(cues, { illustrated: {} });
    await giveVideoABed(videoId);

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    expectBedIsMixedIn(assembleCall(calls));
  });

  it("mixes the bed into a vertical illustrated render", async () => {
    const cues = Array.from({ length: 12 }, (_cue, index) => ({
      anchor: `Section number ${index} opens`,
      cue: `scene ${index}`,
    }));
    const { videoId } = await makeRenderableVideoWithCues(cues, { illustrated: {} });
    await prisma.video.update({ where: { id: videoId }, data: { format: "VERTICAL" } });
    await giveVideoABed(videoId);

    const { spawner, calls } = createSucceedingSpawner();
    await new RenderService(spawner).render(userId, videoId);

    expectBedIsMixedIn(assembleCall(calls));
  });

  it("renders without a bed, and says why, when none could be collected", async () => {
    // Both halves matter and they pull in opposite directions: the render must
    // still finish (music is an enhancement), and it must stop finishing
    // *quietly* (ten videos shipped with no music and nothing said so).
    const videoId = await makeRenderableVideo();
    await assignChannelWithBrand(videoId, { musicQuery: "nothing matches this" });

    const music = new MusicService({ search: async () => [] } as MusicProvider);
    const { spawner, calls } = createSucceedingSpawner();

    const result = await new RenderService(spawner, music).render(userId, videoId);

    expect(result.outputUrl).toBeTruthy();
    expect(assembleCall(calls).args).not.toContain("-stream_loop");

    // On the video page, not only in the worker's stdout — see
    // PipelineService.getLogStream.
    const warning = await prisma.renderLog.findFirst({
      where: { renderJob: { videoId }, level: "WARN" },
      select: { message: true },
    });

    expect(warning?.message).toContain("No background music");
    expect(warning?.message).toContain("nothing matches this");
  });
});
