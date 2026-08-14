"use client";

import { useEffect, useState } from "react";
import { Circle, CircleCheck, CircleDashed, CircleX, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MultiStepLoader } from "@/components/ui/multi-step-loader";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";
import type { PipelineStageStatus, PipelineState } from "@/services/pipeline.service";

/**
 * The stage the pipeline read model has no row for, because it happened before
 * the video was ever queued: the guided flow generates and approves the script
 * itself (see `AutomationService.start`). Prepending it is the only invented
 * step here — every other one is a real `PipelineStage` — and it is only ever
 * shown as already complete, because by the time this view exists it is.
 */
const SCRIPT_STEP_KEY = "script";

/**
 * `upload` is deliberately dropped from the pipeline's own stage list.
 *
 * It is a real stage and it really is last, but nothing in this flow ever
 * advances it: the run ends at a finished video and publishing stays a
 * separate, deliberate click. Shown here it would sit un-ticked forever on a
 * video that is completely finished — reading as a stall — and, worse, imply
 * to an operator watching an unattended run that an upload is coming.
 */
const HIDDEN_STAGE_KEY = "upload";

/**
 * How long a queued video may sit unclaimed before this stops calling itself
 * progress. Matches `QUEUE_STALLED_AFTER_SECONDS` in pipeline-panel.tsx, which
 * is also the component that explains what it means — a render worker polls
 * every few seconds, so a wait this long is an offline service rather than a
 * busy one. Past this point the animated overlay closes and the panel's own
 * notice does the talking, rather than a spinner implying work is happening.
 */
const QUEUE_STALLED_AFTER_SECONDS = 120;

interface LoaderStep {
  key: string;
  /** Includes the stage's own live `detail` when it has one — "Render — 42% ·
   * 1m 12s elapsed" — so the step text carries real numbers rather than a
   * fixed label that would look identical on a stuck run and a healthy one. */
  text: string;
  status: PipelineStageStatus;
}

function buildSteps(state: PipelineState, hasScript: boolean): LoaderStep[] {
  const stages = state.stages
    .filter((stage) => stage.key !== HIDDEN_STAGE_KEY)
    .map(
      (stage): LoaderStep => ({
        key: stage.key,
        text: stage.detail ? `${stage.label} — ${stage.detail}` : stage.label,
        status: stage.status,
      }),
    );

  return [
    {
      key: SCRIPT_STEP_KEY,
      text: "Script written and approved",
      status: hasScript ? "done" : "pending",
    },
    ...stages,
  ];
}

/**
 * Which step is "now".
 *
 * Read entirely off stage statuses the server computed — the whole point of
 * controlling `MultiStepLoader`'s index rather than letting its timer run. The
 * order of preference matters: a running stage is what is happening; failing
 * that, a failed stage is where things stopped and is what the operator needs
 * to be looking at; failing both, the run is between stages or finished, so
 * the last stage that resolved is the truthful place to sit.
 */
function currentStepIndex(steps: LoaderStep[]): number {
  const running = steps.findIndex((step) => step.status === "running");
  if (running !== -1) return running;

  const failed = steps.findIndex((step) => step.status === "failed");
  if (failed !== -1) return failed;

  let lastResolved = 0;
  steps.forEach((step, index) => {
    if (step.status === "done" || step.status === "skipped") lastResolved = index;
  });

  return lastResolved;
}

/**
 * Whether the animated overlay has any business being on screen.
 *
 * It claims one thing — "this is working right now" — so it may only appear
 * when that is true. Three cases close it, each of which the pipeline panel
 * underneath explains properly and this component would only be able to
 * misrepresent:
 *
 *  - **finished or failed** (`isTerminal`, `isFailed`): nothing is moving, and
 *    a stage failed is a thing to read, not to watch.
 *  - **queued far too long**: a worker polls every few seconds, so a video
 *    still unclaimed after `QUEUE_STALLED_AFTER_SECONDS` is waiting on a
 *    service that is not running. Spinning through that is the exact lie this
 *    whole wiring exists to avoid.
 *  - **out of attempts**: the queue will never claim this video again.
 *
 * An ordinary short queue wait is deliberately *not* excluded: the video is
 * seconds away from being picked up, and flickering the overlay off and on
 * across that boundary would be worse than sitting on the first step.
 */
function isGenuinelyWorking(state: PipelineState): boolean {
  if (state.isTerminal || state.isFailed || state.attemptsExhausted) return false;
  if (state.isActive || state.isFinalizing) return true;

  return (state.queuedSeconds ?? 0) < QUEUE_STALLED_AFTER_SECONDS;
}

const STATUS_ICON: Record<PipelineStageStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  done: CircleCheck,
  failed: CircleX,
  skipped: CircleDashed,
};

const STATUS_ICON_CLASS: Record<PipelineStageStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

/**
 * The same step list with the motion taken out, for an operator who has asked
 * their system for less of it. Not a degraded fallback — it carries exactly
 * the same information, marks the same current step, and is arguably easier to
 * read; it simply does not animate, does not take over the screen, and needs
 * no dismissing.
 */
function StaticSteps({ steps, currentIndex }: { steps: LoaderStep[]; currentIndex: number }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        {steps.map((step, index) => {
          const Icon = STATUS_ICON[step.status];

          return (
            <div key={step.key} className="flex items-center gap-2 text-sm">
              <Icon className={cn("size-4 shrink-0", STATUS_ICON_CLASS[step.status])} />
              <span className={cn(index === currentIndex && "font-medium")}>
                {step.text}
              </span>
              {index === currentIndex && (
                <span className="text-muted-foreground text-xs">now</span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * The "AI at work" view for a run in flight, driven entirely by
 * `PipelineState`.
 *
 * Nothing here is on a clock. The step list, which step is current, and
 * whether the overlay is on screen at all are all derived from the state the
 * server computed and the polling query keeps fresh (see `usePipelineState`,
 * which owns the cadence and the stopping condition). That is what makes it
 * safe to show a confident animation on a page whose entire premise is that an
 * automated process can be trusted: it can only ever be as confident as the
 * database is.
 */
export function PipelineLoader({
  state,
  hasScript,
}: {
  state: PipelineState;
  /** Whether a script version actually exists, so the first step is not
   * ticked on the strength of this component having rendered. */
  hasScript: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [dismissed, setDismissed] = useState(false);

  const steps = buildSteps(state, hasScript);
  const currentIndex = currentStepIndex(steps);
  const working = isGenuinelyWorking(state);
  const overlayOpen = working && !dismissed && !prefersReducedMotion;

  // A full-screen overlay with no keyboard exit is a trap, and this one can be
  // on screen for minutes.
  useEffect(() => {
    if (!overlayOpen) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setDismissed(true);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpen]);

  if (prefersReducedMotion) {
    return <StaticSteps steps={steps} currentIndex={currentIndex} />;
  }

  return (
    <>
      <MultiStepLoader
        loadingStates={steps.map((step) => ({ text: step.text }))}
        loading={overlayOpen}
        // Controlled: supplying this is what stops the component's own timer
        // from marching through stages of its own accord. See its doc comment.
        value={currentIndex}
        onClose={() => setDismissed(true)}
      />

      {working && dismissed && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setDismissed(false)}>
            Show progress
          </Button>
          <p className="text-muted-foreground text-xs">
            Still running. The render happens on its own machine, so you can
            close this page and come back to it.
          </p>
        </div>
      )}
    </>
  );
}
