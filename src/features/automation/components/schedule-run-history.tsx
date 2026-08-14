import Link from "next/link";
import { CheckCircle2, CircleSlash, Clock, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ScheduleRunOutcome } from "@/generated/prisma/enums";
import type { ScheduleRunRecord } from "@/services/schedule.service";

/**
 * What happened, every time.
 *
 * The point of this table is the rows that produced nothing. "Why is there no
 * video for the 3rd?" is the question a scheduled feature has to be able to
 * answer, and it can only answer it if a skip is as visible as a success —
 * which is why `ScheduleRun` writes a row for every occurrence rather than only
 * the ones that reached a render.
 *
 * A server component: this is a read of rows the page already has, and none of
 * it is interactive.
 */

const OUTCOME_STYLE: Record<
  ScheduleRunOutcome,
  { label: string; icon: LucideIcon; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  SUCCEEDED: { label: "Produced", icon: CheckCircle2, variant: "default" },
  SKIPPED: { label: "Skipped", icon: CircleSlash, variant: "secondary" },
  FAILED: { label: "Failed", icon: XCircle, variant: "destructive" },
  MISSED: { label: "Missed", icon: Clock, variant: "outline" },
};

export function ScheduleRunHistory({ runs }: { runs: ScheduleRunRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          Every occurrence, including the ones that made nothing.{" "}
          <span className="font-medium">Skipped</span> means the due-check looked
          and found a reason not to spend;{" "}
          <span className="font-medium">missed</span> means nothing was running
          at the time, and the occurrence was passed over rather than produced
          late.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {runs.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            Nothing yet. The first row appears the first time this schedule comes
            due.
          </p>
        ) : (
          <ul className="divide-border divide-y text-sm">
            {runs.map((run) => {
              const style = OUTCOME_STYLE[run.outcome];
              const Icon = style.icon;

              return (
                <li key={run.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={style.variant}>
                      <Icon />
                      {style.label}
                    </Badge>
                    <time
                      dateTime={run.scheduledFor.toISOString()}
                      className="text-muted-foreground text-xs"
                      suppressHydrationWarning
                    >
                      {run.scheduledFor.toLocaleString()}
                    </time>
                    {run.videoId && (
                      <Link
                        href={`/videos/${run.videoId}`}
                        className="text-primary text-xs underline-offset-4 hover:underline"
                      >
                        Open the video
                      </Link>
                    )}
                  </div>

                  {run.topic && <p className="font-medium">{run.topic}</p>}
                  {run.reason && (
                    <p className="text-muted-foreground text-xs">{run.reason}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
