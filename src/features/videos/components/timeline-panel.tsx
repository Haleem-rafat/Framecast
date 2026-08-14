"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  Clapperboard,
  Info,
  Replace,
  Unlink,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TimelineFootageDialog } from "@/features/videos/components/timeline-footage-dialog";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type {
  TimelineBlock,
  TimelineClip,
  TimelineSection,
  VideoTimeline,
} from "@/services/timeline.service";
import { formatBytes, formatDuration } from "@/utils/format";

/**
 * The narrowest a track block may be drawn.
 *
 * A proportional strip is honest right up until a section's real share is two
 * pixels wide, at which point it is a thing an operator can see but not hit —
 * and on a 375px phone with twenty sections that is every one of them. Each
 * block is therefore `max(its share, this)`, and the strip scrolls sideways
 * inside its own container when the floors add up to more than the card is
 * wide. Proportions survive everywhere they can be seen; only the sections too
 * short to draw are widened, and the row underneath states their real length in
 * seconds regardless. 2.75rem is the 44px touch target.
 */
const MIN_BLOCK_REM = 2.75;

function secondsLabel(seconds: number): string {
  // Below a minute the tenths are the interesting part — a 1.4s section and a
  // 1.9s one are meaningfully different and both round to "1s". Above it,
  // m:ss is what the player's own scrubber shows.
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatDuration(seconds);
}

function clipName(clip: TimelineClip): string {
  if (!clip.provider || !clip.externalId) {
    return "stored clip";
  }

  const source = clip.provider === "PEXELS" ? "Pexels" : "Pixabay";
  return `${source} #${clip.externalId}`;
}

/**
 * Which section is on screen at `seconds`.
 *
 * A linear scan, deliberately: it runs at most four times a second (the rate
 * `timeupdate` fires) over a list that is tens of entries long, and a binary
 * search here would be a cleverness with no measurable payoff. Returns -1
 * before the first section, which is only reachable if the sections do not
 * start at 0 — they always do, since `sectionDurations` pins the first
 * boundary there.
 */
function activeSectionAt(
  entries: { startSeconds: number; durationSeconds: number }[],
  seconds: number,
): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (seconds >= entries[index].startSeconds) {
      return index;
    }
  }

  return -1;
}

