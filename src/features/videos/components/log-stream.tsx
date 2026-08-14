"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getPipelineLogsAction } from "@/actions/video.action";
import {
  POLL_INTERVAL_ACTIVE_MS,
  usePipelineState,
} from "@/features/videos/components/pipeline-panel";
import type { LogLevel } from "@/generated/prisma/enums";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type {
  PipelineLogEntry,
  PipelineLogSource,
  PipelineLogStream,
  PipelineState,
} from "@/services/pipeline.service";

type LevelFilter = "all" | "warnings";

const SOURCE_LABEL: Record<PipelineLogSource, string> = {
  render: "Render",
  status: "Status",
  activity: "Activity",
};

/**
 * The level's colour, applied to the level tag *and* the line it introduces.
 *
 * Colouring only the tag left a wall of identically-grey messages with a
 * coloured full stop at the start of each — the thing an operator is scanning
 * for when they open a log is the failing line, not the word "ERROR". The
 * amber and destructive tones carry the whole row; DEBUG and INFO deliberately
 * carry nothing, because a log where every line is emphasised has no emphasis.
 */
const LEVEL_CLASS: Record<LogLevel, { tag: string; row: string }> = {
  DEBUG: { tag: "text-muted-foreground/70", row: "" },
  INFO: { tag: "text-muted-foreground", row: "" },
  // amber-600 measures near 3:1 against the panel, under the 4.5:1 this 12px
  // text needs. 700 reads as the same warning colour and clears it.
  WARN: {
    tag: "text-amber-700 dark:text-amber-300",
    row: "bg-amber-500/5 border-l-2 border-amber-700/50 dark:border-amber-400/50",
  },
  ERROR: {
    tag: "text-destructive",
    row: "bg-destructive/5 border-l-2 border-destructive/60",
  },
};

function isWarningOrWorse(level: LogLevel): boolean {
  return level === "WARN" || level === "ERROR";
}

async function fetchLogs(videoId: string): Promise<PipelineLogStream> {
  const result = await getPipelineLogsAction(videoId);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

function formatTimestamp(createdAt: Date): string {
  // `createdAt` crosses a server action, which is not always a Date by the
  // time it lands here even though the service types it as one — wrapping in
  // `new Date(...)` is a no-op for a real Date and a safety net for a
  // serialized string, either way cheap enough not to matter.
  return format(new Date(createdAt), "HH:mm:ss");
}

function copyText(entries: PipelineLogEntry[]): string {
  return entries
    .map(
      (entry) =>
        `[${formatTimestamp(entry.createdAt)}] ${entry.level} ${SOURCE_LABEL[entry.source]}: ${entry.message}`,
    )
    .join("\n");
}

/**
 * What the console shows while a run is producing no output yet.
 *
 * A stage can spend a minute inside a provider call without writing a line,
 * and an empty black box is indistinguishable from a broken one. The blinking
 * caret says the same thing a terminal's does: this is waiting for output, not
 * finished. It is rendered only while the pipeline query says the run is
 * active, so it can never sit blinking over a run that has stopped.
 */
function AwaitingOutput({ reduced }: { reduced: boolean }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 py-6 text-center font-mono text-xs">
      <span aria-hidden="true">$</span>
      <span>waiting for output</span>
      <span
        aria-hidden="true"
        className={cn(
          "bg-muted-foreground inline-block h-3.5 w-1.5",
          !reduced && "animate-caret-blink",
        )}
      />
    </p>
  );
}

