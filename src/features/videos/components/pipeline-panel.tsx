"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Hourglass,
  Loader2,
  Play,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  cancelPipelineAction,
  getPipelineStateAction,
  retryPipelineAction,
  startPipelineAction,
} from "@/actions/video.action";
import { useLiveElapsedSeconds } from "@/hooks/use-live-elapsed-seconds";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type { PipelineStage, PipelineState } from "@/services/pipeline.service";
import { formatDuration } from "@/utils/format";

/** How long a video may sit unclaimed before the panel stops calling it a
 * queue and starts calling it an outage.
 *
 * A render worker polls every five seconds, so a healthy queue moves in
 * seconds — the only thing that makes a wait long is other videos ahead of
 * this one, and even a full queue clears faster than this. Two minutes is
 * therefore well past "busy" and safely short of leaving someone staring at a
 * spinner for a service that is not running. Erring long is deliberate: a
 * false "offline" sends an operator to check a machine that is fine. */
const QUEUE_STALLED_AFTER_SECONDS = 120;

/**
 * What a queued video says about itself while nothing is happening to it.
 *
 * Three genuinely different situations share one screen, and telling an
 * operator the wrong one costs them either a wasted wait or a wasted
 * investigation:
 *
 *   - out of attempts — a worker took this video, failed, and has now used
 *     every retry the queue allows. Nothing will pick it up again, ever. This
 *     one has to be said outright, because it is indistinguishable from a
 *     normal wait and never resolves on its own.
 *   - waiting far too long — the queue is not moving. A worker polls every few
 *     seconds, so this means the render service is not running.
 *   - waiting — ordinary, expected, and about to resolve.
 */
function QueuedNotice({
  attempts,
  maxAttempts,
  attemptsExhausted,
  queuedSeconds,
}: {
  attempts: number;
  maxAttempts: number;
  attemptsExhausted: boolean;
  queuedSeconds: number | null;
}) {
  if (attemptsExhausted) {
    return (
      <Alert variant="destructive">
        <CircleX />
        <AlertTitle>This video will not start again</AlertTitle>
        <AlertDescription>
          It was picked up {attempts} times and failed each time, which is every
          attempt the queue allows. It will not be tried again on its own, and
          waiting will not change that. Open the logs beside this to see how the
          last attempt failed — whatever stopped it will stop it again until it
          is fixed.
        </AlertDescription>
      </Alert>
    );
  }

  const stalled =
    queuedSeconds !== null && queuedSeconds >= QUEUE_STALLED_AFTER_SECONDS;

  if (stalled) {
    return (
      <Alert variant="destructive">
        <Clock />
        <AlertTitle>Nothing has picked this up</AlertTitle>
        <AlertDescription>
          Queued {formatDuration(queuedSeconds)} ago and still unclaimed. The
          render service checks for new work every few seconds, so a wait this
          long means it is not running rather than busy. The video is safe and
          will start by itself the moment the service comes back — nothing here
          needs to be re-run.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert>
      <Hourglass />
      <AlertTitle>Waiting for the render service</AlertTitle>
      <AlertDescription>
        {queuedSeconds !== null && queuedSeconds > 0
          ? `Queued ${formatDuration(queuedSeconds)} ago. `
          : null}
        This starts automatically as soon as the render service picks it up.
        Rendering runs on its own machine because it needs FFmpeg and several
        minutes per video, so nothing here needs to stay open — close this page
        and come back.
        {attempts > 0
          ? ` This is attempt ${attempts + 1} of ${maxAttempts}; earlier ones failed.`
          : null}
      </AlertDescription>
    </Alert>
  );
}

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
 * Exported so the log stream (log-stream.tsx) and the section header
 * (pipeline-run.tsx) can read the same `isActive`/`isTerminal` signal to gate
 * their own behaviour instead of re-deriving it or running an
 * independently-tuned interval. Calling this from several components does not
 * mean several competing polling loops: React Query keys a single underlying
 * query by `queryKey`, so every observer shares one in-flight fetch and one
 * scheduled refetch per tick, not one each.
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
      // `isFinalizing` polls at the same fast cadence as `isActive`: it's the
      // window where `metadata`/`thumbnail` are still generating behind an
      // already-`READY` status (see `PipelineState.isFinalizing`'s own
      // comment), and that's exactly the kind of "something is genuinely
      // moving, worth watching tick from pending to done" case
      // `POLL_INTERVAL_ACTIVE_MS` exists for — same reasoning as a running
      // render, just without a `RenderJob` row to poll a percentage off of.
      return latest.isActive || latest.isFinalizing
        ? POLL_INTERVAL_ACTIVE_MS
        : POLL_INTERVAL_IDLE_MS;
    },
  });
}

