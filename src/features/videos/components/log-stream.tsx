"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ClipboardCopy, ScrollText } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getPipelineLogsAction } from "@/actions/video.action";
import {
  POLL_INTERVAL_ACTIVE_MS,
  usePipelineState,
} from "@/features/videos/components/pipeline-panel";
import type { LogLevel } from "@/generated/prisma/enums";
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

// Badge has no dedicated "warning" variant, only default/secondary/
// destructive/outline/ghost/link — WARN gets its own colour on top of
// `outline` rather than overloading `destructive`, which ERROR already owns.
const LEVEL_BADGE_CLASS: Record<LogLevel, string> = {
  DEBUG: "text-muted-foreground",
  INFO: "text-muted-foreground",
  WARN: "border-amber-600/30 text-amber-600 dark:border-amber-400/30 dark:text-amber-400",
  ERROR: "border-destructive/30 text-destructive",
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

export function LogStream({
  videoId,
  initialLogs,
  initialPipelineState,
}: {
  videoId: string;
  initialLogs: PipelineLogStream;
  initialPipelineState: PipelineState;
}) {
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

  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the tail should keep tracking new lines. Starts true so the
  // stream opens scrolled to its newest entry rather than its oldest.
  const followTailRef = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // An operator scrolling up to read history shouldn't get yanked back down
    // the next time a line arrives; returning near the bottom resumes it.
    followTailRef.current = distanceFromBottom < 48;
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
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ScrollText className="size-4" />
          Pipeline logs
        </CardTitle>
        <div className="flex items-center gap-2">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as LevelFilter)}>
            <TabsList>
              <TabsTrigger value="all">Everything</TabsTrigger>
              <TabsTrigger value="warnings">Warnings &amp; errors</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            onClick={onCopyAll}
            disabled={visible.length === 0}
          >
            <ClipboardCopy />
            Copy all
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {stream.truncated && (
          <p className="text-muted-foreground text-xs">
            Showing the most recent {stream.entries.length} lines — older lines were truncated.
          </p>
        )}

        {visible.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {stream.entries.length === 0
              ? "No logs yet."
              : "No warnings or errors — switch to “Everything” to see the full stream."}
          </p>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="bg-muted/50 max-h-96 space-y-1 overflow-y-auto rounded-md p-2 font-mono text-xs"
          >
            {visible.map((entry) => (
              <div key={entry.id} className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {formatTimestamp(entry.createdAt)}
                </span>
                <Badge
                  variant="outline"
                  className={cn("shrink-0", LEVEL_BADGE_CLASS[entry.level])}
                >
                  {entry.level}
                </Badge>
                <span className="text-muted-foreground w-16 shrink-0">
                  {SOURCE_LABEL[entry.source]}
                </span>
                <span className="break-words whitespace-pre-wrap">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
