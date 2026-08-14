import Link from "next/link";
import { ArrowRight, Circle, CircleCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OnboardingChecklist } from "@/features/onboarding/types";
import { cn } from "@/lib/utils";

/**
 * Renders itself out of existence once every step is complete — this is a
 * one-time nudge for a new operator, not a permanent fixture that nags a
 * production account.
 */
export function OnboardingChecklistCard({
  checklist,
}: {
  checklist: OnboardingChecklist;
}) {
  if (checklist.isComplete) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Getting started</CardTitle>
        <CardDescription>
          Six steps to take a topic from idea to an approved, publish-ready
          script.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
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
                      * reader — it heard six step titles and no progress. */}
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

        {/* The pipeline stops at an approved script today — say so here
            rather than let the checklist imply a finished video is possible. */}
        <p className="text-muted-foreground border-t pt-3 text-xs">
          Voice, footage and publishing are not built yet — approving a
          script is the last step today.
        </p>
      </CardContent>
    </Card>
  );
}

export function OnboardingChecklistCardSkeleton() {
  return <Skeleton className="h-72" />;
}
