import "server-only";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeRenderFile } from "@/lib/blob-render-storage";
import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { ConflictError, InternalError, NotFoundError } from "@/lib/errors";
import {
  buildAssembleArgs,
  buildSegmentArgs,
  concatListLine,
  planRender,
} from "@/lib/ffmpeg-command";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";
import { formatElapsed } from "@/utils/format";

/** Injectable so tests never spawn a real `ffmpeg` process. */
export type ProcessSpawner = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

export interface RenderResult {
  /** The Vercel Blob URL of the finished render (see blob-render-storage.ts)
   * — the same value written to `RenderJob.outputUrl`. */
  outputUrl: string;
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

/** Matches the default the segment builder uses when `clipSeconds` is omitted,
 * but named explicitly here so the coverage guard below computes against the
 * exact value actually passed to the command builder. */
const CLIP_SECONDS = 12;

/**
 * How many distinct clips a single render may open, regardless of how many the
 * video has collected.
 *
 * The concat filter opens every input simultaneously, so each clip costs a live
 * h264 decoder plus a scaler for the whole run — and stock footage arrives at
 * up to 2560x1440. The worker's container has 1GB of memory, and a video whose
 * footage predates FootageService's own download cap had 38 clips: the kernel
 * killed FFmpeg with SIGKILL before it produced a frame, reported only as
 * "killed by signal SIGKILL" with no FFmpeg error to explain it.
 *
 * Twelve at 1080p fits comfortably. Beyond that the extra clips buy very little
 * visual variety anyway, since `ensureCoverage` loops the sequence to fill the
 * narration regardless.
 */
const MAX_RENDER_CLIPS = 12;

/** FFmpeg emits `-progress` lines far faster than a database should be
 * written; at most one `RenderJob.progress` write per this window. */
const PROGRESS_THROTTLE_MS = 1000;

/** How often `shouldCancel` is polled while FFmpeg runs. Independent of
 * `PROGRESS_THROTTLE_MS` — FFmpeg's `-progress` lines are what drive that
 * throttle, but cancellation must keep being checked even if progress output
 * ever stalls, so it runs on its own timer rather than piggybacking on the
 * `stdout` handler. */
const CANCEL_CHECK_INTERVAL_MS = 1000;

/** Stderr is batched into `RenderLog` rather than written per line — flush
 * once the buffer crosses this size, and always on process exit. */
const STDERR_FLUSH_BYTES = 4000;

function defaultSpawner(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args);
}

