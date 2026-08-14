"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, Ref } from "react";
import {
  CircleAlert,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/utils/format";

/** How far the arrow keys move the playhead. */
const SEEK_STEP_SECONDS = 5;

/** How far the arrow keys move the volume, as a fraction of full. */
const VOLUME_STEP = 0.05;

/**
 * 2× is the ceiling on purpose. Narration review at 1.5× is genuinely useful
 * and 2× is still intelligible; past that a voice track stops being reviewable,
 * which is the only reason this control exists.
 */
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

/**
 * What a bare 404 from one of the media routes actually means, in the words the
 * video page already uses for it.
 *
 * Publishing deletes the local render — `publish.service.ts` reclaims it once
 * YouTube confirms the upload — so `/api/videos/[id]/file` starts answering 404
 * for a video the operator can still see listed. A player left pointing at that
 * shows nothing at all and gives no reason; the browser's own failure mode for
 * a broken media source is silence.
 */
const DEFAULT_ERROR_MESSAGE =
  "This file could not be loaded. It may have been deleted after publishing — reloading the page will show what is still available.";

export type MediaShape = "landscape" | "vertical" | "audio";

/**
 * Time in a form a screen reader reads as time.
 *
 * `formatDuration` produces "2:05", which SRs pronounce as "two oh five" or
 * "two colon zero five" depending on the engine and the surrounding text —
 * neither of which is a length. This is the same instant spelled out.
 */
export function spokenDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  // Always say something, even at exactly 0:00 or an even 2:00.
  if (rest > 0 || parts.length === 0) {
    parts.push(`${rest} second${rest === 1 ? "" : "s"}`);
  }

  return parts.join(" ");
}

/** The structural half of `TimeRanges` — enough to compute against, and
 *  testable without a DOM. */
interface TimeRangeList {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * How far the browser has buffered continuously *from the playhead*.
 *
 * `buffered` is a set of disjoint ranges, and after a seek the ranges behind
 * the playhead are usually the largest ones. Drawing `end(length - 1)` — the
 * obvious reading — would paint a buffered bar over stretches the player would
 * still have to fetch. Only the range containing the playhead is a promise
 * about what plays next; anything else returns the playhead itself, which draws
 * no bar at all.
 */
export function bufferedAheadOf(
  ranges: TimeRangeList | null | undefined,
  seconds: number,
): number {
  if (!ranges) {
    return seconds;
  }

  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= seconds && seconds <= ranges.end(index)) {
      return ranges.end(index);
    }
  }

  return seconds;
}

/** A three-stop track: played, buffered-but-unplayed, and the rest. */
function trackGradient(playedRatio: number, bufferedRatio: number): string {
  const played = clampRatio(playedRatio) * 100;
  const buffered = Math.max(played, clampRatio(bufferedRatio) * 100);

  return [
    "linear-gradient(to right,",
    `var(--primary) 0 ${played}%,`,
    `color-mix(in oklab, var(--foreground) 30%, transparent) ${played}% ${buffered}%,`,
    `var(--muted) ${buffered}% 100%)`,
  ].join(" ");
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Ranges are the only inputs inside a player, so this is belt-and-braces —
 *  but it is the guarantee that the keyboard shortcuts can never eat a
 *  keystroke meant for a form. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return target.type !== "range";
  }
  return target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const RANGE_CLASS = cn(
  // The box is 24px tall for a comfortable pointer target; the visible track
  // inside it is 6px. `--track` is set per-render by the caller.
  "focus-visible:ring-ring/50 h-6 w-full cursor-pointer appearance-none rounded-full",
  "bg-transparent outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full",
  "[&::-webkit-slider-runnable-track]:[background-image:var(--track)]",
  "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full",
  "[&::-moz-range-track]:[background-image:var(--track)]",
  // -3px lifts the 12px thumb to sit centred on the 6px track.
  "[&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:-mt-[3px]",
  "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none",
  "[&::-webkit-slider-thumb]:rounded-full",
  "[&::-webkit-slider-thumb]:shadow-[0_0_0_2px_var(--background)]",
  "[&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:size-3",
  "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
);

