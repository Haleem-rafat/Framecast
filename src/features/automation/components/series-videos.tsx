"use client";

import { useMemo } from "react";
import Link from "next/link";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { SeriesVideo } from "@/services/series.service";

/**
 * What this show has actually made.
 *
 * Both routes into it appear here — the ones a scheduled occurrence produced
 * and the ones an operator made on demand — because both carry `Video.seriesId`
 * and neither is more real than the other. The run history above answers a
 * different question ("why was there no video on the 3rd?"), which is why it is
 * a separate list and why an on-demand run writes no row in it.
 *
 * The format column earns its place on precisely this screen: it is the proof
 * that the series' own setting reached the video, rather than the operator
 * having to trust it did.
 */
export function SeriesVideos({
  videos,
  format,
}: {
  videos: SeriesVideo[];
  /** The series' configured format, so a row that disagrees with it — a video
   *  made before the setting was changed — is visible rather than confusing. */
  format: SeriesVideo["format"];
}) {
  const columns = useMemo<DataTableColumn<SeriesVideo>[]>(
    () => [
      {
        id: "title",
        header: "Video",
        cell: (video) => (
          <div className="max-w-[24rem]">
            <Link
              href={`/videos/${video.id}`}
              className="block truncate font-medium underline-offset-4 hover:underline"
            >
              {video.title}
            </Link>
            {video.topic && video.topic !== video.title && (
              <p className="text-muted-foreground truncate text-xs">{video.topic}</p>
            )}
          </div>
        ),
        sortValue: (video) => video.title,
        filterValue: (video) => `${video.title} ${video.topic ?? ""}`,
        alwaysVisible: true,
      },
      {
        id: "status",
        header: "Status",
        cell: (video) => <VideoStatusBadge status={video.status} />,
        sortValue: (video) => video.status,
      },
      {
        id: "format",
        header: "Format",
        cell: (video) => (
          <Badge variant={video.format === format ? "outline" : "secondary"}>
            {video.format === "VERTICAL" ? "Short" : "Full video"}
          </Badge>
        ),
        sortValue: (video) => video.format,
      },
      {
        id: "createdAt",
        header: "Made",
        cell: (video) => <RelativeTime date={video.createdAt} />,
        sortValue: (video) => video.createdAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
    ],
    [format],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Episodes</CardTitle>
        <CardDescription>
          Everything this series has made, whether a scheduled occurrence or
          &ldquo;Make one now&rdquo; produced it. Each one stops at a finished
          video — publishing is still a deliberate click.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {videos.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
            Nothing yet. Press &ldquo;Make one now&rdquo; to see the recipe
            applied, or wait for the next occurrence.
          </p>
        ) : (
          <DataTable
            rows={videos}
            columns={columns}
            getRowId={(video) => video.id}
            caption="Videos made by this series"
            pageSize={10}
          />
        )}
      </CardContent>
    </Card>
  );
}