/**
 * Repeats the clip list (never re-downloads) until it covers the narration.
 * Without this, the looped clips plus `-shortest` silently
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
    /** Polled while FFmpeg runs (see `runFfmpeg`'s `CANCEL_CHECK_INTERVAL_MS`)
     * so a long render can be interrupted mid-encode rather than only
     * between pipeline stages. Optional and additive: omitting it leaves
     * this identical to a render that can never be cancelled, which is what
     * every caller before the render worker (Task 3) still does. */
    shouldCancel?: () => boolean,
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

    const allClipAssets = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "asc" },
      select: { storagePath: true },
    });

    if (allClipAssets.length === 0) {
      throw new ConflictError("Stock footage must be collected before rendering.");
    }

    // FootageService caps how many clips it *downloads*, but nothing capped how
    // many the render *opens*, and a video collected before that cap existed
    // still has every clip it ever gathered. FFmpeg opens all of them at once —
    // the concat filter has to — so each one holds a live h264 decoder and a
    // scaler, several at 2560x1440. On the operator's Mac that was merely
    // wasteful. In the worker's 1GB container it was fatal: 38 clips, and the
    // kernel killed FFmpeg with SIGKILL before it emitted a single frame, which
    // surfaced as a bare "killed by signal SIGKILL" with no FFmpeg error to
    // explain it.
    const clipAssets = allClipAssets.slice(0, MAX_RENDER_CLIPS);

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

      // Two passes — see ffmpeg-command.ts for why a single filter graph
      // cannot do this inside the worker's memory. Pass one normalises each
      // distinct clip on its own; pass two joins the sequence with the concat
      // demuxer, which reads one file at a time.
      const plan = planRender(clipPaths, tempDir, CLIP_SECONDS);

      for (const [index, segment] of plan.segments.entries()) {
        onProgress(
          `normalising clip ${index + 1} of ${plan.segments.length}`,
        );

        // Segments are short and fixed-length, so a percentage of their own
        // would fight the real render's — null tells the runner to report
        // none. Cancellation is still honoured during and between them.
        await this.runFfmpeg(
          buildSegmentArgs(segment),
          job.id,
          null,
          () => {},
          shouldCancel,
        );
      }

      const concatListPath = path.join(tempDir, "segments.txt");
      await writeFile(
        concatListPath,
        `${plan.playOrder.map(concatListLine).join("\n")}\n`,
      );

      onProgress(
        `assembling ${plan.playOrder.length} segment(s) with narration and captions`,
      );

      await this.runFfmpeg(
        buildAssembleArgs({
          concatListPath,
          audioPath,
          srtPath,
          outputPath,
          durationSeconds,
        }),
        job.id,
        durationSeconds,
        onProgress,
        shouldCancel,
      );

      // The finished MP4 goes to Vercel Blob, not local disk or Supabase
      // Storage — a real 1080p render (~170MB) exceeds Supabase's free-tier
      // 50MB object cap, and unlike local disk, Blob is reachable both from
      // this app (on Vercel) and from the render worker (on Railway). See
      // blob-render-storage.ts's doc comment. Streamed straight from the
      // temp file rather than buffered into memory first — `put()`'s
      // `multipart: true` handles chunking a file this large on its own; a
      // ~170MB Buffer held in this process's memory just to hand it off
      // again would be wasted risk. Narration, clips and captions above are
      // unaffected; only this final output's destination changed.
      const outputUrl = await writeRenderFile(videoId, createReadStream(outputPath));

      await prisma.$transaction(async (tx) => {
        await tx.renderJob.update({
          where: { id: job.id },
          data: {
            status: "SUCCEEDED",
            progress: 100,
            outputUrl,
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

      return { outputUrl, durationSeconds };
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
    /** null when this run has no meaningful percentage to report — the
     *  segment passes, whose length is fixed and short. Passing 0 instead
     *  would divide by zero, clamp to 100, and write a finished-looking
     *  progress while the render had barely started. */
    durationSeconds: number | null,
    onProgress: RenderProgress,
    shouldCancel?: () => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);
      const progressParser = new ProgressParser();
      const pendingWrites: Promise<unknown>[] = [];
      const renderStartedAt = Date.now();
      let lastProgressWriteAt = 0;

      // Cooperative cancellation: this is the one place a long FFmpeg run can
      // be interrupted mid-encode rather than only at a pipeline stage
      // boundary (see pipeline-runner.ts's `shouldCancel`). No-op when the
      // caller passes nothing — every caller before the render worker.
      let cancelled = false;
      const cancelCheck = shouldCancel
        ? setInterval(() => {
            if (shouldCancel()) {
              cancelled = true;
              clearInterval(cancelCheck);
              child.kill("SIGTERM");
            }
          }, CANCEL_CHECK_INTERVAL_MS)
        : undefined;

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

        if (durationSeconds === null) {
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
        if (cancelCheck) clearInterval(cancelCheck);
        flushStderr();
        Promise.all(pendingWrites)
          .catch(() => {})
          .finally(() => reject(error));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (cancelCheck) clearInterval(cancelCheck);
        // Flush whatever stderr was captured before FFmpeg died, signal or
        // not — a SIGKILL (e.g. the OS OOM killer, see render-oom-report.md)
        // gives the process no chance to write more, but anything already
        // buffered here from earlier `data` events must not be dropped on
        // the way to a FAILED RenderJob with an empty RenderLog.
        flushStderr();
        Promise.all(pendingWrites)
          .catch(() => {})
          .finally(() => {
            if (cancelled) {
              // Distinguish an intentional stop from the OOM-killer's SIGKILL
              // below — both arrive as a signal on `close`, but only this one
              // was requested, and callers (the worker) need to tell them
              // apart to avoid treating a cancellation as a failed attempt.
              reject(new InternalError("Render was cancelled."));
            } else if (code === 0) {
              resolve();
            } else if (signal) {
              // No exit code exists when a process is killed by signal — say
              // so explicitly rather than surfacing a bare "terminated" /
              // "exited with code null" that gives no clue what happened.
              reject(new InternalError(`ffmpeg was killed by signal ${signal}`));
            } else {
              reject(new InternalError(`ffmpeg exited with code ${code}`));
            }
          });
      });
    });
  }
}

export const renderService = new RenderService();
