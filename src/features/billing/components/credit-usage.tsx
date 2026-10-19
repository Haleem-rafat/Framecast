import { format, parseISO } from "date-fns";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface CreditUsageProps {
  days: { date: string; spent: number }[];
  spentInWindow: number;
  shorts: number;
  longVideos: number;
}

/**
 * Credits spent per day, as plain CSS columns — the same approach as the
 * analytics spend chart: no chart library, theme tokens for free, no client
 * JavaScript. Below it, what the credits have bought so far.
 */
export function CreditUsage({ days, spentInWindow, shorts, longVideos }: CreditUsageProps) {
  const max = Math.max(...days.map((day) => day.spent), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credits used</CardTitle>
        <CardDescription>
          {spentInWindow} in the last {days.length} days
          {max > 0 ? ` · busiest day ${max}` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {spentInWindow === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No credits used in the last {days.length} days.
          </p>
        ) : (
          <div>
            <div
              className="flex h-32 items-end gap-0.5"
              role="img"
              aria-label={`Credits used per day for the last ${days.length} days, ${spentInWindow} in total`}
            >
              {days.map((day) => (
                <div
                  key={day.date}
                  className="flex h-full flex-1 items-end"
                  title={`${format(parseISO(day.date), "d MMM")}: ${day.spent} credit${day.spent === 1 ? "" : "s"}`}
                >
                  <div
                    className={day.spent > 0 ? "bg-primary w-full rounded-sm" : "bg-border w-full rounded-sm"}
                    style={{ height: day.spent > 0 ? `${Math.max(4, (day.spent / max) * 100)}%` : "2px" }}
                  />
                </div>
              ))}
            </div>
            <div className="text-muted-foreground mt-2 flex justify-between text-xs">
              <span>{days[0] && format(parseISO(days[0].date), "d MMM")}</span>
              <span>{days.at(-1) && format(parseISO(days.at(-1)!.date), "d MMM")}</span>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border p-3">
            <dt className="text-muted-foreground">Shorts made</dt>
            <dd className="text-xl font-semibold tabular-nums">{shorts}</dd>
          </div>
          <div className="rounded-lg border p-3">
            <dt className="text-muted-foreground">Long videos made</dt>
            <dd className="text-xl font-semibold tabular-nums">{longVideos}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
