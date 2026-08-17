import "server-only";

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { VideoFormat } from "@/generated/prisma/enums";
import type { SafeAreaCaptionStyle } from "@/lib/ffmpeg-command";
import {
  buildAssembleArgs,
  buildSegmentArgs,
  buildTransitionArgs,
  concatListLine,
  planRender,
} from "@/lib/ffmpeg-command";
import { buildSfxTrackArgs, planSfxCues } from "@/lib/sfx-track";
import type { TransitionStyle, VideoStyle } from "@/lib/video-style";

/**
 * Turning a list of clips, a narration and a caption file into one MP4.
 *
 * This is the whole of the render's FFmpeg orchestration and nothing else — no
 * database, no storage, no status transitions. It was lifted out of
 * `RenderService.render` unchanged so that a SECOND caller could have it:
 * `ShortsService.renderShort` composes a short out of the same section clips
 * the full render uses, at 1080x1920, rather than cropping one out of a
 * finished 16:9 file.
 *
 * That second caller is the fix for a bug, not a tidy-up. A short cut out of
 * the finished render inherits the landscape captions that were burned into
 * those pixels and then burns its own vertical ones on top, so every short
 * carried two sets of subtitles and the first set could not be removed — it was
 * the image. Composing from the clips means the short is built from footage
 * that has never had text drawn on it, so the only captions it can have are its
 * own. It also costs nothing at all for a video that never has a short cut from
 * it: no extra pass, no caption-free master kept on disk beside the render.
 *
 * Everything below is byte-for-byte the argv a full landscape render has always
 * produced. `format` defaults to landscape, `audioStartSeconds` and the
 * horizontal caption margins are omitted unless a caller sets them, and the
 * progress lines are the same strings — see `frameSize` and `buildForceStyle`
 * in ffmpeg-command.ts, which are written the same way for the same reason.
 */

/** What a composition needs. Paths are all local files in `tempDir`'s world —
 *  fetching them from storage is the caller's job, because the two callers
 *  fetch different things. */
export interface ComposeInput {
  /** Where the segment files, the concat list and the SFX track are written.
   *  The caller owns it and is responsible for removing it. */
  tempDir: string;
  /** In play order. The same file may appear more than once. */
  clipPaths: string[];
  /** Index-aligned with `clipPaths`: how long each holds the screen. */
  clipSeconds: number[];
  style: VideoStyle;
  /**
   * What happens at each join, one entry per boundary (`clips - 1` of them),
   * `null` for a hard cut.
   *
   * Absent means "the channel's own `style.transitions` at every join", which
   * is what every composition before this passed and is byte-for-byte the plan
   * `planRender` has always built. Set only by a format that needs one join to
   * read differently from the rest — see `insightTransitions`.
   */
  transitions?: readonly (TransitionStyle | null)[];
  /** Absent means landscape, which keeps every argv identical to what the
   *  landscape render has always emitted. */
  format?: VideoFormat;
  audioPath: string;
  /** Set only when composing a window of a longer narration — see
   *  `AssembleInput.audioStartSeconds`. */
  audioStartSeconds?: number;
  /** What the output is cut to. For a window this is the window's length, not
   *  the narration's. */
  durationSeconds: number;
  /** The subtitle file to burn in. An `.srt` for every render this app has
   *  made; an `.ass` when the channel's `captionMode` is `kinetic`, which
   *  libass reads natively and `subtitles=` accepts unchanged. */
  srtPath: string;
  /**
   * Already adapted to `format` by the caller. Landscape passes the channel's
   * own style through; vertical passes `verticalCaptionStyle(...)`.
   *
   * Omitted for a kinetic composition, and it has to be. `force_style`
   * OVERRIDES the styles inside an ASS file, so passing the SRT-unit numbers
   * alongside an `.ass` that carries its own would replace the font and the
   * sizes `buildAss` computed in frame pixels with numbers meant for FFmpeg's
   * synthesised 384x288 canvas — captions six times too small, with nothing
   * anywhere reporting it.
   */
  captions?: SafeAreaCaptionStyle;
  musicPath?: string;
  outputPath: string;
}

/** One line of human-readable progress. Same shape as `RenderProgress`,
 *  redeclared here so this module does not import the service that imports
 *  it. */
export type ComposeProgress = (message: string) => void;

export interface ComposeDeps {
  /**
   * Runs one FFmpeg invocation to completion, or rejects.
   *
   * `durationSeconds` is null for the runs whose length is fixed and short
   * (segments, transition stubs, the SFX track) — see `RenderService.runFfmpeg`
   * for why null rather than 0. The two callers differ in what they do around
   * this: the render logs stderr into `RenderLog` and polls for cancellation,
   * a short does neither, so the difference stays on their side of this
   * boundary rather than becoming options here.
   */
  runFfmpeg: (
    args: string[],
    durationSeconds: number | null,
    onProgress: ComposeProgress,
  ) => Promise<void>;
  onProgress: ComposeProgress;
  /** Polled only to decide whether a failed enhancement (a transition stub, the
   *  SFX track) is an enhancement that failed or a cancellation in flight. */
  shouldCancel?: () => boolean;
}

