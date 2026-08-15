import type { VideoFormat } from "@/generated/prisma/enums";
import { FRAME_SIZES } from "@/lib/ffmpeg-command";

/**
 * What an operator needs to know about the two output formats, in the words
 * they are shown in.
 *
 * The pixel dimensions are read from `FRAME_SIZES` rather than restated here,
 * because ffmpeg-command.ts is the file that decides what FFmpeg is asked to
 * produce and a second copy of "1080x1920" is a second thing to get wrong. Every
 * other field is a product fact — what the format is for, what it costs, and how
 * long a script it can hold — and none of it is server-only: the approval dialog
 * is a client component and renders all of it before anything is submitted.
 */

/**
 * The pace the whole app converts words to seconds at, and the same figure
 * every script prompt in `script-styles.ts` states to the model ("read aloud at
 * about 150 words a minute"). Kept here so the estimate an operator is shown
 * before approving and the length the script was written to are the same
 * number.
 */
export const WORDS_PER_MINUTE = 150;

/**
 * The longest a vertical video may run and still be a Short.
 *
 * YouTube's own ceiling, not a taste judgement: a vertical upload longer than
 * three minutes is not surfaced in the Shorts feed at all, it is an ordinary
 * video that happens to be the wrong shape for most screens. `shorts-plan.ts`
 * caps a CUT short at 60s for an editorial reason (a clip out of a long-form
 * narration has no second act); this is the platform limit that applies to a
 * video written as a short from the start, which does have one.
 */
export const VERTICAL_MAX_SECONDS = 180;

/**
 * Where a warning turns into a refusal to proceed quietly.
 *
 * A script 10% over three minutes is a judgement call and gets a note. A
 * nine-minute script is not a Short by any reading, and approving one as a
 * vertical video spends the full nine minutes of narration quota and the full
 * render to produce something YouTube will not treat as a Short — so past this
 * the dialog makes the operator acknowledge it in as many words.
 */
export const VERTICAL_HARD_LIMIT_SECONDS = 240;

export interface VideoFormatFacts {
  label: string;
  /** e.g. "1920×1080". Note the multiplication sign, not an ASCII x. */
  dimensions: string;
  aspect: string;
  /** One line: what this format is and where it goes. */
  summary: string;
  /** The ceiling that makes the format what it is, or null when there is
   *  none — a long-form video is as long as its script. */
  maxSeconds: number | null;
}

export const VIDEO_FORMATS: Record<VideoFormat, VideoFormatFacts> = {
  LANDSCAPE: {
    label: "Full video",
    dimensions: `${FRAME_SIZES.LANDSCAPE.width}×${FRAME_SIZES.LANDSCAPE.height}`,
    aspect: "16:9",
    summary:
      "A normal YouTube upload. As long as the script is, with shorts cuttable from it afterwards.",
    maxSeconds: null,
  },
  VERTICAL: {
    label: "Short",
    dimensions: `${FRAME_SIZES.VERTICAL.width}×${FRAME_SIZES.VERTICAL.height}`,
    aspect: "9:16",
    summary:
      "A vertical upload for the Shorts feed, composed at 9:16 from the start. Under three minutes, and nothing can be cut out of it.",
    maxSeconds: VERTICAL_MAX_SECONDS,
  },
};

/** How long `wordCount` words take to say at the pipeline's reading pace. The
 *  narration is what sets a video's length — the picture is cut to it — so this
 *  is the runtime estimate everywhere. */
export function estimateSpokenSeconds(wordCount: number): number {
  return (Math.max(0, wordCount) / WORDS_PER_MINUTE) * 60;
}

export type FormatFitVerdict = "fits" | "over" | "far-over";

export interface FormatFit {
  verdict: FormatFitVerdict;
  estimatedSeconds: number;
  maxSeconds: number | null;
}

/**
 * Whether this script can be this format, and how badly it cannot.
 *
 * Three answers rather than two, because the two failures need different
 * handling and lumping them together gets one of them wrong. A script that runs
 * three and a half minutes is a Short an operator may well want anyway —
 * YouTube will still take it, it just will not be in the Shorts feed — so it
 * gets a sentence. A nine-minute script is not the same kind of mistake: it
 * spends nine minutes of ElevenLabs quota and a full render to produce
 * something that cannot be what it was asked for, so the dialog makes the
 * operator say so out loud before it will proceed.
 *
 * Never a hard block. The operator owns their channel, and a limit this code
 * enforces against them is a limit they cannot get out of at two in the morning
 * when they know something this function does not.
 */
export function formatFit(format: VideoFormat, wordCount: number): FormatFit {
  const estimatedSeconds = estimateSpokenSeconds(wordCount);
  const maxSeconds = VIDEO_FORMATS[format].maxSeconds;

  if (maxSeconds === null || estimatedSeconds <= maxSeconds) {
    return { verdict: "fits", estimatedSeconds, maxSeconds };
  }

  return {
    verdict: estimatedSeconds > VERTICAL_HARD_LIMIT_SECONDS ? "far-over" : "over",
    estimatedSeconds,
    maxSeconds,
  };
}

/** "9:12" for 552 seconds. Minutes and seconds rather than decimal minutes,
 *  because the numbers being compared against are platform limits stated in
 *  minutes and seconds. */
export function formatRuntime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
