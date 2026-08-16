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
import type { ReleaseRunRecord } from "@/services/release.service";

/**
 * What happened at every slot.
 *
 * "Why did nothing go out on Tuesday?" is the question this feature has to be
 * able to answer, and it can only answer it if a slot that released nothing is
 * as visible as one that did — which is why `ReleaseRun` writes a row for every
 * slot rather than only the ones that reached YouTube.
 *
 * The distinction the labels carry is the one that matters most here.
 * *Skipped* is overwhelmingly "nothing was banked", which is not a fault and
 * needs no action; *failed* is an upload YouTube refused, which does; *missed*
 * is a slot that passed while nothing was running, and was deliberately not
 * released late — an 08:00 clip published at 16:00 lands on an audience that is
 * not there, which is worse than not publishing it.
 *
 * A server component: this is a read of rows the page already has.
 */

const OUTCOME_STYLE: Record<
  ScheduleRunOutcome,
  { label: string; icon: LucideIcon; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  SUCCEEDED: { label: "Released", icon: CheckCircle2, variant: "default" },
  SKIPPED: { label: "Skipped", icon: CircleSlash, variant: "secondary" },
  FAILED: { label: "Failed", icon: XCircle, variant: "destructive" },
  MISSED: { label: "Missed", icon: Clock, variant: "outline" },
};

export function ReleaseRunHistory({ runs }: { runs: ReleaseRunRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Release history</CardTitle>
        <CardDescription>
          Every slot, including the ones that released nothing.{" "}
          <span className="font-medium">Skipped</span> usually means nothing was
          banked, which is normal and fixes itself;{" "}
          <span className="font-medium">failed</span> means YouTube refused the
          upload; <span className="font-medium">missed</span> means nothing was
          running at the time, and the slot was passed over rather than
          published hours late.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {runs.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            Nothing yet. The first row appears the first time a slot on this
            cadence comes round.
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
                    {run.youtubeVideoId && (
                      <a
                        href={`https://www.youtube.com/watch?v=${run.youtubeVideoId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary text-xs underline-offset-4 hover:underline"
                      >
                        Watch on YouTube
                      </a>
                    )}
                  </div>

                  {run.shortTitle && <p className="font-medium">{run.shortTitle}</p>}
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
