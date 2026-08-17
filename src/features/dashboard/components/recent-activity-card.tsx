import { Activity } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RecentActivity } from "@/features/dashboard/types";
import type { LogLevel } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

const LEVEL_DOT_CLASS: Record<LogLevel, string> = {
  DEBUG: "bg-muted-foreground/40",
  INFO: "bg-sky-500",
  WARN: "bg-amber-500",
  ERROR: "bg-destructive",
};

/**
 * The same four levels in words.
 *
 * The dot above is the only thing distinguishing an error from an ordinary
 * event, which makes severity — the one property that decides whether a row is
 * worth reading — carried by hue alone. That fails anyone who cannot
 * distinguish amber from red as surely as it fails a screen reader, which was
 * being handed `aria-hidden` and nothing else. `activity-log-list.tsx` already
 * spells the level out in a badge; this brings the card in line with the table
 * it summarises, just visually hidden because the dot is doing the sighted job.
 */
const LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warning",
  ERROR: "Error",
};

export function RecentActivityCard({ items }: { items: RecentActivity[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>Pipeline and API events</CardDescription>
      </CardHeader>

      <CardContent>
        {items.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="Nothing logged yet"
            // Named triggers rather than "actions across the studio", which
            // told an operator nothing they could act on. The activity list on
            // /logs already says this; the dashboard's copy of the same empty
            // state was the one still describing itself in the abstract.
            description="Writing a script, narrating one, or publishing a video each leaves a line here — so this fills up on its own the moment you make something."
          />
        ) : (
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.id} className="flex gap-3">
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    LEVEL_DOT_CLASS[item.level],
                  )}
                  aria-hidden
                />
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    <span className="sr-only">{LEVEL_LABEL[item.level]}: </span>
                    {item.action}
                  </p>
                  {item.message && (
                    <p className="text-muted-foreground line-clamp-2 text-xs">
                      {item.message}
                    </p>
                  )}
                  <RelativeTime
                    date={item.createdAt}
                    className="text-muted-foreground text-xs"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
