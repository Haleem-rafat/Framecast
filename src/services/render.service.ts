import "server-only";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { ConflictError, InternalError, NotFoundError } from "@/lib/errors";
import { buildRenderArgs } from "@/lib/ffmpeg-command";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, storagePath } from "@/lib/storage";
import { formatElapsed } from "@/utils/format";

/** Injectable so tests never spawn a real `ffmpeg` process. */
export type ProcessSpawner = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

export interface RenderResult {
  outputPath: string;
  durationSeconds: number;
}

/**
 * Reports a human-readable line as the render advances. See
 * `FootageProgress` in footage.service.ts for why this is a callback rather
 * than a direct `console.log` — this service also runs inside the web app,
 * where stdout is the wrong medium.
 */
export type RenderProgress = (message: string) => void;

const noopProgress: RenderProgress = () => {};

/** Matches the default `buildRenderArgs` uses when `clipSeconds` is omitted,
 * but named explicitly here so the coverage guard below computes against the
 * exact value actually passed to the command builder. */
const CLIP_SECONDS = 12;

/** FFmpeg emits `-progress` lines far faster than a database should be
 * written; at most one `RenderJob.progress` write per this window. */
const PROGRESS_THROTTLE_MS = 1000;

/** Stderr is batched into `RenderLog` rather than written per line — flush
 * once the buffer crosses this size, and always on process exit. */
const STDERR_FLUSH_BYTES = 4000;

function defaultSpawner(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args);
}

/**
 * Repeats the clip list (never re-downloads) until it covers the narration.
 * Without this, `buildRenderArgs`'s looped clips plus `-shortest` silently
 * truncate the output to the clips' combined length — a plausible-looking
 * file that cuts the narration off mid-sentence rather than an error. See
 * Task 3's report for how this was discovered.
 */
function ensureCoverage(clipPaths: string[], durationSeconds: number): string[] {
  if (clipPaths.length === 0) {
    return clipPaths;
  }

  const original = [...clipPaths];
  let covered = [...clipPaths];

  while (CLIP_SECONDS * covered.length < durationSeconds) {
    covered = covered.concat(original);
  }

  return covered;
}

/** Parses `key=value` lines from FFmpeg's `-progress pipe:1` stdout. Lines can
 * arrive split across chunk boundaries, hence the buffering here. */
class ProgressParser {
  private buffer = "";

  /** Returns every `out_time_ms` value found in this chunk, in order. */
  push(chunk: string): number[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    const values: number[] = [];
    for (const line of lines) {
      const [key, value] = line.split("=");
      if (key === "out_time_ms") {
        const ms = Number(value);
        if (Number.isFinite(ms)) {
          values.push(ms);
        }
      }
    }
    return values;
  }
}

export class RenderService {
  constructor(private readonly spawnProcess: ProcessSpawner = defaultSpawner) {}

  async render(
    userId: string,
    videoId: string,
    onProgress: RenderProgress = noopProgress,
  ): Promise<RenderResult> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        voiceOver: { select: { audioUrl: true, durationSeconds: true } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "GENERATING") {
      throw new ConflictError(
        `Only videos in GENERATING can be rendered. This one is ${video.status.toLowerCase()}.`,
      );
    }

    if (!video.voiceOver?.audioUrl || video.voiceOver.durationSeconds == null) {
      throw new ConflictError("Narration must be generated before rendering.");
    }

    const durationSeconds = video.voiceOver.durationSeconds;
    const audioStoragePath = video.voiceOver.audioUrl;

    // Assets carry no direct videoId column — every object (and therefore
    // every Asset that references one) lives under `videos/{videoId}/...`,
    // so the storage prefix is the scoping key, same as storage.ts's own
    // "prefix delete" design.
    const subtitleAsset = await prisma.asset.findFirst({
      where: {
        kind: "SUBTITLE",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    if (!subtitleAsset) {
      throw new ConflictError("Narration alignment must be generated before rendering.");
    }

    const clipAssets = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "asc" },
      select: { storagePath: true },
    });

    if (clipAssets.length === 0) {
      throw new ConflictError("Stock footage must be collected before rendering.");
    }

    // The real guard against a second concurrent render: two callers can both
    // read GENERATING above, but only one's `status: "GENERATING"` clause can
    // still match once the other has flipped the row to RENDERING, so only
    // one proceeds to create a RenderJob. Same shape as
    // VideoService.approveScript's Gate 1.
    const job = await prisma.$transaction(async (tx) => {
      const { count } = await tx.video.updateMany({
        where: { id: videoId, userId, deletedAt: null, status: "GENERATING" },
        data: { status: "RENDERING" },
      });

      if (count === 0) {
        throw new ConflictError("A render is already in progress for this video.");
      }

      await tx.videoStatusEvent.create({
        data: {
          videoId,
          from: "GENERATING",
          to: "RENDERING",
          message: "Render started",
        },
      });

      return tx.renderJob.create({ data: { videoId } });
    });

    const tempDir = await mkdtemp(path.join(tmpdir(), "framecast-render-"));

