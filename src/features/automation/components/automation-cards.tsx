import { formatDistanceToNowStrict } from "date-fns";
import { CircleAlert, CirclePause, CirclePlay } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AUTOMATION_KINDS } from "@/features/automation/kinds";
import { describeHealth, describeProblem } from "@/lib/automation-language";
import { cn } from "@/lib/utils";
import type { AutomationEntry } from "@/services/automation-list.service";

const DOT: Record<AutomationEntry["recentRuns"][number]["outcome"], { className: string; label: string }> = {
  SUCCEEDED: { className: "bg-emerald-500", label: "made a video" },
  FAILED: { className: "bg-destructive", label: "failed" },
  SKIPPED: { className: "bg-muted-foreground/40", label: "skipped" },
  MISSED: { className: "bg-amber-500", label: "missed" },
};

/**
 * The Automation page as one card per automation: what it is, whether it is
 * working in plain words, when the next video comes, the last runs as dots,
 * and the buttons that act on it. Replaces the canvas and the table, which
 * showed the same rows at two levels of detail and both read as broken when
 * a month-old failure was still the first thing on them.
 */
export function AutomationCards({
  automations,
  empty,
}: {
  automations: AutomationEntry[];
  empty: ReactNode;
}) {
  if (automations.length === 0) return <>{empty}</>;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {automations.map((entry) => (
        <AutomationCard key={entry.rowId} entry={entry} />
      ))}
    </div>
  );
}

function AutomationCard({ entry }: { entry: AutomationEntry }) {
  const kind = AUTOMATION_KINDS[entry.kind];
  const health = describeHealth(entry);
  const running = entry.status === "ACTIVE";
  // A paused card leads with why it stopped; a running one only with a
  // failure streak. The full sentence stays on the detail page.
  const problem = running
    ? entry.consecutiveFailures > 0
      ? describeProblem(health.detail)
      : null
    : describeProblem(entry.pausedReason);
  const StatusIcon = running ? (problem ? CircleAlert : CirclePlay) : CirclePause;

  return (
    <article
      className={cn(
        "bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-5",
        problem && "border-amber-500/50",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">
            <Link href={entry.href} className="hover:underline underline-offset-4">
              {entry.name}
            </Link>
          </h3>
          <p className="text-muted-foreground truncate text-sm">
            {[entry.channel?.title, kind.label, entry.cadence].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 gap-1",
            running && !problem && "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
            problem && "border-amber-500/50 text-amber-700 dark:text-amber-400",
          )}
        >
          <StatusIcon className="size-3.5" />
          {running ? (problem ? "Needs a look" : "Running") : "Paused"}
        </Badge>
      </header>

      {problem ? (
        <p className="flex items-start gap-2 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            {problem.text}{" "}
            {problem.fix === "topics" && (
              <Link href={entry.href} className="font-medium underline underline-offset-4">
                Add topics
              </Link>
            )}
            {problem.fix === "billing" && (
              <Link href="/billing" className="font-medium underline underline-offset-4">
                Choose a plan
              </Link>
            )}
          </span>
        </p>
      ) : (
        <p className="text-sm">
          {running && entry.nextRunAt ? (
            <>
              Next video{" "}
              <span className="font-medium" suppressHydrationWarning>
                {formatDistanceToNowStrict(entry.nextRunAt, { addSuffix: true })}
              </span>
              {entry.nextUp && (
                <span className="text-muted-foreground"> · {entry.nextUp}</span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Paused by you. Resume it to continue.</span>
          )}
        </p>
      )}

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {entry.backlog !== null && kind.backlogNoun && (
          <span>
            {entry.backlog} {kind.backlogNoun}
            {entry.backlog === 1 ? "" : "s"} waiting
          </span>
        )}
        <span>
          {entry.produced} {kind.producedNoun}
          {entry.produced === 1 ? "" : "s"} made
        </span>
        {entry.recentRuns.length > 0 && (
          <span className="flex items-center gap-1" aria-label="Last runs, oldest first">
            Last runs
            {entry.recentRuns.map((run, index) => (
              <span
                key={index}
                className={cn("inline-block size-2 rounded-full", DOT[run.outcome].className)}
                title={`${DOT[run.outcome].label}, ${formatDistanceToNowStrict(run.at, { addSuffix: true })}`}
              />
            ))}
          </span>
        )}
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
        <kind.Controls entry={entry} />
        <Button asChild variant="ghost" size="sm" className="ms-auto">
          <Link href={entry.href}>Open</Link>
        </Button>
      </footer>
    </article>
  );
}