export async function compose(input: ComposeInput, deps: ComposeDeps): Promise<void> {
  const { style, tempDir } = input;
  const { runFfmpeg, onProgress, shouldCancel } = deps;

  // Two passes — see ffmpeg-command.ts for why a single filter graph
  // cannot do this inside the worker's memory. Pass one normalises each
  // distinct clip on its own; pass two joins the sequence with the concat
  // demuxer, which reads one file at a time.
  // `input.transitions ?? style.transitions` and not a merge of the two: a
  // caller that states the joins has stated all of them, and falling back per
  // boundary would put the channel's half-second dissolve at every join the
  // format meant to cut.
  const plan = planRender(
    input.clipPaths,
    tempDir,
    input.clipSeconds,
    input.transitions ?? style.transitions,
  );

  for (const [index, segment] of plan.segments.entries()) {
    onProgress(`normalising clip ${index + 1} of ${plan.segments.length}`);

    // Segments are short and fixed-length, so a percentage of their own
    // would fight the real render's — null tells the runner to report
    // none. Cancellation is still honoured during and between them.
    await runFfmpeg(
      buildSegmentArgs({ ...segment, motion: style.motion, format: input.format }),
      null,
      () => {},
    );
  }

  // A stub that fails to build becomes a hard cut. Half a second of
  // dissolve is never worth failing a finished render for — but a
  // cancellation arrives through the same rejection, and swallowing that
  // would keep encoding after the operator asked to stop.
  const stubPathByIndex = new Map<number, string>();
  for (const [index, transition] of plan.transitions.entries()) {
    onProgress(`building transition ${index + 1} of ${plan.transitions.length}`);

    try {
      await runFfmpeg(buildTransitionArgs(transition), null, () => {});
      // Keyed by the boundary the job says it covers, not by its position in
      // this list. The two are only equal while every join dissolves; with one
      // hard cut in the timeline they diverge, and every later stub would be
      // concatenated after the wrong segment.
      stubPathByIndex.set(transition.boundaryIndex, transition.outputPath);
    } catch (error) {
      if (shouldCancel?.()) {
        throw error;
      }
      onProgress(`transition ${index + 1} could not be built; using a hard cut`);
    }
  }

  const concatEntries: string[] = [];
  plan.playOrder.forEach((segmentPath, index) => {
    const stubPath = stubPathByIndex.get(index);
    // With no stub covering this boundary, the segment has to keep the
    // tail it would otherwise have donated — dropping it anyway would
    // leave a half-second hole in the timeline.
    const trim = stubPath
      ? plan.trims[index]
      : { ...plan.trims[index], outpoint: undefined };

    concatEntries.push(concatListLine(segmentPath, trim));
    if (stubPath) {
      concatEntries.push(concatListLine(stubPath));
    }
  });

  const concatListPath = path.join(tempDir, "segments.txt");
  await writeFile(concatListPath, `${concatEntries.join("\n")}\n`);

  // Where each surviving stub lands on the finished timeline — the sum of
  // everything played before it, stubs included.
  //
  // The overlap is added at every boundary the plan has, not only at the
  // ones a stub was built for, and that is the whole subtlety here. A
  // segment whose stub failed keeps the tail it would have donated (see
  // the `outpoint: undefined` above), so half a second is played at that
  // boundary either way — as a crossfade if the stub exists, as more of
  // the outgoing clip if it does not. Advancing only for surviving stubs
  // put every later whoosh half a second early per failed stub, drifting
  // further the more of them failed. The timeline's total was never
  // affected; only where the effects land on it, which is the kind of
  // wrongness nobody spots and everybody feels.
  const boundarySeconds: number[] = [];
  let elapsedSeconds = 0;
  plan.playOrder.forEach((_segmentPath, index) => {
    elapsedSeconds += plan.trimmedSeconds[index];

    // Undefined for the final segment, which donates no tail and has no
    // boundary after it. Read off `boundaryOverlaps` rather than the job list,
    // because that list is sparse once a timeline mixes dissolves with hard
    // cuts — indexing it by clip would answer for the wrong boundary. Zero is
    // a real answer here and means a hard cut.
    const boundaryOverlap = plan.boundaryOverlaps[index];
    if (boundaryOverlap === undefined) {
      return;
    }

    // A boundary with no stub is a hard cut, and it happens at the end of
    // the retained tail rather than here — but a whoosh is an accent on a
    // dissolve, not a fallback for one, so a failed stub gets no cue at
    // all rather than a cue at a different time.
    if (stubPathByIndex.has(index)) {
      boundarySeconds.push(elapsedSeconds);
    }
    elapsedSeconds += boundaryOverlap;
  });

  let sfxPath: string | undefined;
  try {
    const candidate = path.join(tempDir, "sfx.m4a");
    await runFfmpeg(
      buildSfxTrackArgs({
        cues: planSfxCues(boundarySeconds, input.durationSeconds),
        durationSeconds: input.durationSeconds,
        outputPath: candidate,
      }),
      null,
      () => {},
    );
    sfxPath = candidate;
  } catch (error) {
    // Same rule as a failed stub: an enhancement never fails a render, but
    // a cancellation must still propagate.
    if (shouldCancel?.()) {
      throw error;
    }
    onProgress("sound effects could not be built; continuing without them");
  }

  onProgress(
    `assembling ${plan.playOrder.length} segment(s) with narration, ` +
      `captions${input.musicPath ? " and music" : ""}`,
  );

  await runFfmpeg(
    buildAssembleArgs({
      concatListPath,
      audioPath: input.audioPath,
      audioStartSeconds: input.audioStartSeconds,
      srtPath: input.srtPath,
      outputPath: input.outputPath,
      durationSeconds: input.durationSeconds,
      musicPath: input.musicPath,
      sfxPath,
      audio: style.audio,
      captions: input.captions,
      // Tied to the caption mode rather than given a switch of its own.
      // Grain and word-by-word captions are two halves of one look, and a
      // channel that wanted the grain without the captions — or the reverse —
      // would be asking for a third format nobody has specified.
      grain: style.captionMode === "kinetic",
    }),
    input.durationSeconds,
    onProgress,
  );
}