export interface MediaPlayerHandle {
  /** Move the playhead. The element's own `seeked` reports back through
   *  `onTimeChange` with whatever it actually landed on. */
  seek(seconds: number): void;
  play(): void;
  pause(): void;
}

/** iOS Safari refuses `requestFullscreen` on a container and only ever
 *  fullscreens the video element itself. */
interface MaybeIosVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

interface MediaPlayerProps {
  src: string;
  /**
   * The player's accessible name, and required for that reason: a bare
   * `<video>` has none at all, and a heading beside it is a sibling rather
   * than an association a screen reader can make.
   */
  label: string;
  shape: MediaShape;
  /** Applied to the player's outer box. */
  className?: string;
  autoPlay?: boolean;
  /**
   * The element's clock, on `timeupdate` (roughly four a second), `seeked`
   * and `loadedmetadata`. This is the only playback position this component
   * publishes — there is no interval and no parallel clock that could drift
   * from what is actually on screen.
   */
  onTimeChange?: (seconds: number) => void;
  /** Fired once when the source fails to load, so a caller with a fallback
   *  (the YouTube embed, say) can show it instead of this player's message. */
  onError?: () => void;
  /** Replaces the whole player. Defaults to the reclaimed-render wording. */
  errorMessage?: string;
  ref?: Ref<MediaPlayerHandle>;
}

/**
 * The one media player: the finished landscape render, a vertical short, and
 * narration audio, all through the same controls.
 *
 * Native controls were the honest default for as long as there was nothing to
 * add to them, and they are not what this replaces them for. Three things they
 * cannot do here: playback rate, which Safari does not offer at all and Chrome
 * hides in a context menu, and which is the whole reason a fifteen-minute
 * narration is reviewable; a buffered range, which matters when the source is a
 * 170MB file streamed off this app's own disk; and an error that says what
 * happened, where the browser's failure mode for a 404 source is silence.
 * Everything they *did* do is rebuilt on real controls — `<button>` and
 * `<input type="range">` — so focus, arrow keys and screen-reader semantics
 * come from the platform rather than from an ARIA impression of it.
 *
 * `preload="metadata"` is hardcoded and there is no prop to change it. The
 * default is `auto`, which had the video page streaming a finished render —
 * hundreds of megabytes — before anyone pressed play. Metadata is a couple of
 * ranged requests against a `+faststart` MP4 and is all a duration and a scrub
 * bar need. Making it the component's only setting is what stops the next
 * player from quietly reintroducing the problem.
 *
 * No `<track>` and no caption toggle: captions are burned into the render by
 * the ffmpeg pass, so there is no text track to switch and a control offering
 * to would do nothing.
 */