/**
 * What the rest of the page is showing, as one string.
 *
 * Only the things a server-rendered section is drawn from: which stages have
 * landed, and whether the run has finished. Deliberately not `progress` or
 * `elapsedSeconds` — those change on every single poll and nothing outside this
 * panel is drawn from them, so including them would mean re-rendering the whole
 * page twice a second to show a number this component already owns.
 */
function serverVisibleSignature(state: PipelineState): string {
  return `${state.isTerminal}|${state.isFailed}|${state.stages
    .map((stage) => `${stage.key}:${stage.status}`)
    .join(",")}`;
}

/**
 * Pull the server-rendered half of the page forward when a stage lands.
 *
 * The panel polls, so the stage list ticked over on its own — but the script
 * card, the narration player, the footage grid and the status badge are server
 * components, and those only ever re-rendered after an operator *pressed*
 * something (`afterMutation` below). Watching a pipeline advance by itself, the
 * stages moved and the page underneath them did not, so the work looked stuck
 * until a manual refresh. That is the bug this closes.
 *
 * Keyed on `serverVisibleSignature` rather than the poll: a refresh re-renders
 * the entire route on the server, so doing it every two seconds would be a
 * self-inflicted load test. Once per actual transition is a handful of refreshes
 * across a whole run — six stages plus the finish.
 *
 * The first observation seeds the ref without refreshing. The page was rendered
 * from this exact state milliseconds ago; refreshing it again would be a
 * guaranteed-wasted round trip on every mount.
 *
 * Called from `PipelinePanel` only, never from `PipelineSummary`. The two are
 * rendered together by pipeline-run.tsx and share one React Query cache entry,
 * so a second caller would mean two refreshes per transition and no extra
 * freshness.
 */
function useRefreshOnStageChange(state: PipelineState): void {
  const router = useRouter();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const signature = serverVisibleSignature(state);

    if (previous.current === null) {
      previous.current = signature;
      return;
    }

    if (previous.current === signature) return;

    previous.current = signature;
    router.refresh();
  }, [state, router]);
}

const STATUS_ICON: Record<PipelineStage["status"], typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
  // A stage that will never automatically complete (see
  // `PipelineStageStatus`'s own comment on `skipped`) — visually distinct
  // from both `pending` (implies more is coming) and `failed` (implies an
  // error worth investigating), since it's neither.
  skipped: CircleSlash,
};

const STATUS_ICON_CLASS: Record<PipelineStage["status"], string> = {
  // A third of the way to the foreground: enough to read as an outline in the
  // rail, quiet enough that seven of them do not compete with the one stage
  // that is actually doing something.
  pending: "text-muted-foreground/60",
  running: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  skipped: "text-muted-foreground/60",
};

/** What a screen reader hears in place of the glyph. The icons are the only
 * thing distinguishing seven otherwise identical rows, and an icon is not
 * text. */
