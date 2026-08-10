"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  Loader2,
  Play,
  RotateCw,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  cancelPipelineAction,
  getPipelineStateAction,
  retryPipelineAction,
  startPipelineAction,
} from "@/actions/video.action";
import { cn } from "@/lib/utils";
import type { PipelineStage, PipelineState } from "@/services/pipeline.service";
import { formatDuration } from "@/utils/format";

/** A render spans several minutes; frequent enough that the panel reads as
 * live, far below query-provider.tsx's 30s staleTime so every tick is a real
 * request rather than a served-from-cache no-op. Only used while
 * `isActive` — something is actually moving and worth watching tick up.
 * Exported so log-stream.tsx's own poll rides the exact same cadence instead
 * of a second, separately-tuned number that could drift from this one. */
export const POLL_INTERVAL_ACTIVE_MS = 2000;

/** Used whenever the video is queued but nothing is actually running yet.
 * A worker isn't guaranteed to be running (it's started separately, with
 * `pnpm worker`), so a `QUEUED` video can sit for a long time with nothing
 * to show — polling every 2s just piles up overlapping requests against a
 * database that's a long round trip away for nothing. */
const POLL_INTERVAL_IDLE_MS = 15_000;

async function fetchPipelineState(videoId: string): Promise<PipelineState> {
  const result = await getPipelineStateAction(videoId);

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

/**
 * The one place `["pipeline-state", videoId]` is fetched and polled.
 * Exported so the log stream (log-stream.tsx) can read the same `isActive`/
 * `isTerminal` signal to gate its own poll instead of re-deriving them or
 * running an independently-tuned interval — see that file's comment. Calling
 * this from two components does not mean two competing polling loops: React
 * Query keys a single underlying query by `queryKey`, so both observers share
 * one in-flight fetch and one scheduled refetch per tick, not one each.
 */
export function usePipelineState(videoId: string, initialState: PipelineState) {
  return useQuery({
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

/**
 * Run / Cancel / Retry — driving the pipeline from the app instead of a
 * terminal, and a way to recover a failed step. All three route through
 * `run()`-wrapped, `userId`-scoped actions (`video.action.ts`) whose atomic
 * conditional update (`JobService.requeue` / `requestCancel`) is what
 * actually guards against two rapid clicks; this component only ever picks
 * one control for the current state and reports the result.
 *
 * Exactly one of {Cancel, Retry, "failed N times" message, Run, nothing} is
 * shown at a time — an operator looking at a button that would silently do
 * nothing is worse off than one looking at no button.
 */
function PipelineControls({ videoId, state }: { videoId: string; state: PipelineState }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();

  // Refetches this panel's own poll immediately, rather than waiting out
  // POLL_INTERVAL_IDLE_MS, and refreshes the rest of the page — the status
  // badge, the Approve button, the script lock — which only update through
  // the server-rendered tree, not this component's own query.
  function afterMutation(): void {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-state", videoId] });
    router.refresh();
  }

  function onRun(): void {
    startTransition(async () => {
      const result = await startPipelineAction(videoId);
      if (!result.ok) {
        toast.error("Could not start the pipeline", { description: result.error.message });
        return;
      }
      toast.success("Queued — a worker will pick this up next.");
      afterMutation();
    });
  }

  function onRetry(): void {
    startTransition(async () => {
      const result = await retryPipelineAction(videoId);
      if (!result.ok) {
        toast.error("Could not retry", { description: result.error.message });
        return;
      }
      toast.success("Queued for retry — a worker will pick this up next.");
      afterMutation();
    });
  }

  function onCancel(): void {
    startTransition(async () => {
      const result = await cancelPipelineAction(videoId);
      if (!result.ok) {
        toast.error("Could not cancel", { description: result.error.message });
        return;
      }
      toast.success("Cancellation requested — the worker stops at its next heartbeat.");
      afterMutation();
    });
  }

  if (state.isActive) {
    return (
      <Button variant="destructive" size="sm" onClick={onCancel} disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
        Cancel
      </Button>
    );
  }

  if (state.isFailed) {
    if (state.attemptsExhausted) {
      return (
        <p className="text-destructive max-w-56 text-right text-xs">
          Failed {state.attempts} time{state.attempts === 1 ? "" : "s"} — the maximum. Fix the
          issue before trying again.
        </p>
      );
    }

    return (
      <Button size="sm" onClick={onRetry} disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
        Retry
      </Button>
    );
  }

  if (!state.isTerminal) {
    // This panel never mounts for a DRAFT video (see the video detail page),
    // and not-terminal-and-not-active leaves only QUEUED — approved and
    // waiting on a worker.
    return (
      <Button size="sm" onClick={onRun} disabled={isPending}>
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        Run
      </Button>
    );
  }

  // READY / PUBLISHED: the pipeline is done, nothing left to run.
  return null;
}

export function PipelinePanel({
  videoId,
  initialState,
}: {
  videoId: string;
  initialState: PipelineState;
}) {
  const { data } = usePipelineState(videoId, initialState);

  const state = data ?? initialState;
  const isIdleQueued = !state.isTerminal && !state.isActive;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Terminal className="size-4" />
            Pipeline progress
          </CardTitle>
          {state.attempts > 0 && (
            <p className="text-muted-foreground text-xs">
              Attempt {state.attempts} of {state.maxAttempts}
            </p>
          )}
        </div>
        <PipelineControls videoId={videoId} state={state} />
      </CardHeader>
      <CardContent className="space-y-4">
        {isIdleQueued ? (
          // A row of pending-grey dots reads as "broken", not "waiting" — say
          // plainly what's actually going on instead of leaving the operator
          // to guess whether this is stuck or just hasn't been picked up yet.
          <Alert>
            <Hourglass />
            <AlertTitle>Waiting for a worker</AlertTitle>
            <AlertDescription>
              This video is queued, but no render worker has claimed it yet.
              Start one with{" "}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                pnpm worker
              </code>{" "}
              — it polls for queued videos and claims this one automatically.
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
