"use client";

import { useMemo } from "react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import type { AdminVideoSummary } from "@/features/admin/types";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";

/**
 * One person's videos, arranged to answer "why is this one stuck".
 *
 * Not a link to /videos/:id — that page is scoped to the signed-in operator's
 * own rows and would 404 on somebody else's video, which is correct and must
 * stay correct. Everything needed to diagnose a stall is therefore carried in
 * the row itself: the status, how many attempts it has burned, whether a
 * worker holds a live lease or a dead one, and what the last render job said.
 */
export function AdminVideoTable({ videos }: { videos: AdminVideoSummary[] }) {
  const columns = useMemo<DataTableColumn<AdminVideoSummary>[]>(
    () => [
      {
        id: "title",
        header: "Video",
        cell: (row) => (
          <div className="min-w-0">
            <span className="block truncate font-medium">{row.title}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {row.projectName}
              {row.deletedAt && " · deleted"}
            </span>
          </div>
        ),
        sortValue: (row) => row.title,
        filterValue: (row) => `${row.title} ${row.projectName}`,
        alwaysVisible: true,
      },
      {
        id: "status",
        header: "Status",
        cell: (row) => <VideoStatusBadge status={row.status} />,
        sortValue: (row) => row.status,
        filterValue: (row) => row.status,
      },
      {
        id: "stall",
        header: "Worker",
        cell: (row) => <StallCell video={row} />,
        // Sorted by how stuck it is, so the worst rows come to the top on one
        // click: a lapsed lease outranks a live one, which outranks idle.
        sortValue: (row) => stallRank(row),
        firstSortDirection: "desc",
      },
      {
        id: "render",
        header: "Last render",
        cell: (row) =>
          row.latestRender ? (
            <div className="min-w-0 text-sm">
              <span className="font-mono">{row.latestRender.status}</span>
              {row.latestRender.status === "RUNNING" && (
                <span className="text-muted-foreground">
                  {" "}
                  {row.latestRender.progress}%
                </span>
              )}
              {row.latestRender.error && (
                <span
                  className="text-destructive block truncate text-xs"
                  title={row.latestRender.error}
                >
                  {row.latestRender.error}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-sm">Never</span>
          ),
        sortValue: (row) => row.latestRender?.status,
      },
      {
        id: "failure",
        header: "Failure",
        cell: (row) =>
          row.failureReason ? (
            <span
              className="text-destructive block truncate text-xs"
              title={row.failureReason}
            >
              {row.failureReason}
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          ),
        filterValue: (row) => row.failureReason ?? "",
      },
      {
        id: "shorts",
        header: "Shorts",
        cell: (row) =>
          row.shortCount === 0 ? (
            <span className="text-muted-foreground text-sm">—</span>
          ) : (
            <span className="font-mono text-sm">
              {row.shortCount - row.shortsUnfinished}/{row.shortCount}
            </span>
          ),
        sortValue: (row) => row.shortsUnfinished,
        firstSortDirection: "desc",
        align: "right",
      },
      {
        id: "updated",
        header: "Updated",
        cell: (row) => <RelativeTime date={row.updatedAt} />,
        sortValue: (row) => row.updatedAt,
        firstSortDirection: "desc",
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={videos}
      columns={columns}
      getRowId={(row) => row.id}
      caption="This account's videos, most recently updated first"
      searchPlaceholder="Search videos"
      columnToggle
      pageSize={25}
    />
  );
}

/**
 * What the worker is doing with this row, in one chip.
 *
 * The distinction worth drawing is live lease vs lapsed lease. A video sitting
 * at RENDERING with a lease that expired an hour ago is not being worked on —
 * the worker holding it died — and it is claimable again but has not been
 * claimed. That is a different problem from a render genuinely in progress,
 * and the status column alone shows them as the same thing.
 */
function StallCell({ video }: { video: AdminVideoSummary }) {
  if (video.cancelRequestedAt) {
    return (
      <Badge variant="outline" className="border-transparent bg-muted">
        Cancelling
      </Badge>
    );
  }

  if (!video.leaseExpiresAt) {
    return (
      <span className="text-muted-foreground text-sm">
        {video.attempts > 0 ? `${video.attempts} attempts` : "Idle"}
      </span>
    );
  }

  const lapsed = video.leaseExpiresAt.getTime() <= Date.now();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge
        variant="outline"
        className={
          lapsed
            ? "border-transparent bg-destructive/12 text-destructive dark:text-red-400"
            : "border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-300"
        }
      >
        {lapsed ? "Lease lapsed" : "Leased"}
      </Badge>
      <RelativeTime
        date={video.leaseExpiresAt}
        className="text-muted-foreground text-xs"
      />
    </div>
  );
}

function stallRank(video: AdminVideoSummary): number {
  if (!video.leaseExpiresAt) return video.attempts > 0 ? 1 : 0;
  return video.leaseExpiresAt.getTime() <= Date.now() ? 3 : 2;
}
