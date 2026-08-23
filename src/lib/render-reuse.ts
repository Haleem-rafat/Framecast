/**
 * Whether a video already has a render worth keeping.
 *
 * ## The bug this exists for
 *
 * `runPipeline`'s render stage skipped when `video.status === "READY"`, which
 * is correct for a re-run of a finished video and useless for the case that
 * actually happens: a failure *after* the render. A publish that cannot get an
 * access token, a metadata call that times out, an upload refused by YouTube —
 * every one of those leaves a perfectly good MP4 on disk and a video marked
 * FAILED. `jobService.retry` then sets the status back to QUEUED, so the READY
 * check can no longer be true, and the retry re-encodes a video that was
 * already encoded.
 *
 * That is minutes of CPU and, for a generated-footage video, potentially a
 * fresh round of image generation — to reproduce a file that is sitting there.
 *
 * ## Why the status cannot be the signal
 *
 * Because `retry` deliberately clears it. The status says what the video is
 * *doing*; whether a usable file exists is a question about the file. So this
 * asks about the file.
 *
 * ## What makes a render stale
 *
 * Only one thing, and it is the thing the pipeline already understands:
 * narration. `runPipeline`'s own doc comment sets out why a changed narration
 * invalidates everything downstream — the alignment is rewritten, footage is
 * re-timed against it, captions move. So a render made *before* the current
 * voice-over is not reusable, and a render made after it is.
 *
 * Deliberately NOT treated as staleness: a changed script with unchanged
 * narration. The rendered file plays the narration, and narration is what a
 * script edit has to pass through to reach the screen — an edited script that
 * has not been re-narrated has not changed a single frame of the output.
 */

export interface RenderReuseInput {
  /** The most recent render job, or null when the video has never rendered. */
  latestRender: {
    status: string;
    outputUrl: string | null;
    finishedAt: Date | null;
  } | null;
  /** When the current narration was produced. Null when there is none, which
   *  makes any existing render unreusable — there is nothing for it to be
   *  aligned to. */
  narrationUpdatedAt: Date | null;
  /** Whether the output file is still on disk. A row pointing at a file that
   *  has been cleaned up is a promise the renderer cannot keep. */
  outputExists: boolean;
}

export function canReuseRender(input: RenderReuseInput): boolean {
  const { latestRender, narrationUpdatedAt, outputExists } = input;

  if (!latestRender || latestRender.status !== "SUCCEEDED") {
    return false;
  }

  // A succeeded job with no file recorded, or a file that is no longer there.
  // Both mean the same thing to a caller about to skip the render: there is
  // nothing to skip toward.
  if (!latestRender.outputUrl || !outputExists) {
    return false;
  }

  // No narration and yet a successful render is a contradiction — the render
  // cannot have been made without one. Refuse rather than reason about it: the
  // cost of being wrong is one re-encode, and the cost of being wrong the
  // other way is publishing a file nobody can account for.
  if (!narrationUpdatedAt || !latestRender.finishedAt) {
    return false;
  }

  // The whole test. A render finished after the narration it plays is current;
  // one finished before it was made against an alignment that no longer
  // exists.
  return latestRender.finishedAt.getTime() >= narrationUpdatedAt.getTime();
}