    try {
      await prisma.renderJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
      });

      const setupStartedAt = Date.now();

      const audioPath = path.join(tempDir, `narration${path.extname(audioStoragePath) || ".mp3"}`);
      await writeFile(audioPath, await getObject(audioStoragePath));

      const downloadedClipPaths: string[] = [];
      for (const [index, asset] of clipAssets.entries()) {
        const clipPath = path.join(
          tempDir,
          `clip-${index}${path.extname(asset.storagePath) || ".mp4"}`,
        );
        await writeFile(clipPath, await getObject(asset.storagePath));
        downloadedClipPaths.push(clipPath);
      }

      const alignmentBuffer = await getObject(subtitleAsset.storagePath);
      const alignment = JSON.parse(alignmentBuffer.toString("utf-8")) as Alignment;
      const srtPath = path.join(tempDir, "captions.srt");
      await writeFile(srtPath, buildSrt(alignment));

      onProgress(
        `fetched narration + ${clipAssets.length} clip(s) + captions from storage (${formatElapsed(Date.now() - setupStartedAt)})`,
      );

      const clipPaths = ensureCoverage(downloadedClipPaths, durationSeconds);
      const outputPath = path.join(tempDir, "video.mp4");

      const args = buildRenderArgs({
        clipPaths,
        audioPath,
        srtPath,
        outputPath,
        durationSeconds,
        clipSeconds: CLIP_SECONDS,
      });

      await this.runFfmpeg(args, job.id, durationSeconds, onProgress);

      const outputBuffer = await readFile(outputPath);
      const outputStoragePath = storagePath(videoId, "output", "video.mp4");
      await putObject(outputStoragePath, outputBuffer, "video/mp4");

      await prisma.$transaction(async (tx) => {
        await tx.renderJob.update({
          where: { id: job.id },
          data: {
            status: "SUCCEEDED",
            progress: 100,
            outputUrl: outputStoragePath,
            finishedAt: new Date(),
          },
        });

        const { count } = await tx.video.updateMany({
          where: { id: videoId, userId, deletedAt: null, status: "RENDERING" },
          data: { status: "READY" },
        });

        if (count === 0) {
          throw new ConflictError(
            "The video's status changed unexpectedly while rendering completed.",
          );
        }

        await tx.videoStatusEvent.create({
          data: {
            videoId,
            from: "RENDERING",
            to: "READY",
            message: "Render completed",
          },
        });
      });

      return { outputPath: outputStoragePath, durationSeconds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await prisma.renderJob
        .update({
          where: { id: job.id },
          data: { status: "FAILED", error: message, finishedAt: new Date() },
        })
        .catch(() => {
          // Best-effort: the original error is what matters to the caller.
        });

      await prisma
        .$transaction(async (tx) => {
          const { count } = await tx.video.updateMany({
            where: { id: videoId, userId, deletedAt: null, status: "RENDERING" },
            data: { status: "FAILED", failureReason: message },
          });

          if (count > 0) {
            await tx.videoStatusEvent.create({
              data: { videoId, from: "RENDERING", to: "FAILED", message },
            });
          }
        })
        .catch(() => {
          // Best-effort: the original error is what matters to the caller.
        });

      throw error;
    } finally {
      // Video files are large; a leaked temp dir per render fills disk fast.
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Spawns `ffmpeg` with an argument array — never a shell string, so a clip
   * path containing a space or quote cannot become command injection. */
  private runFfmpeg(
    args: string[],
    jobId: string,
    durationSeconds: number,
    onProgress: RenderProgress,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);
      const progressParser = new ProgressParser();
      const pendingWrites: Promise<unknown>[] = [];
      const renderStartedAt = Date.now();
      let lastProgressWriteAt = 0;

      let stderrBuffer = "";
      const flushStderr = () => {
        if (!stderrBuffer) {
          return;
        }
        const message = stderrBuffer;
        stderrBuffer = "";
        pendingWrites.push(
          prisma.renderLog
            .create({ data: { renderJobId: jobId, level: "ERROR", message } })
            .catch(() => {
              // Best-effort logging; must never mask the real ffmpeg outcome.
            }),
        );
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        const outTimeMsValues = progressParser.push(chunk.toString());
        if (outTimeMsValues.length === 0) {
          return;
        }

        const latestMs = outTimeMsValues[outTimeMsValues.length - 1];
        const now = Date.now();
        if (now - lastProgressWriteAt < PROGRESS_THROTTLE_MS) {
          return;
        }
        lastProgressWriteAt = now;

        const percent = Math.min(
          100,
          Math.max(0, Math.round((latestMs / 1_000_000 / durationSeconds) * 100)),
        );

        // Same throttle window as the DB write below, so the console isn't
        // updated any more often than the progress it's reporting actually
        // is — this is what replaces "two minutes of silence" with a live
        // percentage as ffmpeg advances.
        onProgress(`encoding … ${percent}% (${formatElapsed(now - renderStartedAt)})`);

        pendingWrites.push(
          prisma.renderJob
            .update({ where: { id: jobId }, data: { progress: percent } })
            .catch(() => {
              // Best-effort progress reporting; must never mask the real outcome.
            }),
        );
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
        if (stderrBuffer.length >= STDERR_FLUSH_BYTES) {
          flushStderr();
        }
      });

      child.on("error", (error: Error) => {
        flushStderr();
        Promise.all(pendingWrites)
          .catch(() => {})
          .finally(() => reject(error));
      });

      child.on("close", (code: number | null) => {
        flushStderr();
        Promise.all(pendingWrites)
          .catch(() => {})
          .finally(() => {
            if (code === 0) {
              resolve();
            } else {
              reject(new InternalError(`ffmpeg exited with code ${code}`));
            }
          });
      });
    });
  }
}

export const renderService = new RenderService();
