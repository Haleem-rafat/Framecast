"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Video } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import { VideoStatus } from "@/generated/prisma/enums";
import type { VideoListItem } from "@/features/videos/types";

const STATUS_ORDER: string[] = Object.values(VideoStatus);

/**
 * Rows arrive already sorted newest-first by `videoService.list`, and no
 * `defaultSort` is passed so that ordering is what the operator sees on load —
 * the sort controls are there to answer a question, not to replace it. The
 * search box is separate from the status dropdown above the table: that one is
 * a route param the page owns, this one never leaves the client.
 */
export function VideoTable({
  videos,
  hasFilter,
}: {
  videos: VideoListItem[];
  hasFilter: boolean;
}) {
  const columns = useMemo<DataTableColumn<VideoListItem>[]>(
    () => [
      {
        id: "title",
        header: "Title",
        // The link wraps both lines so the whole title block stays one target.
        cell: (video) => (
          <Link href={`/videos/${video.id}`} className="hover:underline">
            <p className="font-medium">{video.title}</p>
            {video.topic && (
              <p className="text-muted-foreground truncate text-xs">
                {video.topic}
              </p>
            )}
          </Link>
        ),
        sortValue: (video) => video.title,
        // Topic is searchable but not sortable: it is a secondary line here,
        // and ordering by it would scramble the titles it sits under.
        filterValue: (video) => `${video.title} ${video.topic ?? ""}`,
        alwaysVisible: true,
      },
      {
        id: "project",
        header: "Project",
        cell: (video) => video.project.name,
        sortValue: (video) => video.project.name,
        filterValue: (video) => video.project.name,
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "status",
        header: "Status",
        cell: (video) => <VideoStatusBadge status={video.status} />,
        // Pipeline order, not alphabetical: grouping by where a video has got
        // to is the question this column gets asked, and "Draft, Failed,
        // Generating…" answers none of it. The enum is declared in pipeline
        // order, so its own index is the ranking — no second list to drift.
        sortValue: (video) => STATUS_ORDER.indexOf(video.status),
        // Underscores become spaces so a future multi-word status is still
        // findable by the words the badge shows; case is handled by the search.
        filterValue: (video) => video.status.replace(/_/g, " "),
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: (video) => <RelativeTime date={video.updatedAt} />,
        sortValue: (video) => video.updatedAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={videos}
      columns={columns}
      getRowId={(video) => video.id}
      caption="Videos"
      searchPlaceholder="Search videos"
      pageSize={25}
      columnToggle
      empty={
        <EmptyState
          icon={Video}
          title={hasFilter ? "No videos match that status" : "No videos yet"}
          description={
            hasFilter
              ? "Try a different status filter."
              : "Create your first video and take it from script to publish."
          }
        />
      }
    />
  );
}
