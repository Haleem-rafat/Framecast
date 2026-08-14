"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ExternalLink, Upload } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  PUBLISH_STATUS_ORDER,
  PublishStatusBadge,
} from "@/features/studio/components/publish-status-badge";
import type { PublicationEntry } from "@/features/studio/types";
import type { PublishVisibility } from "@/generated/prisma/enums";

const VISIBILITY_LABELS: Record<PublishVisibility, string> = {
  PUBLIC: "Public",
  UNLISTED: "Unlisted",
  PRIVATE: "Private",
};

/**
 * When a publication actually went live, or when it is due to.
 *
 * `publishedAt` is null for a SCHEDULED row on purpose — it means "when this
 * went live", and a video waiting on YouTube's scheduler has not (see
 * publish.service.ts). Reading the schedule date in that case is what keeps
 * the column from showing a blank for the one row whose timing is the most
 * interesting thing about it.
 */
function liveDate(entry: PublicationEntry): Date | null {
  return entry.publishedAt ?? entry.scheduledFor ?? null;
}

export function PublicationTable({
  publications,
}: {
  publications: PublicationEntry[];
}) {
  const columns = useMemo<DataTableColumn<PublicationEntry>[]>(
    () => [
      {
        id: "video",
        header: "Video",
        // Two titles, because they routinely differ: the second line is what
        // was actually sent to YouTube — `MetadataService`'s generated title,
        // clamped to 100 characters — and the first is what the operator
        // called it here. Only shown when they disagree.
        cell: (entry) => (
          <Link href={`/videos/${entry.videoId}`} className="hover:underline">
            <p className="font-medium">{entry.videoTitle}</p>
            {entry.title !== entry.videoTitle && (
              <p className="text-muted-foreground truncate text-xs">
                Published as: {entry.title}
              </p>
            )}
          </Link>
        ),
        sortValue: (entry) => entry.videoTitle,
        filterValue: (entry) => `${entry.videoTitle} ${entry.title}`,
        alwaysVisible: true,
      },
      {
        id: "channel",
        header: "Channel",
        cell: (entry) => entry.channelTitle,
        sortValue: (entry) => entry.channelTitle,
        filterValue: (entry) => entry.channelTitle,
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "status",
        header: "Status",
        cell: (entry) => <PublishStatusBadge status={entry.status} />,
        sortValue: (entry) => PUBLISH_STATUS_ORDER.indexOf(entry.status),
        filterValue: (entry) => entry.status,
      },
      {
        id: "visibility",
        header: "Visibility",
        cell: (entry) => VISIBILITY_LABELS[entry.visibility],
        sortValue: (entry) => VISIBILITY_LABELS[entry.visibility],
        filterValue: (entry) => VISIBILITY_LABELS[entry.visibility],
        cellClassName: "text-sm",
      },
      {
        id: "live",
        header: "Live",
        cell: (entry) => {
          const date = liveDate(entry);

          if (!date) {
            return <span className="text-muted-foreground">—</span>;
          }

          return (
            <span>
              <RelativeTime date={date} />
              {entry.publishedAt === null && (
                <span className="text-muted-foreground text-xs"> (due)</span>
              )}
            </span>
          );
        },
        sortValue: (entry) => liveDate(entry),
        firstSortDirection: "desc",
        cellClassName: "text-sm",
      },
      {
        id: "thumbnail",
        header: "Thumbnail",
        // Only meaningful once the upload landed: a FAILED or UPLOADING row
        // has a `thumbnailApplied` of false that means "not yet", not "it
        // was refused", and reporting that as a problem would send an
        // operator looking for a thumbnail bug behind an upload failure.
        cell: (entry) =>
          entry.status !== "PUBLISHED" && entry.status !== "SCHEDULED" ? (
            <span className="text-muted-foreground">—</span>
          ) : entry.thumbnailApplied ? (
            "Attached"
          ) : (
            <span className="text-muted-foreground">Not attached</span>
          ),
        sortValue: (entry) => entry.thumbnailApplied,
        cellClassName: "text-sm",
      },
      {
        id: "error",
        header: "Detail",
        cell: (entry) =>
          entry.error ? (
            <span className="text-destructive line-clamp-2">{entry.error}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        filterValue: (entry) => entry.error ?? "",
        cellClassName: "max-w-xs text-xs",
      },
      {
        id: "youtube",
        header: "",
        cell: (entry) =>
          entry.youtubeVideoId ? (
            <a
              href={`https://youtube.com/watch?v=${entry.youtubeVideoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm hover:underline"
            >
              <ExternalLink className="size-3.5" />
              YouTube
            </a>
          ) : null,
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={publications}
      columns={columns}
      getRowId={(entry) => entry.id}
      caption="Publications across every video"
      searchPlaceholder="Search publications"
      pageSize={25}
      columnToggle
      empty={
        <EmptyState
          icon={Upload}
          title="Nothing has been published yet"
          description="A video is published from its own page once it has finished rendering. Every attempt — successful, scheduled or failed — is recorded here."
        />
      }
    />
  );
}