const STATUS_LABEL: Record<PipelineStage["status"], string> = {
  pending: "Not started",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * The bar under the running render.
 *
 * Rendered for exactly one condition: a stage that is running *and* has a real
 * percentage behind it, which today means the render and nothing else
 * (`RenderJob.progress`). There is deliberately no indeterminate counterpart
 * for the other six stages. A bar that sweeps still reads as a bar — people
 * take a horizontal indicator to mean "this far along", and an animated one to
 * additionally mean "at this rate" — so putting one under a stage with no
 * progress signal invents both. What replaces it is what every CI tool
 * actually does: the spinning glyph on the row says *this* one is working, and
 * the list of seven with three ticked says how far the run has got. Both are
 * facts the server sent.
 */
function StageProgress({ label, progress }: { label: string; progress: number }) {
  return (
    // Radix renders this as `role="progressbar"`, and a progressbar with no
    // accessible name is announced as a bare percentage with nothing to
    // attach it to. The bar is visually tied to the stage row above it by
    // its indent alone, which is exactly the association a screen reader
    // cannot see. `aria-valuetext` overrides the default "N percent" with
    // wording that says what is at N percent.
    //
    // Note this is not a live region and must not become one: a progressbar's
    // value changes are not announced, by design. The one spoken update on
    // this panel is the stage-transition `role="status"` at the bottom.
    <Progress
      value={progress}
      aria-label={`${label} progress`}
      aria-valuetext={`${label}: ${Math.round(progress)}% complete`}
      className="h-1"
    />
  );
}

/**
 * One stage of the run, laid out the way every CI tool lays a step out: a
 * status glyph on a vertical rail, the step name beside it, and whatever that
 * step knows about itself trailing off to the right.
 *
 * The rail matters more than it looks. Seven flat rows of icon-and-label read
 * as a checklist — a set of independent things — when what they actually are
 * is one ordered run, where a stage cannot start until the one above it
 * finished. The connecting line is what says so, and colouring the segment
 * above a completed stage is what turns it into a progress indicator that
 * cannot be wrong: it is drawn from the stage statuses themselves.
 */
function StageRow({
  stage,
  isLast,
  isPrecededByDone,
  progress,
  elapsedSeconds,
  reduced,
}: {
  stage: PipelineStage;
  isLast: boolean;
  isPrecededByDone: boolean;
  /** The render's percentage, or null when there is no live percentage to
   * show. Only ever meaningful for the render stage — every other stage is
   * handed `null` by the caller rather than an inherited number. */
  progress: number | null;
  /** The render's elapsed seconds, live. Same rule: only the render stage
   * has a real start timestamp behind it, so only the render stage is given
   * one. Inventing a duration for the others by timing the poll that first
   * showed them running would be a number about this browser, not the run. */
  elapsedSeconds: number | null;
  reduced: boolean;
}) {
  const Icon = STATUS_ICON[stage.status];
  const isRunning = stage.status === "running";
  // The render stage's server-side `detail` is built from exactly these two
  // numbers — it reads "42% · 5:29 elapsed" (see pipeline.service.ts) — so
  // showing it alongside the bar and the timer prints the same fact three
  // times. Worse, the detail is frozen between polls while the timer ticks, so
  // the row showed "5:29 elapsed" beside a clock reading 5:30 and invited the
  // question of which one was lying. The richer pair wins and the sentence
  // goes.
  const showsOwnProgress = progress !== null && elapsedSeconds !== null;

  return (
    <li className={cn("relative flex gap-3", !isLast && "pb-3")}>
      {!isLast && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-5 bottom-0 left-[7.5px] w-px",
            // Green below a finished stage, muted below anything else. Drawn
            // from the stage's own status so this can never disagree with the
            // glyph sitting on it.
            isPrecededByDone ? "bg-emerald-600/40 dark:bg-emerald-400/30" : "bg-foreground/10",
          )}
        />
      )}

      <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {isRunning && !reduced && (
          // A halo on the glyph, not a shimmer over the row: it sits on the
          // one stage the server says is running, so it can only ever be
          // visible while something really is.
          <span
            aria-hidden="true"
            className="absolute inline-flex size-4 animate-ping rounded-full bg-sky-500/40 dark:bg-sky-400/40"
          />
        )}
        <Icon
          aria-hidden="true"
          className={cn(
            "relative size-4",
            STATUS_ICON_CLASS[stage.status],
            // Both branches are tied to the same single condition —
            // `status === "running"`, straight off the server's read model.
            //
            // Reduced motion swaps rotation for a slow opacity fade rather
            // than freezing the glyph. A stationary spinner is exactly what a
            // hung process looks like, so removing the animation outright
            // trades a vestibular risk for a correctness bug; luminance change
            // is not the kind of motion that causes the problem.
            isRunning && (reduced ? "animate-pulse" : "animate-spin"),
          )}
        />
      </span>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={cn(
              "text-sm font-medium",
              // A stage nothing has reached yet is context, not content. Full
              // contrast on all seven made the row that mattered impossible to
              // pick out at a glance, which is the whole job of this list.
              stage.status === "pending" && "text-muted-foreground",
            )}
          >
            {stage.label}
          </span>
          <span className="sr-only">{STATUS_LABEL[stage.status]}</span>
          {stage.detail && !showsOwnProgress && (
            <span className="text-muted-foreground min-w-0 text-xs break-words">
              {stage.detail}
            </span>
          )}
          {isRunning && progress !== null && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {Math.round(progress)}%
            </span>
          )}
          {elapsedSeconds != null && (
            // `role="timer"` carries an implicit `aria-live: off`, which is
            // the point: this number changes every second and a screen reader
            // announcing each tick would make the page unusable. It stays
            // queryable on demand, and `aria-atomic` means querying it reads
            // "4:12" rather than whichever digit last changed.
            <span
              role="timer"
              aria-atomic="true"
              className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-xs tabular-nums"
            >
              <Clock aria-hidden="true" className="size-3" />
              <span className="sr-only">Elapsed </span>
              {formatDuration(elapsedSeconds)}
            </span>
          )}
        </div>

        {isRunning && progress !== null && (
          <StageProgress label={stage.label} progress={progress} />
        )}
      </div>
    </li>
  );
}

