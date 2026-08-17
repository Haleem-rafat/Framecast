/**
 * Everything about how a video looks and sounds that is a choice rather than a
 * constraint.
 *
 * Deliberately not a database column yet. The destination is a per-channel
 * style — that is the whole "what varies per user is data" direction — but
 * persisting it now would mean a migration, validation and an editor UI before
 * a single improved render exists. Because every setting is already a field on
 * this one object, that change is later a migration plus a loader, with no
 * rewrite of the render code.
 *
 * The loudness target is deliberately NOT here. YouTube normalises playback to
 * about -14 LUFS, so a channel that "prefers" -9 simply gets turned down on
 * playback. Exposing it would offer a choice that does not exist.
 */

export interface MotionStyle {
  enabled: boolean;
  /**
   * The source is scaled by this factor so the crop window has room to travel.
   * The pannable margin is (scale - 1) of the frame.
   */
  scale: number;
}

export interface CaptionStyle {
  /** Must be installed in the worker image — libass falls back silently. */
  fontName: string;
  fontSize: number;
  /** libass wants &HBBGGRR, not #RRGGBB. */
  primaryColour: string;
  outlineColour: string;
  outline: number;
  shadow: number;
  marginV: number;
}

export interface AudioStyle {
  musicGainDb: number;
  sfxGainDb: number;
  duckThreshold: number;
  duckRatio: number;
  duckAttackMs: number;
  duckReleaseMs: number;
}

export interface TransitionStyle {
  enabled: boolean;
  durationSeconds: number;
  /**
   * Which `xfade` transition this join uses — see `TransitionKind` in
   * ffmpeg-command.ts.
   *
   * Optional, and absent means `fade`, which is what every render before this
   * field existed produced. Set per boundary rather than per video by the
   * formats that need one join to read differently from the rest: a dip
   * through black before a payoff line is a beat, and a dissolve is not.
   */
  kind?: "fade" | "fadeblack";
}

export interface VoiceStyle {
  stability: number;
  style: number;
  /**
   * ElevenLabs' `similarity_boost` — how closely the delivery holds to the
   * reference voice rather than drifting toward a neutral read.
   *
   * Optional, and absent means "send nothing and let ElevenLabs use its own
   * default", which is exactly what every render before this field did. Adding
   * it with a value here instead would silently change the sound of every
   * existing channel's narration on the next render.
   */
  similarity?: number;
  speed: number;
  /** Fixed so re-synthesising unchanged text produces the same narration. */
  seed: number;
}

/**
 * Which subtitle file the render burns in.
 *
 * `srt` is what every render this app has ever produced uses: a cue appears
 * whole, disappears whole, and everything about how it looks is said once,
 * globally, through libass's `force_style`.
 *
 * `kinetic` writes ASS instead — one to three words at a time, each landing on
 * the moment it is spoken, with the stressed word in a different colour. Those
 * are per-word facts inside one cue and SRT has nowhere to put them, so it is a
 * different file rather than a flag on the same one (see `kinetic-captions.ts`).
 *
 * A whole-video choice rather than a per-cue one because a video that switched
 * caption styles halfway would read as a fault.
 */
export type CaptionMode = "srt" | "kinetic";

export interface VideoStyle {
  motion: MotionStyle;
  captions: CaptionStyle;
  audio: AudioStyle;
  transitions: TransitionStyle;
  voice: VoiceStyle;
  /**
   * A scalar rather than a section, and the only one on this interface.
   * `brand.service.ts`'s merge treats the two differently — a section is merged
   * field by field, a scalar is replaced outright — because there is nothing
   * inside a string to merge.
   */
  captionMode: CaptionMode;
}

export const DEFAULT_STYLE: VideoStyle = {
  motion: { enabled: true, scale: 1.15 },
  captions: {
    fontName: "DejaVu Sans",
    fontSize: 22,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    outline: 2,
    shadow: 1,
    marginV: 60,
  },
  audio: {
    musicGainDb: -20,
    sfxGainDb: -8,
    duckThreshold: 0.03,
    duckRatio: 8,
    duckAttackMs: 20,
    duckReleaseMs: 300,
  },
  transitions: { enabled: true, durationSeconds: 0.5 },
  voice: { stability: 0.5, style: 0.3, speed: 1.0, seed: 20260811 },
  // The default is the format every existing channel already renders in, so a
  // channel that has never been styled — and every channel styled before this
  // field existed — keeps calling `buildSrt` and producing the argv it always
  // did. Kinetic is opted into per channel.
  captionMode: "srt",
};
