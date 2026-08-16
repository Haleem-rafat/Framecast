"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, MonitorPlay, Smartphone } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { SeriesControls } from "@/features/automation/components/series-controls";
import type { SeriesSummary } from "@/services/series.service";

/**
 * Every show, in one table.
 *
 * A `DataTable` rather than the stack of cards the schedules list is, and the
 * difference is what the two lists are for. A schedule answers one question —
 * when does this next run — and there are rarely more than a handful. A series
 * is a *configuration*, and the reason it exists is that two of them on one
 * channel can differ: the whole value of this screen is being able to read
 * "vertical, quick-tips style, daily" against "landscape, deep-dive, weekly"
 * on adjacent rows and sort by any of it. That is a table. It also inherits the
 * search, the column toggle and the card layout below `md` for free, instead of
 * this page growing its own.
 */
export function SeriesList({ series }: { series: SeriesSummary[] }) {
  const columns = useMemo<DataTableColumn<SeriesSummary>[]>(
    () => [
      {
        id: "name",
        header: "Series",
        cell: (show) => (
          <div className="max-w-[20rem] space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/automation/series/${show.id}`}
                className="truncate font-medium underline-offset-4 hover:underline"
              >
                {show.name}
              </Link>
              <Badge variant={show.status === "ACTIVE" ? "default" : "secondary"}>
                {show.status === "ACTIVE" ? "Active" : "Paused"}
              </Badge>
            </div>
            {/* The cadence sits under the name rather than in a column of its
                own. It is a sentence, not a value — "Every Monday at 09:00
                (Africa/Cairo)" sorts meaninglessly and cost 230px, which was
                the difference between the actions column being on screen at
                1440px and being scrolled off it. */}
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <CalendarClock className="size-3 shrink-0" />
              {show.cadence}
            </p>
            {/* A show that stopped on its own says so in the list, not only on
                its own page. Most pauses are not the operator's doing — an
                empty queue, three failures in a row — and by definition they
                were not watching when it happened. */}
            {show.status === "PAUSED" && show.pausedReason && (
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                {show.pausedReason}
              </p>
            )}
          </div>
        ),
        sortValue: (show) => show.name,
        filterValue: (show) =>
          `${show.name} ${show.channelTitle} ${show.projectName} ${show.cadence}`,
        alwaysVisible: true,
      },
      {
        id: "channel",
        header: "Channel",
        cell: (show) => (
          <Link
            href={`/channels/${show.channelId}`}
            className="underline-offset-4 hover:underline"
          >
            {show.channelTitle}
          </Link>
        ),
        sortValue: (show) => show.channelTitle,
        filterValue: (show) => show.channelTitle,
        cellClassName: "text-sm",
      },
      {
        id: "style",
        header: "Script style",
        cell: (show) => <span className="text-sm">{show.scriptStyleName}</span>,
        sortValue: (show) => show.scriptStyleName,
        filterValue: (show) => show.scriptStyleName,
      },
      {
        id: "format",
        header: "Format",
        cell: (show) => (
          <Badge variant="outline">
            {show.format === "VERTICAL" ? <Smartphone /> : <MonitorPlay />}
            {show.format === "VERTICAL" ? "Short" : "Full video"}
          </Badge>
        ),
        sortValue: (show) => show.format,
      },
      {
        id: "nextRunAt",
        header: "Next episode",
        // The queue count rides along in this cell rather than taking a column
        // of its own: "when is the next one, and is there anything left to make
        // it from" is one question, and an empty queue is precisely what makes
        // the time above it a lie. Nine columns did not fit 1440px.
        cell: (show) => (
          <div>
            {show.status === "ACTIVE" && show.nextRunAt ? (
              // Meaningless while paused: showing a time there would advertise
              // a video that is not coming.
              <span suppressHydrationWarning>
                {show.nextRunAt.toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
            <p
              className={
                show.queuedTopicCount === 0
                  ? "text-destructive text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {show.queuedTopicCount === 0
                ? "No topics left"
                : `${show.queuedTopicCount} topic${show.queuedTopicCount === 1 ? "" : "s"} queued`}
            </p>
          </div>
        ),
        sortValue: (show) => (show.status === "ACTIVE" ? show.nextRunAt : null),
        cellClassName: "text-sm",
      },
      {
        id: "videos",
        header: "Episodes",
        cell: (show) => show.videoCount,
        sortValue: (show) => show.videoCount,
        firstSortDirection: "desc",
        align: "right",
        cellClassName: "text-sm tabular-nums",
      },
      {
        id: "actions",
        header: "Actions",
        cell: (show) => (
          <SeriesControls
            seriesId={show.id}
            seriesName={show.name}
            status={show.status}
            queuedTopicCount={show.queuedTopicCount}
            compact
          />
        ),
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={series}
      columns={columns}
      getRowId={(show) => show.id}
      caption="Your series"
      searchPlaceholder="Search series"
      pageSize={25}
      columnToggle
    />
  );
}