/**
 * The seven-segment strip above the stage list.
 *
 * Deliberately not a percentage bar. "Three of seven stages done" is real,
 * but turning it into 43% would claim the stages are the same size, and they
 * are not — the render alone routinely outlasts the other six put together.
 * One segment per stage, coloured by that stage's own status, says exactly as
 * much as the data supports and no more, and it stays readable at a glance
 * from across a desk while a render runs.
 */
function StageStrip({ stages }: { stages: PipelineStage[] }) {
  return (
    // Not animated, even for the running segment. The spinning glyph on the
    // stage row below is already the one thing on this panel saying "in
    // flight"; a second animation for the same fact competes with it rather
    // than reinforcing it, and two moving things on one card is how a status
    // panel starts feeling like an advert.
    <div aria-hidden="true" className="flex gap-1">
      {stages.map((stage) => (
        <span
          key={stage.key}
          className={cn(
            "h-1 flex-1 rounded-full",
            stage.status === "done" && "bg-emerald-600/70 dark:bg-emerald-400/60",
            stage.status === "running" && "bg-sky-500 dark:bg-sky-400",
            stage.status === "failed" && "bg-destructive",
            (stage.status === "pending" || stage.status === "skipped") && "bg-foreground/10",
          )}
        />
      ))}
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
        <p className="text-destructive max-w-56 text-xs">
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

  if (state.isFinalizing) {
    // The video already reads READY, but `metadata`/`thumbnail` are still
    // generating behind it (see `PipelineState.isFinalizing`'s own comment on
    // `pipeline.service.ts`). There is nothing for the operator to do here:
    // `startPipelineAction`/`jobService.requeue` only accept a `QUEUED` or
    // retryable-`FAILED` video and would reject a `READY` one, and
    // `cancelPipelineAction`/`jobService.requestCancel` only accept
    // `GENERATING`/`RENDERING`. Publish becomes available once this finishes
    // — the panel keeps polling through `isFinalizing` and re-renders on its
    // own the moment it does.
    return null;
  }

  if (!state.isTerminal) {
    // This panel never mounts for a DRAFT video (see the video detail page),
    // and not-terminal-and-not-active-and-not-finalizing leaves only QUEUED —
    // approved and waiting on a worker.
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

/** True while nothing is moving and nothing has claimed the video — the
 * `QUEUED`-with-no-worker case. Excludes `isFinalizing` deliberately: that
 * window has the same `!isTerminal && !isActive` shape, but showing "waiting
 * for the render service" would be actively wrong — a worker already picked
 * this video up and is finishing metadata/thumbnail, not waiting to start. */
function isIdleQueued(state: PipelineState): boolean {
  return !state.isTerminal && !state.isActive && !state.isFinalizing;
}

/**
 * The run itself: the stage rail, its controls, and nothing else.
 *
 * The embedded "Render log" accordion that used to live at the bottom of this
 * card is gone. It showed the same lines as the log panel now sitting directly
 * beside it — two copies of one stream, one of them behind a click — and its
 * only reason for existing was that the log used to be somewhere else on the
 * page entirely.
 */
export function PipelinePanel({
  videoId,
  initialState,
}: {
  videoId: string;
  initialState: PipelineState;
}) {
  const reduced = usePrefersReducedMotion();
  const { data, dataUpdatedAt } = usePipelineState(videoId, initialState);

  const state = data ?? initialState;
  useRefreshOnStageChange(state);
  const runningIndex = state.stages.findIndex((stage) => stage.status === "running");
  const elapsedSeconds = useLiveElapsedSeconds(
    state.elapsedSeconds,
    dataUpdatedAt,
    state.isActive,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <RunHeadline state={state} elapsedSeconds={elapsedSeconds} reduced={reduced} />
          {state.attempts > 0 && (
            <p className="text-muted-foreground text-xs">
              Attempt {state.attempts} of {state.maxAttempts}
            </p>
          )}
        </div>
        <PipelineControls videoId={videoId} state={state} />
      </div>

      {isIdleQueued(state) ? (
        // A row of pending-grey dots reads as "broken", not "waiting" — say
        // plainly what's actually going on instead of leaving the operator
        // to guess whether this is stuck or just hasn't been picked up yet.
        <QueuedNotice
          attempts={state.attempts}
          maxAttempts={state.maxAttempts}
          attemptsExhausted={state.attemptsExhausted}
          queuedSeconds={state.queuedSeconds}
        />
      ) : (
        <>
          <StageStrip stages={state.stages} />
          {/* A real list, because that is what seven ordered steps are, and
              a screen reader announcing "list, 7 items" is the outline a
              sighted operator gets from the rail. */}
          <ol className="mt-3">
            {state.stages.map((stage, index) => (
              <StageRow
                key={stage.key}
                stage={stage}
                isLast={index === state.stages.length - 1}
                isPrecededByDone={stage.status === "done"}
                // Only the render stage carries a real percentage and a real
                // start time; handing either to any other row would be this
                // panel inventing data it does not have.
                progress={stage.key === "render" ? state.progress : null}
                elapsedSeconds={stage.key === "render" ? elapsedSeconds : null}
                reduced={reduced}
              />
            ))}
          </ol>
        </>
      )}

      {/* The one place this panel speaks. `role="status"` is implicitly a
          polite, atomic live region with far better screen-reader support
          than `role="log"`, and its content only changes when a stage does —
          so an operator watching a ten-minute render hears one sentence per
          transition rather than the log's firehose (see log-stream.tsx).
          Rendered unconditionally, empty, because a live region has to be in
          the DOM *before* it is written to for the update to be monitored;
          mounting it at the moment a stage starts is how these silently never
          announce anything. */}
      <p role="status" aria-atomic="true" className="sr-only">
        {runningIndex >= 0
          ? `Stage ${runningIndex + 1} of ${state.stages.length}, ${state.stages[runningIndex].label}, running.`
          : ""}
      </p>
    </div>
  );
}

/**
 * The one line that says where the run got to, in the panel and — through
 * `PipelineSummary` below — in the section header when the section is folded
 * away.
 *
 * Every branch is a distinct thing that happened, because the operator's next
 * move differs for each: a failure needs the log, a stall needs the worker
 * checking, a finished run needs nothing at all.
 */
function runHeadline(state: PipelineState, elapsedSeconds: number | null): {
  text: string;
  tone: "running" | "failed" | "done" | "idle";
} {
  if (state.isFailed) {
    const failed = state.stages.find((stage) => stage.status === "failed");
    return { text: failed ? `Failed at ${failed.label}` : "Failed", tone: "failed" };
  }

  const running = state.stages.find((stage) => stage.status === "running");

  if (running) {
    const parts = [running.label];
    if (running.key === "render" && state.progress !== null) {
      parts.push(`${Math.round(state.progress)}%`);
    }
    if (running.key === "render" && elapsedSeconds !== null) {
      parts.push(formatDuration(elapsedSeconds));
    }
    return { text: parts.join(" · "), tone: "running" };
  }

  if (state.isFinalizing) {
    return { text: "Finishing up", tone: "running" };
  }

  if (isIdleQueued(state)) {
    return {
      text:
        state.queuedSeconds !== null && state.queuedSeconds > 0
          ? `Queued ${formatDuration(state.queuedSeconds)} ago`
          : "Queued",
      tone: "idle",
    };
  }

  const done = state.stages.filter((stage) => stage.status === "done").length;
  const label = `${done} of ${state.stages.length} stages`;

  return {
    // The render's total is the number an operator actually quotes about a
    // finished video, so it leads the summary whenever there is one.
    text:
      state.elapsedSeconds !== null
        ? `${label} · rendered in ${formatDuration(state.elapsedSeconds)}`
        : label,
    tone: "done",
  };
}

const TONE_DOT_CLASS: Record<"running" | "failed" | "done" | "idle", string> = {
  running: "bg-sky-500 dark:bg-sky-400",
  failed: "bg-destructive",
  done: "bg-emerald-600 dark:bg-emerald-400",
  idle: "bg-muted-foreground/50",
};

function RunHeadline({
  state,
  elapsedSeconds,
  reduced,
  className,
}: {
  state: PipelineState;
  elapsedSeconds: number | null;
  reduced: boolean;
  className?: string;
}) {
  const { text, tone } = runHeadline(state, elapsedSeconds);

  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="relative flex size-2 shrink-0">
        {tone === "running" && !reduced && (
          // Pings only for `tone === "running"`, which `runHeadline` only
          // returns when the server's own stage list has a running stage or
          // the run is finalizing. Nothing here can pulse over a still run.
          <span
            aria-hidden="true"
            className={cn(
              "absolute inline-flex size-2 animate-ping rounded-full opacity-75",
              TONE_DOT_CLASS[tone],
            )}
          />
        )}
        <span
          aria-hidden="true"
          className={cn("relative inline-flex size-2 rounded-full", TONE_DOT_CLASS[tone])}
        />
      </span>
      <span className="truncate text-sm tabular-nums">{text}</span>
    </span>
  );
}

/**
 * The same headline, sized for a folded section header.
 *
 * Reads the shared `["pipeline-state", videoId]` query rather than being
 * handed a snapshot, so a section an operator has folded away still tells the
 * truth about a run that is moving underneath it — which is the entire reason
 * a collapsed header is allowed to exist here at all.
 */
export function PipelineSummary({
  videoId,
  initialState,
}: {
  videoId: string;
  initialState: PipelineState;
}) {
  const reduced = usePrefersReducedMotion();
  const { data, dataUpdatedAt } = usePipelineState(videoId, initialState);
  const state = data ?? initialState;
  const elapsedSeconds = useLiveElapsedSeconds(
    state.elapsedSeconds,
    dataUpdatedAt,
    state.isActive,
  );

  return (
    <RunHeadline
      state={state}
      elapsedSeconds={elapsedSeconds}
      reduced={reduced}
      className="text-xs"
    />
  );
}
