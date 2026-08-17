"use client";

import Link from "next/link";
import { ArrowRight, Circle, CircleCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CHECKLIST_KEY } from "@/features/onboarding/dismissal";
import { useOnboarding } from "@/features/onboarding/components/onboarding-provider";
import type { OnboardingChecklist } from "@/features/onboarding/types";
import { cn } from "@/lib/utils";

/**
 * The setup checklist, on the dashboard.
 *
 * Two ways it leaves. It renders itself out of existence once every step is
 * complete — this is a one-time nudge, not a fixture that nags a production
 * account — and it can be put away by hand before then, for the operator who
 * knows they are not going to connect a channel this week. "Hide" is a
 * dismissal like any other (see dismissal.ts), so it is remembered on the
 * account rather than in one browser, and Settings → Guides brings it back.
 *
 * Nothing here is a stored to-do list. Every line is an existence check the
 * server runs at render time, so ticking a box is impossible except by actually
 * doing the thing — see `OnboardingService.getChecklist`.
 */
export function OnboardingChecklistCard({
  checklist,
}: {
  checklist: OnboardingChecklist;
}) {
  const { isDismissed, dismiss } = useOnboarding();

  if (checklist.isComplete || isDismissed(CHECKLIST_KEY)) return null;

  const total = checklist.steps.length;
  const done = checklist.completedCount;

  return (
    // The tour's third step points here. On the card, not on a wrapper the
    // dashboard renders around it — a wrapper outlives the card and leaves the
    // tour spotlighting an empty box.
    <Card data-tour="tour-checklist">
      <CardHeader>
        <CardTitle>Getting started</CardTitle>
        <CardDescription>
          The route from an empty account to a video on your own channel. Each
          line ticks itself once it is true.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-muted-foreground text-xs tabular-nums">
              {done} of {total} done
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground -mr-2 h-auto py-1 text-xs"
              onClick={() => dismiss(CHECKLIST_KEY)}
            >
              Hide
            </Button>
          </div>
          {/* Radix gives the bar `role="progressbar"` and the value; the label
            * is what stops a screen reader announcing a bare "3" with no idea
            * what is being counted. */}
          <Progress
            value={total === 0 ? 0 : (done / total) * 100}
            aria-label={`Setup progress: ${done} of ${total} steps done`}
          />
        </div>

        <ul className="divide-border divide-y">
          {checklist.steps.map((step) => {
            const Icon = step.complete ? CircleCheck : Circle;
            const row = (
              <div className="flex items-center gap-3 px-2 py-3">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-5 shrink-0",
                    step.complete
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      step.complete && "text-muted-foreground",
                    )}
                  >
                    {/* Done vs not-done was carried entirely by which glyph
                      * rendered and what colour it was, so the single fact this
                      * whole card exists to convey never reached a screen
                      * reader — it heard the step titles and no progress. */}
                    <span className="sr-only">
                      {step.complete ? "Completed: " : "Not started: "}
                    </span>
                    {step.title}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {step.description}
                  </p>
                </div>
                {!step.complete && (
                  <ArrowRight className="text-muted-foreground size-4 shrink-0" />
                )}
              </div>
            );

            return (
              <li key={step.id}>
                {step.complete ? (
                  row
                ) : (
                  <Link
                    href={step.href}
                    className="hover:bg-accent/50 -mx-2 block rounded-md transition-colors"
                  >
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>

        {/* This footnote used to say voice, footage and publishing were not
            built and that an approved script was as far as it went. All three
            ship. What is still worth saying is the part that surprises people
            the other way round: the pipeline runs to a finished file on its
            own, and then waits. */}
        <p className="text-muted-foreground border-t pt-3 text-xs">
          Framecast runs all the way to a finished video without you. Only the
          last step, putting it on YouTube, is always yours.
        </p>
      </CardContent>
    </Card>
  );
}

export function OnboardingChecklistCardSkeleton() {
  return <Skeleton className="h-72" />;
}