/** The proportional strip: the whole video at a glance, one block per section. */
function TimelineTrack({
  entries,
  activeIndex,
  activeProgress,
  reducedMotion,
  labelFor,
  onSeek,
}: {
  entries: {
    startSeconds: number;
    durationSeconds: number;
    visibleSeconds?: number;
  }[];
  activeIndex: number;
  /** 0-1 through the active block. Drawn inside that block rather than as a
   *  playhead positioned along the whole strip, because a block widened to the
   *  touch-target floor is no longer where its share of the timeline says it
   *  is — a strip-wide playhead would drift away from the block it is meant to
   *  be inside. */
  activeProgress: number;
  reducedMotion: boolean;
  labelFor: (index: number) => string;
  onSeek: (index: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Keeps the playing section visible when the strip is wider than the card.
    // `nearest` on both axes so this never yanks the page vertically to a card
    // the operator has scrolled away from.
    activeRef.current?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeIndex, reducedMotion]);

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <div className="flex min-w-full gap-0.5">
        {entries.map((entry, index) => {
          const isActive = index === activeIndex;
          // A block the assemble pass cuts off the end of an uncued video's
          // timeline: it exists in the plan and is never seen.
          const unseen = entry.visibleSeconds === 0;

          return (
            <button
              key={index}
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => onSeek(index)}
              aria-label={labelFor(index)}
              aria-current={isActive ? "true" : undefined}
              style={{
                flexGrow: entry.durationSeconds,
                flexBasis: 0,
                minWidth: `${MIN_BLOCK_REM}rem`,
              }}
              className={cn(
                "focus-visible:ring-ring/50 relative h-12 shrink-0 overflow-hidden rounded-sm",
                "focus-visible:ring-[3px] focus-visible:outline-none",
                isActive
                  ? "bg-primary/25"
                  : "bg-muted hover:bg-muted-foreground/20",
                unseen && "opacity-40",
                !reducedMotion && "transition-colors",
              )}
            >
              {isActive && (
                <span
                  aria-hidden
                  className={cn(
                    "bg-primary/60 absolute inset-y-0 left-0",
                    // `timeupdate` fires about four times a second, so the fill
                    // would step rather than sweep. The transition covers the
                    // gap between ticks — and is dropped entirely for anyone
                    // who asked for less motion, leaving the same four honest
                    // steps a second.
                    !reducedMotion &&
                      "transition-[width] duration-200 ease-linear",
                  )}
                  style={{
                    width: `${Math.min(100, Math.max(0, activeProgress * 100))}%`,
                  }}
                />
              )}
              <span className="text-foreground/70 relative text-xs font-medium tabular-nums">
                {index + 1}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One script section: what is said, when, and what is on screen while it is. */
function SectionRow({
  section,
  isActive,
  clipsReclaimed,
  reducedMotion,
  onSeek,
  onReplace,
}: {
  section: TimelineSection;
  isActive: boolean;
  /** Changes what an absent clip *means*: publishing deletes them, so "none
   *  collected" would be a plain lie about a video that had one for every
   *  section right up until it was uploaded. */
  clipsReclaimed: boolean;
  reducedMotion: boolean;
  onSeek: () => void;
  /** Absent when this video can no longer be re-rendered, so the control that
   *  would store an edit nothing will read is not shown at all. */
  onReplace: (() => void) | null;
}) {
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:gap-3",
        isActive && "border-primary/40 bg-primary/5",
        !reducedMotion && "transition-colors",
      )}
    >
      <button
        type="button"
        onClick={onSeek}
        className="focus-visible:ring-ring/50 -m-1 flex min-w-0 flex-1 gap-3 rounded-md p-1 text-left focus-visible:ring-[3px] focus-visible:outline-none"
      >
        <span className="flex w-14 shrink-0 flex-col items-start">
          <span className="text-sm font-medium tabular-nums">
            {formatDuration(section.startSeconds)}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {secondsLabel(section.durationSeconds)}
          </span>
        </span>

        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="block text-sm">{section.narration}</span>

          <span className="text-muted-foreground block text-xs">
            <span className="font-medium">{section.cue}</span>
            {" · "}
            {section.clip ? (
              <>
                {clipName(section.clip)}
                {section.clip.sizeBytes !== null &&
                  ` · ${formatBytes(section.clip.sizeBytes)}`}
              </>
            ) : clipsReclaimed ? (
              "clip deleted after publishing"
            ) : (
              "no clip collected"
            )}
          </span>

          {section.absorbedOrphanCues.length > 0 && (
            // The thing an operator would actually want to fix. This section's
            // one clip is playing under its own words *and* the words of
            // however many cues no longer match the script — those stretches
            // have no footage of their own at all.
            <span className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <Unlink className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                Also covers {section.absorbedOrphanCues.length} stretch
                {section.absorbedOrphanCues.length === 1 ? "" : "es"} whose cue
                no longer matches the script (
                {section.absorbedOrphanCues.join(", ")}) — this clip plays under
                those words too.
              </span>
            </span>
          )}

          {section.clip && section.clip.alsoUsedBySections.length > 0 && (
            <span className="text-muted-foreground block text-xs">
              Same clip as section
              {section.clip.alsoUsedBySections.length === 1 ? " " : "s "}
              {section.clip.alsoUsedBySections
                .map((other) => other + 1)
                .join(", ")}{" "}
              — footage collection copies a neighbour&apos;s clip when a
              section&apos;s own search finds nothing, so this picture was not
              matched to these words.
            </span>
          )}
        </span>
      </button>

      {onReplace && (
        <Button
          size="sm"
          variant="outline"
          onClick={onReplace}
          className="shrink-0 self-start"
        >
          <Replace />
          Replace footage
        </Button>
      )}
    </li>
  );
}

/** One block of an uncued video's timeline. No narration to show: nothing in a
 *  pre-cue script says where one idea ends and the next begins. */
function BlockRow({
  block,
  isActive,
  reducedMotion,
  onSeek,
}: {
  block: TimelineBlock;
  isActive: boolean;
  reducedMotion: boolean;
  onSeek: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSeek}
        className={cn(
          "focus-visible:ring-ring/50 flex w-full gap-3 rounded-lg border p-3 text-left",
          "focus-visible:ring-[3px] focus-visible:outline-none",
          isActive && "border-primary/40 bg-primary/5",
          !reducedMotion && "transition-colors",
        )}
      >
        <span className="w-14 shrink-0 text-sm font-medium tabular-nums">
          {formatDuration(block.startSeconds)}
        </span>
        <span className="min-w-0 flex-1 text-sm">
          {clipName(block.clip)}
          <span className="text-muted-foreground block text-xs">
            {secondsLabel(block.durationSeconds)} on screen
            {block.clip.sizeBytes !== null &&
              ` · ${formatBytes(block.clip.sizeBytes)}`}
            {block.visibleSeconds === 0 &&
              " · never seen — the render is cut to the narration's length before this plays"}
            {block.visibleSeconds > 0 &&
              block.visibleSeconds < block.durationSeconds &&
              ` · cut short at ${secondsLabel(block.visibleSeconds)}`}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The video and its timeline, as one card.
 *
 * The studio's central object is a video, and everywhere else in this app it is
 * a row in a table. This is the one view that shows it as a video: the render
 * itself, above a strip of every section sized by how long it actually holds
 * the screen, above the same sections written out with their narration and the
 * clip playing under each.
 *
 * The timings are not this component's own. They are computed server-side by
 * `timelineService.get`, which runs the identical `anchorCues` → `cueWindows` →
 * `sectionDurations` chain that `render.service.ts` hands to FFmpeg (see
 * `planSections` for the full derivation), so a block drawn here is the slot
 * that was encoded rather than an estimate of it.
 *
 * Playback position comes from the `<video>` element and nowhere else — no
 * interval, no parallel clock that could drift from what the operator is
 * actually watching. `timeupdate` is a coarse signal (roughly four a second),
 * which is plenty for highlighting a section that lasts seconds and is smoothed
 * over with a CSS transition for anyone who has not asked for less motion.
 *
 * Nothing here edits the finished MP4, and the card says so wherever an edit is
 * offered: a swap replaces the footage the *next* render will use.
 */
export function TimelinePanel({ timeline }: { timeline: VideoTimeline }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [currentTime, setCurrentTime] = useState(0);
  const [replacingSection, setReplacingSection] =
    useState<TimelineSection | null>(null);

  const entries =
    timeline.mode === "pool" ? timeline.blocks : timeline.sections;
  const activeIndex = activeSectionAt(entries, currentTime);
  const activeEntry = activeIndex >= 0 ? entries[activeIndex] : null;
  const activeProgress = activeEntry
    ? (currentTime - activeEntry.startSeconds) /
      Math.max(activeEntry.durationSeconds, 0.001)
    : 0;

  const seekTo = useCallback(
    (index: number) => {
      const video = videoRef.current;
      const entry = entries[index];

      if (!entry) {
        return;
      }

      // Optimistic, and only so the highlight moves the instant a section is
      // clicked on a video that is paused — `seeked` below corrects it to
      // whatever the element actually landed on, which for a keyframe-sparse
      // encode is not always the second that was asked for.
      setCurrentTime(entry.startSeconds);

      if (video) {
        video.currentTime = entry.startSeconds;
      }
    },
    [entries],
  );

  const readTime = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      setCurrentTime(video.currentTime);
    }
  }, []);

  const labelFor = useCallback(
    (index: number) => {
      const entry = entries[index];
      const at = formatDuration(entry.startSeconds);
      const length = secondsLabel(entry.durationSeconds);

      if (timeline.mode === "pool") {
        return `Clip ${index + 1}, from ${at}, ${length}`;
      }

      return `Section ${index + 1}, from ${at}, ${length}: ${timeline.sections[index].cue}`;
    },
    [entries, timeline.mode, timeline.sections],
  );

  return (
    // Bare: the collapsible `VideoSection` around this supplies the card and
    // the "Timeline" heading, so a card and title here would duplicate both.
    <div className="space-y-4">
      {/* Wraps rather than sitting on one row — at 375px the description and
          the duration badge together overflow the screen. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-muted-foreground max-w-prose text-xs">
          {timeline.mode === "sections"
            ? "Every section of the script, sized by how long it holds the screen. Click one to jump there."
            : timeline.mode === "pool"
              ? "This video's clips, each holding the screen for an equal share of the narration."
              : "Where each part of the script lands in the finished video."}
        </p>

        {/* The duration badge that used to sit here is gone: the section
            header above already carries it, and two copies of "3:20" one line
            apart read as two different numbers that happen to match. */}
      </div>

      <div className="space-y-4">
        {timeline.renderUrl ? (
          // No <track>: captions are burned into the render itself.
          <video
            ref={videoRef}
            controls
            preload="metadata"
            src={timeline.renderUrl}
            onTimeUpdate={readTime}
            onSeeked={readTime}
            onLoadedMetadata={readTime}
            className="aspect-video w-full rounded-md bg-black"
          />
        ) : (
          <Alert>
            <Clapperboard />
            <AlertTitle>No video to play yet</AlertTitle>
            <AlertDescription>
              {timeline.clipsReclaimed
                ? "This video is on YouTube and the local render was deleted after the upload. The timeline below still describes it exactly — every timing is read off the narration, not the file."
                : "Nothing has rendered yet, so there is nothing to scrub. The timeline below is what the render will be cut to."}
            </AlertDescription>
          </Alert>
        )}

        {timeline.mode === "empty" ? (
          <p className="text-muted-foreground text-sm">
            {timeline.emptyReason}
          </p>
        ) : (
          <>
            <TimelineTrack
              entries={entries}
              activeIndex={activeIndex}
              activeProgress={activeProgress}
              reducedMotion={reducedMotion}
              labelFor={labelFor}
              onSeek={seekTo}
            />

            {timeline.mode === "pool" && (
              <Alert>
                <Info />
                <AlertTitle>
                  This video&apos;s footage is a shared pool
                </AlertTitle>
                <AlertDescription>
                  Its clips were collected for the video&apos;s topic rather
                  than for individual sections, which is how footage worked
                  before per-section matching. Each clip simply holds the screen
                  for an equal share of the narration and stands in no relation
                  to what is being said, so there is no single section&apos;s
                  clip to replace.
                </AlertDescription>
              </Alert>
            )}

            {timeline.footageIncomplete && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>Some sections have no footage</AlertTitle>
                <AlertDescription>
                  Rendering is refused while that is true, and rightly — every
                  section after a gap would play against the wrong words.
                  Running footage collection again fills the gaps from the
                  sections that did collect.
                </AlertDescription>
              </Alert>
            )}

            {timeline.orphanedCueCount > 0 && (
              <Alert>
                <Unlink />
                <AlertTitle>
                  {timeline.orphanedCueCount} b-roll cue
                  {timeline.orphanedCueCount === 1 ? "" : "s"} no longer match
                  {timeline.orphanedCueCount === 1 ? "es" : ""} the script
                </AlertTitle>
                <AlertDescription>
                  A cue is found by the opening words of its section, so
                  rewriting an opening drops that cue rather than guessing at
                  where it went. Those stretches get no footage of their own —
                  the section before them holds the screen through it. They are
                  marked below.
                </AlertDescription>
              </Alert>
            )}

            <ul className="space-y-2">
              {timeline.mode === "pool"
                ? timeline.blocks.map((block) => (
                    <BlockRow
                      key={block.index}
                      block={block}
                      isActive={block.index === activeIndex}
                      reducedMotion={reducedMotion}
                      onSeek={() => seekTo(block.index)}
                    />
                  ))
                : timeline.sections.map((section) => (
                    <SectionRow
                      key={section.index}
                      section={section}
                      isActive={section.index === activeIndex}
                      clipsReclaimed={timeline.clipsReclaimed}
                      reducedMotion={reducedMotion}
                      onSeek={() => seekTo(section.index)}
                      onReplace={
                        timeline.swapBlockedReason === null &&
                        section.clip !== null
                          ? () => setReplacingSection(section)
                          : null
                      }
                    />
                  ))}
            </ul>

            {/* The one thing that must never be left implied. Every edit here is
             * an edit to what the *next* render reads; the MP4 that exists is
             * never touched, and the re-run is the pipeline's existing control,
             * not one this card invents. */}
            <p className="text-muted-foreground text-xs">
              {timeline.swapBlockedReason === null
                ? `Replacing a section's footage changes what the next render uses — the video that exists now is unchanged until then. ${
                    timeline.rerun.control === "retry"
                      ? "Retry on the Pipeline tab re-renders it."
                      : "Run on the Pipeline tab re-renders it."
                  }`
                : timeline.swapBlockedReason}
            </p>
          </>
        )}
      </div>

      {replacingSection && (
        <TimelineFootageDialog
          videoId={timeline.videoId}
          sectionIndex={replacingSection.index}
          cue={replacingSection.cue}
          open
          onOpenChange={(open) => {
            if (!open) setReplacingSection(null);
          }}
        />
      )}
    </div>
  );
}
