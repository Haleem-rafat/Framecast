import "server-only";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeRenderFile } from "@/lib/render-storage";
import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { ConflictError, InternalError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  anchorCues,
  cueWindows,
  type ScriptCue,
  sectionDurations,
} from "@/lib/script-cues";
import {
  SHORT_MAX_CHARS_PER_LINE,
  SHORT_MAX_WORDS_PER_LINE,
  verticalCaptionStyle,
} from "@/lib/shorts-plan";
import { getObject, storagePath } from "@/lib/storage";
import { brandService } from "@/services/brand.service";
import { compose } from "@/services/composer";
import { MusicService, musicService } from "@/services/music.service";
import { formatElapsed } from "@/utils/format";

/** Injectable so tests never spawn a real `ffmpeg` process. */
export type ProcessSpawner = (
  command: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

export interface RenderResult {
  /** The path (relative to RENDER_ROOT) of the finished render on local disk
   * (see render-storage.ts) — the same value written to `RenderJob.outputUrl`. */
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

/**
 * How many clips a video with no b-roll cues may play, regardless of how many
 * it has collected.
 *
 * This was introduced when the render still joined clips with the concat
 * filter, which opens every input simultaneously: each clip cost a live h264
 * decoder plus a scaler for the whole run, stock footage arrives at up to
 * 2560x1440, and a video whose footage predates FootageService's own download
 * cap had 38 of them. Inside the worker's 1GB container the kernel killed
 * FFmpeg with SIGKILL before it produced a frame, reported only as "killed by
 * signal SIGKILL" with no FFmpeg error to explain it.
 *
 * The two-pass design has since removed that pressure, but the cap stays: at
 * twelve, each clip simply holds the screen longer, and a pre-cue video's
 * clips have nothing to do with what is being said anyway, so the thirteenth
 * buys a slightly less repetitive backdrop for a real encode per clip.
 *
 * A cued video is deliberately NOT capped by this. Its clips are played one at
 * a time by the concat demuxer, one decoder open at any moment (see
 * ffmpeg-command.ts's two-pass rationale), so the memory this bounds is not
 * the memory a fiftieth section would cost — and dropping section fifty would
 * leave the narration's last minute with no picture at all.
 */
const MAX_RENDER_CLIPS = 12;

/**
 * The shortest slot any clip may hold the screen for.
 *
 * Two different things can ask for an impossibly short one, and the two pay
 * for the floor differently.
 *
 * A cued video asks through a degenerate cue window — two cues resolving to
 * the same character, which `cueWindows` deliberately floors at zero-length
 * rather than inverting. There the floor is paid out of a *neighbouring slot*,
 * not out of the total: `sectionDurations` moves boundaries rather than
 * clamping lengths, so widening a short section shortens the sections after it
 * by the same amount and the slots still sum to the narration exactly. That
 * matters because the assemble pass cuts the output at the narration's length
 * regardless — a total that came out long would not become a longer video, it
 * would become sections playing late against their own words with the last one
 * losing the difference off its end. Drift, not truncation, is the hazard, and
 * `-t` cannot undo drift. See `sectionDurations` for how far a floored slot can
 * push its neighbours and where that stops.
 *
 * An uncued video asks through the plain clamp on its equal shares (twelve
 * clips over an eight-second narration wants 0.67s each). That one *does* pay
 * out of the timeline: the slots sum past the narration and `-t` trims the
 * tail, so the last clip or two are cut short or never seen. Acceptable
 * precisely because the video has no cues — its clips stand in no relation to
 * the words, so there is no sync to drift out of, only a backdrop that ends
 * sooner than planned.
 *
 * Either way, what the floor is protecting against is FFmpeg being handed
 * `-t 0` and producing an empty segment.
 */
const MIN_CLIP_SECONDS = 1;

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

/** Exported so ThumbnailService (thumbnail.service.ts) spawns FFmpeg the same
 *  way this service does, rather than each defining its own thin wrapper
 *  around `child_process.spawn`. */
export function defaultSpawner(
  command: string,
  args: string[],
): ChildProcessWithoutNullStreams {
  return spawn(command, args);
}

/**
 * The path FootageService stores section `index`'s clip at.
 *
 * Zero-padded to three digits so the sequence sorts lexicographically —
 * `section-002` before `section-010` — which is what lets the clip query
 * below order by `storagePath` and get play order for free.
 *
 * Exported for ShortsService, which composes a short out of the same clips
 * this render plays rather than cropping one out of the finished render — see
 * `composer.ts`. Two copies of this string would be two chances for a short to
 * look for footage one directory away from where it was stored.
 */
export function sectionClipPath(videoId: string, index: number): string {
  return storagePath(videoId, "clips", `section-${String(index).padStart(3, "0")}.mp4`);
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
  constructor(
    private readonly spawnProcess: ProcessSpawner = defaultSpawner,
    /** Same injection shape as `spawnProcess`: the default is the real
     * `musicService` singleton (real Jamendo search, real storage writes),
     * and a test wanting to observe *what query it was asked to search for*
     * — without a live Jamendo account or a live bucket — builds its own
     * `MusicService` over a fake `MusicProvider` and hands it in here. */
    private readonly music: MusicService = musicService,
  ) {}

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
        // Landscape or vertical, decided by the operator at Gate 1 and never
        // afterwards (see `VideoService.approveScript`). It reaches FFmpeg in
        // exactly two places — the frame every clip is normalised into, and
        // which caption geometry is used — because that is all the difference
        // there is between the two: the timing model, the footage, the
        // narration and the audio mix are identical.
        format: true,
        // The one thing this render needs to know about the channel it
        // belongs to: which one. `null` when the video's project has no
        // channel assigned, which brandService.resolve treats exactly like a
        // channel with no brand row — both fall back to DEFAULT_STYLE and the
        // generic music query below. Same field, same select shape,
        // metadata.service.ts / thumbnail.service.ts / voiceover.service.ts /
        // publish.service.ts already read for their own per-channel choices.
        project: { select: { channelId: true } },
        voiceOver: { select: { audioUrl: true, durationSeconds: true } },
        // Only the active version's cues mean anything: an edit that moves the
        // section boundaries invalidates every earlier version's, and
        // script.service.ts re-anchors the survivors onto whichever version is
        // active. Anchoring is re-run here against the current `content`
        // rather than trusting stored offsets, exactly as FootageService does
        // when it collects — the two must agree on where a section starts or
        // the clip it fetched plays under the wrong words.
        script: { select: { activeVersion: { select: { content: true, cues: true } } } },
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
    const format = video.format;
    const vertical = format === "VERTICAL";

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
      // By path, not by `createdAt`, and this decides two things for an
      // *uncued* video: which clips survive the MAX_RENDER_CLIPS cap, and what
      // order they play in. Insertion time is a property of the run that
      // collected them — re-fetch one clip and a legacy video re-renders with
      // a different selection in a different order — whereas the path is a
      // property of the data, so the same footage always produces the same
      // video.
      //
      // A cued video is unaffected either way: it maps each section to the
      // exact path FootageService stored it at, so this list is only ever a
      // membership check for it. Ordering it consistently is still worth doing
      // — one rule for both paths beats a rule that quietly matters for one.
      orderBy: { storagePath: "asc" },
      select: { storagePath: true },
    });

    if (allClipAssets.length === 0) {
      throw new ConflictError("Stock footage must be collected before rendering.");
    }

    // A cue whose anchor no longer occurs in the current script is dropped
    // rather than guessed at (see anchorCues), so this is the set of sections
    // that genuinely still exist in the words being narrated.
    const activeVersion = video.script?.activeVersion ?? null;
    const rawCues = activeVersion?.cues;
    const scriptCues = Array.isArray(rawCues) ? (rawCues as unknown as ScriptCue[]) : [];
    // `.trim()`, and it is the invariant the whole timing model rests on.
    // Character offsets only convert to times because the alignment indexes
    // exactly the string ElevenLabs was sent, which voiceover.service.ts
    // trims (see cueWindows' doc comment, and script.service.ts's own
    // trimmed anchoring). Anchoring against the untrimmed content shifts
    // every offset by however much leading whitespace the content happens to
    // carry, and each shifted character is a tenth of a second of picture
    // playing against the wrong words.
    const anchored =
      activeVersion && scriptCues.length > 0
        ? anchorCues(scriptCues, activeVersion.content.trim()).anchored
        : [];

    const sectionPaths = anchored.map((_cue, index) => sectionClipPath(videoId, index));
    const collectedPaths = new Set(allClipAssets.map((asset) => asset.storagePath));
    const presentSections = sectionPaths.filter((sectionPath) =>
      collectedPaths.has(sectionPath),
    );

    // Cues, but not one clip of theirs on disk: this video's footage was
    // collected before per-section collection existed, so its clips are the
    // old topic-level pool. Treat it exactly like a video with no cues at all
    // — the same reasoning that makes the nullable `cues` column safe to ship
    // without a backfill.
    const cued = presentSections.length > 0;

    // Some sections present and some not is the one arrangement that must
    // never render. FFmpeg would happily play what it was given, every later
    // section sliding forward into the gap, and the result is a finished video
    // whose picture is seconds ahead of its words from the middle onward —
    // wrong in the specific way nobody notices until it is published.
    //
    // This is not only a bug state. FootageService fills a section that finds
    // nothing of its own by copying the nearest section that already has a
    // clip, but it builds that index as it goes, so a section near the front
    // whose cue search, Pixabay and the topic pool all come back empty has
    // nothing behind it to copy and is skipped — a routine first collection
    // can leave exactly this hole (see collectPerCue's last `if (!picked)`).
    // Collecting again is what closes it: the second run seeds that same index
    // from the assets the first run stored, so the gap can copy a section
    // that now exists. Hence the error names re-collection rather than
    // suggesting the video is broken.
    if (cued && presentSections.length !== sectionPaths.length) {
      const missing = sectionPaths
        .map((sectionPath, index) => ({ sectionPath, index }))
        .filter((entry) => !collectedPaths.has(entry.sectionPath))
        .map((entry) => entry.index + 1);

      throw new ConflictError(
        `Footage is missing for section(s) ${missing.join(", ")} of ${sectionPaths.length}. ` +
          "Run footage collection again — it fills a section that found nothing of its " +
          "own from the sections that did, which the first run could not do for these. " +
          "Rendering as-is would play every later section against the wrong narration.",
      );
    }

    // Cued: one clip per section, in the order the sections are spoken —
    // there is nothing to choose, the script already decided.
    //
    // Uncued: whichever clips come first by path, capped. FootageService caps
    // how many clips it *downloads*, but a video collected before that cap
    // existed still has every clip it ever gathered — 38 of them in the case
    // that OOM-killed the worker. See MAX_RENDER_CLIPS.
    const clipAssets = cued
      ? sectionPaths.map((sectionPath) => ({ storagePath: sectionPath }))
      : allClipAssets.slice(0, MAX_RENDER_CLIPS);

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
      // A vertical frame is 1080px wide, not 1920, and the line that fits
      // comfortably across a landscape frame wraps into a three-row tower in a
      // vertical one. The two limits are the ones shorts already use and are
      // measured rather than guessed — see SHORT_MAX_CHARS_PER_LINE. A
      // landscape render calls `buildSrt` with no limits at all, exactly as it
      // always has.
      await writeFile(
        srtPath,
        vertical
          ? buildSrt(alignment, SHORT_MAX_WORDS_PER_LINE, SHORT_MAX_CHARS_PER_LINE)
          : buildSrt(alignment),
      );

      onProgress(
        `fetched narration + ${clipAssets.length} clip(s) + captions from storage (${formatElapsed(Date.now() - setupStartedAt)})`,
      );

      // The channel's own look, sound and music query — never the video's own
      // fields. `resolve` never throws and falls back to DEFAULT_STYLE and a
      // generic music query for a channel with no brand row, a video whose
      // project has no channel at all, or a `videoStyle` column that failed
      // to parse (see brand.service.ts), so every one of those still renders
      // exactly as it did before this brand lookup existed — this call adds
      // a per-channel choice on top of that fallback, it does not remove it.
      const brand = await brandService.resolve(video.project?.channelId ?? null);
      const style = brand.videoStyle;
      const outputPath = path.join(tempDir, "video.mp4");

      // A slot has to outlast the crossfade it gives its tail to, or the
      // concat entry for it comes out inverted (see planRender's own guard).
      // Derived from the style rather than hard-coded so raising the
      // transition duration cannot quietly invalidate the floor; doubled so
      // the slot is still something a viewer sees rather than one continuous
      // dissolve.
      const minClipSeconds = Math.max(
        MIN_CLIP_SECONDS,
        style.transitions.enabled ? style.transitions.durationSeconds * 2 : 0,
      );

      // Cued: each clip holds the screen for exactly as long as its section is
      // spoken, read off the same alignment the captions come from.
      //
      // Uncued: an equal share each. There is nothing in a pre-cue script that
      // says where one idea ends and the next begins, so an even carve-up is
      // the most honest thing available — and unlike the fixed twelve-second
      // slots it replaces, the clips cover the narration exactly rather than
      // the list repeating until it overshoots. The one exception is the clamp
      // below: a narration too short to give every clip `minClipSeconds`
      // overshoots again, and the assemble pass's `-t` trims the tail. Nothing
      // here is anchored to the words, so a clip lost off the end costs a
      // backdrop rather than sync — see MIN_CLIP_SECONDS.
      const clipSeconds = cued
        ? sectionDurations(
            cueWindows(anchored, alignment).map((window) => window.startSeconds),
            durationSeconds,
            minClipSeconds,
          )
        : downloadedClipPaths.map(() =>
            Math.max(minClipSeconds, durationSeconds / downloadedClipPaths.length),
          );

      // The one arrangement `sectionDurations` cannot repair: more sections
      // than the narration can give the floor to, so it falls back to equal
      // shares — and if the narration is short enough, those shares are
      // shorter than the crossfade each one has to make room for. planRender
      // refuses that, correctly, but it can only describe what it was handed:
      // "clip 3 is 0.4s, shorter than the 0.5s transition". That names the
      // symptom. The cause is a script with more sections than there are
      // seconds to spend on them, which is what the operator can actually do
      // something about, so it is named here — before fifty clips are
      // downloaded and encoded against a plan that cannot be built.
      const overlap = style.transitions.enabled ? style.transitions.durationSeconds : 0;
      if (cued && overlap > 0 && clipSeconds.some((seconds) => seconds <= overlap)) {
        const shortest = Math.min(...clipSeconds);
        throw new ConflictError(
          `This script has ${clipSeconds.length} sections across ${durationSeconds}s of ` +
            `narration — about ${shortest.toFixed(1)}s of picture each, too short to hold ` +
            "the screen or carry a transition. Edit the script so it has fewer, longer " +
            `sections (at least ${minClipSeconds}s of narration each), then collect ` +
            "footage and render again.",
        );
      }

      // Fetched, never generated, and a video that has none simply renders
      // without it — see MusicService.collect's doc comment.
      //
      // Searched by the channel's `musicQuery`, not the video's title. A
      // title describes what the video is about, not what it should sound
      // like — "Ada Lovelace wrote the first program" returned nothing
      // usable from Jamendo, because it is not a musical description. A
      // channel's music should also sound consistent from video to video,
      // which argues for a channel-level setting over a per-video guess
      // either way. brandService.resolve's fallback ("calm ambient
      // instrumental") stands in for every channel that has not chosen one,
      // branded or not — nothing here special-cases an unbranded channel.
      let musicPath: string | undefined;
      const musicStoragePath = await this.music.collect(videoId, brand.musicQuery);
      if (musicStoragePath) {
        musicPath = path.join(tempDir, "music.mp3");
        await writeFile(musicPath, await getObject(musicStoragePath));
      }

      // Everything from here to the finished MP4 is `composer.ts`: the two
      // passes, the crossfade stubs, the concat list, the effects track and
      // the assemble. It was moved out of this method verbatim so that
      // ShortsService can compose a short out of these same section clips
      // instead of cropping one out of the file this render is about to
      // produce — see that module's doc comment for the double-caption bug
      // that made it necessary. For a landscape video nothing about the argv
      // or the ordering changed.
      await compose(
        {
          tempDir,
          clipPaths: downloadedClipPaths,
          clipSeconds,
          style,
          // Undefined rather than "LANDSCAPE" for the landscape case, so the
          // segment argv is byte-for-byte what it was.
          format: vertical ? "VERTICAL" : undefined,
          audioPath,
          durationSeconds,
          srtPath,
          // The same geometry a short's captions use, and deliberately the
          // same function: it is a 1080x1920 frame either way, so the safe
          // area that clears YouTube's action rail and its bottom chrome is
          // the same safe area. See `verticalCaptionStyle`.
          captions: vertical ? verticalCaptionStyle(style.captions) : style.captions,
          musicPath,
          outputPath,
        },
        {
          runFfmpeg: (args, runDurationSeconds, report) =>
            this.runFfmpeg(args, job.id, runDurationSeconds, report, shouldCancel),
          onProgress,
          shouldCancel,
        },
      );

      // The finished MP4 lands on this machine's own disk — the app and the
      // worker both run here now, so there's no other machine that needs to
      // read it (see render-storage.ts's doc comment). Streamed straight
      // from the temp file rather than buffered into memory first:
      // `writeRenderFile` pipes a stream source to disk directly, so a
      // ~170MB render is never held whole in this process's memory just to
      // hand it off again. Narration, clips and captions above are
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
            // DEBUG, not ERROR. ffmpeg writes *everything* to stderr — its
            // banner, the input and output stream descriptions, the per-frame
            // progress counter, the x264 statistics — because stdout is
            // reserved for piped media. Recording all of that at ERROR meant a
            // completely successful eight-minute render produced thousands of
            // lines an operator had every reason to read as a catastrophe, and
            // buried any line that was genuinely an error among them.
            //
            // The real outcome is the exit code, which the caller already turns
            // into a ProviderError with ffmpeg's own tail attached. This stream
            // is diagnostics for when that happens.
            .create({ data: { renderJobId: jobId, level: "DEBUG", message } })
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
