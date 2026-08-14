import { format, parseISO } from "date-fns";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DailyUsagePoint } from "@/services/analytics.service";
import { formatCurrency } from "@/utils/format";

interface DailyCostChartProps {
  points: DailyUsagePoint[];
  /** When true the series was capped and is not safe to draw — see the service. */
  truncated: boolean;
  windowDays: number;
}

/**
 * Daily provider spend as plain CSS columns.
 *
 * There is no charting library in this project's dependencies, and one column
 * per day over a fixed window does not justify adding one — a flex row of
 * divs renders the same information, inherits the theme tokens for free, and
 * ships no JavaScript.
 *
 * Single series, one hue, one axis. Only the extremes are labelled: a number
 * over all thirty columns would be unreadable, and the peak plus the endpoints
 * are what anybody actually reads off a spend chart.
 */
export function DailyCostChart({
  points,
  truncated,
  windowDays,
}: DailyCostChartProps) {
  const max = Math.max(...points.map((point) => point.costUsd), 0);
  const total = points.reduce((sum, point) => sum + point.costUsd, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider spend per day</CardTitle>
        <CardDescription>
          Last {windowDays} days, deployment-wide. Peak day{" "}
          {max > 0 ? formatCurrency(max) : "—"}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {truncated ? (
          <p className="text-muted-foreground py-8 text-center text-sm text-balance">
            Too many usage events in this window to chart accurately. The totals
            above are still exact — only the day-by-day breakdown is withheld,
            because a partial series would understate the earliest days rather
            than admitting the gap.
          </p>
        ) : total === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No provider spend recorded in the last {windowDays} days.
          </p>
        ) : (
          <>
            {/* `items-end` anchors every column to a common baseline, which is
              * what makes the heights comparable at a glance. */}
            <div
              className="flex h-40 items-end gap-0.5"
              role="img"
              aria-label={`Daily provider spend for the last ${windowDays} days, peaking at ${formatCurrency(max)}`}
            >
              {points.map((point) => {
                const ratio = max > 0 ? point.costUsd / max : 0;

                return (
                  <div
                    key={point.date}
                    className="flex h-full flex-1 items-end"
                    // Native tooltip rather than a JS hover layer: this stays a
                    // server component, and the exact figure is one hover away
                    // without shipping a bundle for it.
                    title={`${format(parseISO(point.date), "d MMM")} — ${formatCurrency(point.costUsd)} across ${point.requests} ${point.requests === 1 ? "call" : "calls"}`}
                  >
                    <div
                      className={
                        point.costUsd > 0
                          ? "bg-primary w-full rounded-sm"
                          : // A zero day still gets a hairline, so a quiet
                            // stretch reads as measured-and-empty rather than
                            // as missing data.
                            "bg-border w-full rounded-sm"
                      }
                      style={{
                        height:
                          point.costUsd > 0
                            ? `${Math.max(3, ratio * 100)}%`
                            : "2px",
                      }}
                    />
                  </div>
                );
              })}
            </div>

            <div className="text-muted-foreground mt-2 flex justify-between text-xs">
              <span>
                {points[0] && format(parseISO(points[0].date), "d MMM")}
              </span>
              <span>
                {points.at(-1) && format(parseISO(points.at(-1)!.date), "d MMM")}
              </span>
            </div>

            {/* The same series as numbers, for anyone the columns do not reach.
              *
              * `role="img"` above collapses the whole bar chart to its one
              * `aria-label`, which makes the per-day `title` tooltips
              * unreachable — and those tooltips are mouse-only regardless, so
              * keyboard and touch users could not read a single day's figure
              * either. That is the entire content of the chart, available to
              * pointer users only.
              *
              * A table rather than a longer label, because the data is
              * genuinely tabular and a screen reader can then navigate it by
              * row and column instead of hearing thirty comma-separated
              * numbers. `sr-only` keeps the visual design exactly as it was —
              * this adds an alternative, it does not replace anything. */}
            <table className="sr-only">
              <caption>
                Daily provider spend for the last {windowDays} days
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Calls</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.date}>
                    <th scope="row">
                      {format(parseISO(point.date), "d MMM")}
                    </th>
                    <td>{formatCurrency(point.costUsd)}</td>
                    <td>{point.requests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
