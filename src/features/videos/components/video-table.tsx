"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Video } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { BulkDeleteVideosButton } from "@/features/videos/components/bulk-delete-videos-button";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import { VideoStatus } from "@/generated/prisma/enums";
import { VIDEO_FORMATS } from "@/lib/video-format";
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
        //
        // Both lines truncate against a capped width. A table cell sizes to its
        // content, so a single long title widened this column past the viewport
        // and put the entire table into horizontal scroll — and the `truncate`
        // already on the topic line did nothing by itself, because truncation
        // needs a bound to truncate against and nothing supplied one. `title`
        // keeps the full text reachable on hover now that it is clipped.
        cell: (video) => (
          <Link
            href={`/videos/${video.id}`}
            className="block max-w-[22rem] hover:underline"
            title={video.title}
          >
            <p className="truncate font-medium">{video.title}</p>
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
        id: "format",
        header: "Format",
        // The label, not the pixel dimensions: this column exists so a list
        // of twenty videos shows at a glance which three are vertical, and
        // "1080×1920" is a number to decode where "Short" is a word to read.
        // The detail page's badge carries both.
        cell: (video) => VIDEO_FORMATS[video.format].label,
        // Landscape first, matching the approve dialog's own order and the
        // enum's declaration order — grouping the two is the whole question
        // this column gets asked.
        sortValue: (video) => (video.format === "LANDSCAPE" ? 0 : 1),
        filterValue: (video) => VIDEO_FORMATS[video.format].label,
        cellClassName: "text-muted-foreground text-sm",
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
      selection={{
        // The title, not "row 3": a checkbox announced as "Select row 3" is
        // only marginally better than one announced as "checkbox", and the
        // number changes the moment the table is sorted.
        rowLabel: (video) => video.title,
        actions: ({ rows, clear }) => (
          <BulkDeleteVideosButton videos={rows} onDone={clear} />
        ),
      }}
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
