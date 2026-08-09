"use client";

import { useQuery } from "@tanstack/react-query";
import { Circle, CircleCheck, CircleX, Clock, Hourglass, Loader2, Terminal } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getPipelineStateAction } from "@/actions/video.action";
import { cn } from "@/lib/utils";
import type { PipelineStage, PipelineState } from "@/services/pipeline.service";
import { formatDuration } from "@/utils/format";

/** A render spans several minutes; frequent enough that the panel reads as
 * live, far below query-provider.tsx's 30s staleTime so every tick is a real
 * request rather than a served-from-cache no-op. Only used while
 * `isActive` — something is actually moving and worth watching tick up. */
const POLL_INTERVAL_ACTIVE_MS = 2000;

/** Used whenever the video is queued but nothing is actually running yet.
 * There is no render worker today, so a `QUEUED` video can sit for a long
 * time with nothing to show — polling every 2s just piles up overlapping
 * requests against a database that's a long round trip away for nothing. */
const POLL_INTERVAL_IDLE_MS = 15_000;

async function fetchPipelineState(videoId: string): Promise<PipelineState> {
  const result = await getPipelineStateAction(videoId);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

const STATUS_ICON: Record<PipelineStage["status"], typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
};

const STATUS_ICON_CLASS: Record<PipelineStage["status"], string> = {
  pending: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
};

function StageRow({
  stage,
  progress,
  elapsedSeconds,
}: {
  stage: PipelineStage;
  progress: number | null;
  elapsedSeconds: number | null;
}) {
  const Icon = STATUS_ICON[stage.status];
  // Only the render row has anything to show here — it's the only stage with
  // a live progress signal (RenderJob.progress) and a real start timestamp.
  const showRenderExtras = stage.key === "render";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm">
        <Icon
          className={cn(
            "size-4 shrink-0",
            STATUS_ICON_CLASS[stage.status],
            stage.status === "running" && "animate-spin",
          )}
        />
        <span className="font-medium">{stage.label}</span>
        {stage.detail && (
          <span className="text-muted-foreground text-xs">{stage.detail}</span>
        )}
        {showRenderExtras && elapsedSeconds != null && (
          <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs tabular-nums">
            <Clock className="size-3" />
            {formatDuration(elapsedSeconds)}
          </span>
        )}
      </div>
      {showRenderExtras && stage.status === "running" && (
        <Progress value={progress ?? 0} className="ml-6 h-1.5" />
      )}
    </div>
  );
}

export function PipelinePanel({
  videoId,
  initialState,
}: {
  videoId: string;
  initialState: PipelineState;
}) {
  const { data } = useQuery({
    queryKey: ["pipeline-state", videoId],
    queryFn: () => fetchPipelineState(videoId),
    initialData: initialState,
    // The requirement most likely to get missed: this must eventually return
    // `false`, or an operator who leaves the tab open polls forever on an
    // idle page. `isTerminal` is the read model's one definition of
    // "finished" so this can never drift out of sync with it. Below that,
    // `isActive` — also computed server-side, never re-derived here — picks
    // fast vs. slow: a `QUEUED` video with nothing running yet (no render
    // worker exists today) has nothing to gain from a 2s poll.
    refetchInterval: (query) => {
      const latest = query.state.data;
      if (!latest || latest.isTerminal) return false;
      return latest.isActive ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
    },
  });

  const state = data ?? initialState;
  const isIdleQueued = !state.isTerminal && !state.isActive;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4" />
          Pipeline progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isIdleQueued ? (
          // A row of pending-grey dots reads as "broken", not "waiting" —
          // there's no render worker yet, so say plainly what's actually
          // going on instead of leaving the operator to guess.
          <Alert>
            <Hourglass />
            <AlertTitle>Waiting to start</AlertTitle>
            <AlertDescription>
              This video is queued but nothing is processing it yet — there is
              no render worker running today. Start it manually with{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                pnpm render {videoId}
              </code>
              .
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            {state.stages.map((stage) => (
              <StageRow
                key={stage.key}
                stage={stage}
                progress={state.progress}
                elapsedSeconds={state.elapsedSeconds}
              />
            ))}
          </div>
        )}

        {state.logs.length > 0 && (
          <Accordion type="single" collapsible>
            <AccordionItem value="logs" className="border-none">
              <AccordionTrigger className="text-muted-foreground py-1.5 text-xs hover:no-underline">
                Render log ({state.logs.length} lines)
              </AccordionTrigger>
              <AccordionContent>
                <pre className="bg-muted/50 max-h-64 overflow-y-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
                  {state.logs.map((line) => line.message).join("\n")}
                </pre>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