export function LogStream({
  videoId,
  initialLogs,
  initialPipelineState,
}: {
  videoId: string;
  initialLogs: PipelineLogStream;
  initialPipelineState: PipelineState;
}) {
  const reduced = usePrefersReducedMotion();
  // Same ["pipeline-state", videoId] query the panel already polls — reading
  // it here does not start a second polling loop, it adds a second observer
  // to the one React Query already has running (see usePipelineState's
  // comment). isActive is this stream's only cue for whether to keep polling.
  const { data: pipelineState } = usePipelineState(videoId, initialPipelineState);
  const isActive = pipelineState?.isActive ?? false;

  const { data } = useQuery({
    queryKey: ["pipeline-logs", videoId],
    queryFn: () => fetchLogs(videoId),
    initialData: initialLogs,
    // Live-tails only while the pipeline query says something is actually
    // running. Idle-`QUEUED` and terminal both land on `false` — a merged
    // three-table fetch is not worth paying for on every idle tick, and
    // nothing here changes on its own once terminal anyway.
    refetchInterval: isActive ? POLL_INTERVAL_ACTIVE_MS : false,
  });

  const stream = data ?? initialLogs;

  const [filter, setFilter] = useState<LevelFilter>("all");
  const visible = useMemo(
    () =>
      filter === "all"
        ? stream.entries
        : stream.entries.filter((entry) => isWarningOrWorse(entry.level)),
    [stream.entries, filter],
  );

  // Shown on the "Warnings & errors" tab so the operator can see there is
  // something to switch to without switching to it. Counted over the whole
  // stream rather than the visible slice, which on that tab is the same list.
  const problemCount = useMemo(
    () => stream.entries.filter((entry) => isWarningOrWorse(entry.level)).length,
    [stream.entries],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the tail should keep tracking new lines. Starts true so the
  // stream opens scrolled to its newest entry rather than its oldest.
  const followTailRef = useRef(true);
  const [following, setFollowing] = useState(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // An operator scrolling up to read history shouldn't get yanked back down
    // the next time a line arrives; returning near the bottom resumes it.
    const shouldFollow = distanceFromBottom < 48;
    followTailRef.current = shouldFollow;
    // Mirrored into state purely so the header can say which mode the console
    // is in. The ref stays the source of truth for the scroll effect below,
    // which must not wait for a re-render to know where it is.
    setFollowing(shouldFollow);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followTailRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible]);

  async function onCopyAll() {
    try {
      await navigator.clipboard.writeText(copyText(visible));
      toast.success(`Copied ${visible.length} log line${visible.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Could not copy logs — your browser may be blocking clipboard access.");
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Wraps rather than shrinking: at 375px the filter tabs and the copy
          button do not fit on one line with anything else, and an unwrapped
          row would scroll the page sideways to reach a button. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as LevelFilter)}>
          <TabsList>
            <TabsTrigger value="all">Everything</TabsTrigger>
            <TabsTrigger value="warnings">
              Warnings &amp; errors
              {problemCount > 0 && (
                <span className="text-destructive ml-1 tabular-nums">{problemCount}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {isActive && (
            // Tied to the pipeline query's own `isActive`, which is also the
            // only thing that keeps this component polling — so the word
            // "Live" and the request that makes it live cannot disagree.
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span className="relative flex size-1.5">
                {!reduced && (
                  <span
                    aria-hidden="true"
                    className="absolute inline-flex size-1.5 animate-ping rounded-full bg-sky-500/70 dark:bg-sky-400/70"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="relative inline-flex size-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
                />
              </span>
              {following ? "Live" : "Paused"}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={onCopyAll} disabled={visible.length === 0}>
            <ClipboardCopy />
            Copy all
          </Button>
        </div>
      </div>

      {stream.truncated && (
        <p className="text-muted-foreground text-xs">
          Showing the most recent {stream.entries.length} lines — older lines were truncated.
        </p>
      )}

      {visible.length === 0 ? (
        isActive ? (
          <AwaitingOutput reduced={reduced} />
        ) : (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {stream.entries.length === 0
              ? "No logs yet."
              : "No warnings or errors — switch to “Everything” to see the full stream."}
          </p>
        )
      ) : (
        // A plain labelled region, deliberately *not* a live region.
        //
        // This was `role="log"` with `aria-live="polite"`, which sounds like
        // the right answer and is not: support for the role is partial, and
        // the specific failure is severe — NVDA with Firefox re-reads the
        // entire container every time a line is appended, so an operator
        // using a screen reader would have the whole render log read back to
        // them twice a second for the length of a render. FFmpeg alone emits
        // hundreds of lines. The one thing worth announcing is a stage
        // changing state, and the pipeline panel's `role="status"` beside
        // this does exactly that, once per transition.
        //
        // `tabIndex={0}` because a scroll container with no focusable children
        // cannot be scrolled by keyboard — Firefox has auto-focused scroll
        // areas for years, Chrome only since 132, and WebKit still does not.
        //
        // `min-h-0 flex-1` rather than a fixed cap: this console sits beside
        // the stage rail on a wide screen, and a fixed height either left a
        // gap under a short rail or scrolled a tall one. Flexing to the row's
        // height makes the two halves finish together, which is what made the
        // pipeline read as one panel rather than two stacked cards.
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="region"
          aria-label="Pipeline log output"
          tabIndex={0}
          className="bg-muted/40 focus-visible:ring-ring/50 ring-foreground/10 max-h-96 min-h-40 flex-1 overflow-y-auto rounded-md p-2 font-mono text-xs ring-1 outline-none focus-visible:ring-3"
        >
          {visible.map((entry) => (
            <div
              key={entry.id}
              className={cn(
                // Grid, not flex: the timestamp and source columns have to
                // line up down the whole log for it to be scannable, and a
                // flex row with a wrapping message sets its own column widths
                // per line. The message column takes the remaining space and
                // wraps inside it.
                "grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2 gap-y-0.5 rounded-sm px-1 py-0.5 sm:grid-cols-[auto_auto_auto_1fr]",
                LEVEL_CLASS[entry.level].row,
              )}
            >
              <span className="text-muted-foreground/70 shrink-0 tabular-nums">
                {formatTimestamp(entry.createdAt)}
              </span>
              <span className={cn("shrink-0 font-medium", LEVEL_CLASS[entry.level].tag)}>
                {entry.level}
              </span>
              {/* Dropped below `sm`: on a phone the source is the least
                  useful of the three prefixes and it was costing a quarter of
                  the line width that the message needed. */}
              <span className="text-muted-foreground/70 hidden shrink-0 sm:inline">
                {SOURCE_LABEL[entry.source]}
              </span>
              <span className="col-span-3 break-words whitespace-pre-wrap sm:col-span-1">
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
