import Link from "next/link";
import { Video } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { VideoListItem } from "@/features/videos/types";

export function VideoTable({
  videos,
  hasFilter,
}: {
  videos: VideoListItem[];
  hasFilter: boolean;
}) {
  if (videos.length === 0) {
    return (
      <EmptyState
        icon={Video}
        title={hasFilter ? "No videos match that status" : "No videos yet"}
        description={
          hasFilter
            ? "Try a different status filter."
            : "Create your first video and take it from script to publish."
        }
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {videos.map((video) => (
          <TableRow key={video.id}>
            <TableCell>
              <Link href={`/videos/${video.id}`} className="hover:underline">
                <p className="font-medium">{video.title}</p>
                {video.topic && (
                  <p className="text-muted-foreground truncate text-xs">
                    {video.topic}
                  </p>
                )}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {video.project.name}
            </TableCell>
            <TableCell>
              <VideoStatusBadge status={video.status} />
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              <RelativeTime date={video.updatedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