export function MediaPlayer({
  src,
  label,
  shape,
  className,
  autoPlay = false,
  onTimeChange,
  onError,
  errorMessage,
  ref,
}: MediaPlayerProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  const isVideo = shape !== "audio";

  // Kept in refs so a caller passing an inline arrow does not have to memoise
  // it to avoid re-subscribing anything.
  const onTimeChangeRef = useRef(onTimeChange);
  onTimeChangeRef.current = onTimeChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /**
   * Adopt whatever the element already is, rather than assuming it is new.
   *
   * `preload="metadata"` starts the fetch while the HTML is still being
   * parsed — before React hydrates and before a single one of the handlers
   * below is attached. For a small file on a fast connection that means
   * `loadedmetadata` has already fired and been heard by nobody, leaving a
   * player with a real duration showing `--:--` and a dead scrub bar; for a
   * source that 404s it means `error` fired unobserved, leaving the dead
   * player this component exists to replace. The element keeps both as
   * state — `readyState`, `duration`, `error` — so the fix is to read it once
   * on mount instead of waiting for events that have been and gone.
   *
   * Re-runs on `src` because a new source is a new recording: the old
   * duration and playhead describe nothing, and a previous failure says
   * nothing about this one.
   */
  useEffect(() => {
    const media = mediaRef.current;

    setCurrentTime(media?.currentTime ?? 0);
    setBufferedEnd(0);
    setIsPlaying(media ? !media.paused : false);
    setDuration(
      media && Number.isFinite(media.duration) ? media.duration : 0,
    );

    if (media?.error) {
      setHasFailed(true);
      onErrorRef.current?.();
    } else {
      setHasFailed(false);
    }
  }, [src]);

  useImperativeHandle(
    ref,
    () => ({
      seek(seconds: number) {
        const media = mediaRef.current;
        if (!media) {
          return;
        }
        media.currentTime = seconds;
        // Optimistic only so this player's own scrub bar moves the instant a
        // seek is asked for while paused; `seeked` corrects it to whatever the
        // element landed on, which for a keyframe-sparse encode is not always
        // the second that was requested.
        setCurrentTime(seconds);
      },
      play() {
        void mediaRef.current?.play().catch(() => {
          // Autoplay policy, or a source that never loaded. `error` and the
          // paused state already tell the operator everything either means.
        });
      },
      pause() {
        mediaRef.current?.pause();
      },
    }),
    [],
  );

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const publishTime = useCallback(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }
    setCurrentTime(media.currentTime);
    setBufferedEnd(bufferedAheadOf(media.buffered, media.currentTime));
    onTimeChangeRef.current?.(media.currentTime);
  }, []);

  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }

    if (media.paused) {
      void media.play().catch(() => {});
    } else {
      media.pause();
    }
  }, []);

  const seekBy = useCallback((delta: number) => {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration)) {
      return;
    }
    const next = Math.min(
      media.duration,
      Math.max(0, media.currentTime + delta),
    );
    media.currentTime = next;
    setCurrentTime(next);
  }, []);

  const nudgeVolume = useCallback((delta: number) => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }
    const next = Math.min(1, Math.max(0, media.volume + delta));
    media.volume = next;
    // Raising the volume off a muted player is what the operator meant.
    if (next > 0) {
      media.muted = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const media = mediaRef.current;
    if (media) {
      media.muted = !media.muted;
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }

    const container = containerRef.current;
    if (container?.requestFullscreen) {
      void container.requestFullscreen().catch(() => {});
      return;
    }

    (mediaRef.current as MaybeIosVideo | null)?.webkitEnterFullscreen?.();
  }, []);

  /**
   * The shortcuts, bound to this player's own subtree and nowhere else.
   *
   * A document listener is what every tutorial reaches for and is wrong here:
   * the app has a ⌘K palette and forms on the same pages, and a global `f`
   * would go fullscreen while somebody typed a title. React events bubble, so
   * a handler on the container fires for a keystroke anywhere inside it and
   * for no keystroke outside — which is exactly "only when the player has
   * focus", with no focus tracking to keep in sync.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isTextEntry(event.target)) {
        return;
      }

      switch (event.key) {
        case " ":
        case "k": {
          // Space on a focused button is that button's own activation. Eating
          // it would toggle playback twice, or mute *and* toggle playback.
          if (
            event.key === " " &&
            event.target instanceof HTMLElement &&
            event.target.closest("button")
          ) {
            return;
          }
          event.preventDefault();
          toggle();
          break;
        }
        case "ArrowLeft":
          event.preventDefault();
          seekBy(-SEEK_STEP_SECONDS);
          break;
        case "ArrowRight":
          event.preventDefault();
          seekBy(SEEK_STEP_SECONDS);
          break;
        case "ArrowUp":
          event.preventDefault();
          nudgeVolume(VOLUME_STEP);
          break;
        case "ArrowDown":
          event.preventDefault();
          nudgeVolume(-VOLUME_STEP);
          break;
        case "m":
          event.preventDefault();
          toggleMute();
          break;
        case "f":
          if (isVideo) {
            event.preventDefault();
            toggleFullscreen();
          }
          break;
        default:
          break;
      }
    },
    [isVideo, nudgeVolume, seekBy, toggle, toggleFullscreen, toggleMute],
  );

  if (hasFailed) {
    return (
      <div
        role="status"
        className={cn(
          "text-muted-foreground flex items-start gap-2 rounded-md border border-dashed p-4 text-sm",
          className,
        )}
      >
        <CircleAlert
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <span>
          <span className="sr-only">{label}: </span>
          {errorMessage ?? DEFAULT_ERROR_MESSAGE}
        </span>
      </div>
    );
  }

  const hasDuration = duration > 0;
  const playedRatio = hasDuration ? currentTime / duration : 0;
  const bufferedRatio = hasDuration ? bufferedEnd / duration : 0;
  const effectiveVolume = isMuted ? 0 : volume;

  const mediaProps = {
    ref: (node: HTMLMediaElement | null) => {
      mediaRef.current = node;
    },
    src,
    autoPlay,
    // See the component comment: hardcoded, deliberately unconfigurable.
    preload: "metadata" as const,
    "aria-label": label,
    onPlay: () => {
      setIsPlaying(true);
      pauseOtherMedia(mediaRef.current);
    },
    onPause: () => {
      setIsPlaying(false);
      setIsWaiting(false);
    },
    onWaiting: () => setIsWaiting(true),
    onPlaying: () => setIsWaiting(false),
    onTimeUpdate: publishTime,
    onSeeked: publishTime,
    onProgress: publishTime,
    onLoadedMetadata: () => {
      const media = mediaRef.current;
      // Live streams report Infinity. Nothing here is one, but a NaN duration
      // before metadata arrives is the same shape of value and the scrub bar
      // must refuse both rather than render `max={NaN}`.
      setDuration(
        media && Number.isFinite(media.duration) ? media.duration : 0,
      );
      publishTime();
    },
    onVolumeChange: () => {
      const media = mediaRef.current;
      if (media) {
        setVolume(media.volume);
        setIsMuted(media.muted);
      }
    },
    onRateChange: () => {
      const media = mediaRef.current;
      if (media) {
        setRate(media.playbackRate);
      }
    },
    onEnded: () => setIsPlaying(false),
    onError: () => {
      setHasFailed(true);
      onErrorRef.current?.();
    },
  };

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={label}
      // Click anywhere on the player and the shortcuts work. Keyboard users
      // reach the controls by tabbing, which puts focus inside this container
      // too — so this is not a tab stop of its own.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        // Container queries rather than viewport ones: a short's player is
        // narrow because its column is narrow, on a screen of any width.
        "@container/player space-y-1 outline-none",
        isFullscreen && "flex size-full flex-col justify-center bg-black p-4",
        className,
      )}
    >
      {isVideo ? (
        <div
          className={cn(
            "relative overflow-hidden rounded-md bg-black",
            shape === "vertical"
              ? // Constrained by height. A 9:16 clip given the width of its
                // column would be twice the height of the page it sits on.
                "mx-auto aspect-[9/16] h-64 max-h-[60svh] w-auto"
              : "aspect-video w-full",
            isFullscreen && "aspect-auto size-full min-h-0 flex-1",
          )}
        >
          {/* No <track>: captions are burned into the render itself. */}
          <video {...mediaProps} className="size-full object-contain" />

          {/* Pointer affordance only: the control bar below already exposes
              play/pause to the keyboard and to assistive tech, and a second
              button for the same action is one more thing to tab past. */}
          <div
            aria-hidden="true"
            onClick={toggle}
            className={cn(
              "absolute inset-0 flex cursor-pointer items-center justify-center",
              !reducedMotion && "transition-opacity duration-200",
              isPlaying ? "opacity-0" : "opacity-100",
            )}
          >
            {!isPlaying && (
              <span className="rounded-full bg-black/55 p-3 text-white">
                <Play className="size-6" />
              </span>
            )}
          </div>

          {isWaiting && (
            <span
              className={cn(
                "absolute top-2 right-2 rounded-md bg-black/70 px-2 py-1 text-xs text-white",
                // The word is the signal; the pulse is decoration, and is the
                // only animation in this component worth suppressing.
                !reducedMotion && "animate-pulse",
              )}
            >
              Buffering…
            </span>
          )}
        </div>
      ) : (
        <audio {...mediaProps} className="sr-only" />
      )}

      <div
        className={cn(
          shape === "audio" && "bg-muted/40 space-y-1 rounded-md px-2 py-1.5",
        )}
      >
        <input
          type="range"
          min={0}
          max={hasDuration ? duration : 1}
          // Fine enough to drag smoothly. The arrow keys are handled above in
          // whole seconds instead, because a 0.01s step is not a seek.
          step={0.01}
          value={Math.min(currentTime, hasDuration ? duration : 1)}
          disabled={!hasDuration}
          aria-label={`Seek ${label}`}
          aria-valuetext={
            hasDuration
              ? `${spokenDuration(currentTime)} of ${spokenDuration(duration)}`
              : "Length not known yet"
          }
          onChange={(event) => {
            const next = Number(event.target.value);
            const media = mediaRef.current;
            if (media) {
              media.currentTime = next;
            }
            setCurrentTime(next);
          }}
          style={
            { "--track": trackGradient(playedRatio, bufferedRatio) } as CSSProperties
          }
          className={RANGE_CLASS}
        />

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggle}
            aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
          >
            {isPlaying ? <Pause /> : <Play />}
          </Button>

          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            <span aria-hidden="true">
              {formatDuration(currentTime)} /{" "}
              {hasDuration ? formatDuration(duration) : "--:--"}
            </span>
            {/* The same instant in words. Reading "1:05" aloud is the engine's
                guess; this is not. */}
            <span className="sr-only">
              {spokenDuration(currentTime)} of{" "}
              {hasDuration ? spokenDuration(duration) : "an unknown length"}
            </span>
          </span>

          {shape === "audio" && isWaiting && (
            <span
              className={cn(
                "text-muted-foreground text-xs",
                !reducedMotion && "animate-pulse",
              )}
            >
              Buffering…
            </span>
          )}

          <div className="flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tabular-nums"
                aria-label={`Playback speed, currently ${rate} times normal`}
              >
                <span aria-hidden="true">{rate}×</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={String(rate)}
                onValueChange={(value) => {
                  const media = mediaRef.current;
                  if (media) {
                    media.playbackRate = Number(value);
                  }
                }}
              >
                {PLAYBACK_RATES.map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={String(option)}
                    aria-label={`${option} times normal speed`}
                  >
                    <span aria-hidden="true">{option}×</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeX /> : <Volume2 />}
          </Button>

          <input
            type="range"
            min={0}
            max={1}
            step={VOLUME_STEP}
            value={effectiveVolume}
            aria-label="Volume"
            aria-valuetext={`${Math.round(effectiveVolume * 100)} percent`}
            onChange={(event) => {
              const media = mediaRef.current;
              if (media) {
                media.volume = Number(event.target.value);
                media.muted = Number(event.target.value) === 0;
              }
            }}
            // Its own arrow handling is the native one, in 5% steps — so the
            // player's seek shortcuts must not also fire here.
            onKeyDown={(event) => {
              if (event.key.startsWith("Arrow")) {
                event.stopPropagation();
              }
            }}
            style={
              { "--track": trackGradient(effectiveVolume, 0) } as CSSProperties
            }
            // Hidden in a narrow column and on a phone, where the OS owns the
            // volume anyway. The mute button beside it stays.
            className={cn(RANGE_CLASS, "hidden w-16 shrink-0 @xs/player:block")}
          />

          {isVideo && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            >
              {isFullscreen ? <Minimize /> : <Maximize />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One player at a time, with the DOM as the registry.
 *
 * The voice page lists every narration ever synthesised and the video page
 * stacks a render, its narration and a row of shorts; starting one while
 * another plays is two voices at once. A module-level "currently playing"
 * variable would do it, and would also be a singleton that survives every
 * client-side navigation — one stale reference to an element from a page the
 * operator left, held for the life of the tab.
 *
 * The elements themselves are the better registry: they are already on the
 * page, they are already unmounted when the page changes, and asking for them
 * costs one query at the moment somebody presses play.
 */
function pauseOtherMedia(current: HTMLMediaElement | null) {
  for (const element of document.querySelectorAll<HTMLMediaElement>(
    "video, audio",
  )) {
    if (element !== current && !element.paused) {
      element.pause();
    }
  }
}
