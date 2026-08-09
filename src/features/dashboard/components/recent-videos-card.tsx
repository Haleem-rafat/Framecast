import Link from "next/link";
import { Video } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { RecentVideo } from "@/features/dashboard/types";
import { RelativeTime } from "@/components/shared/relative-time";

export function RecentVideosCard({ videos }: { videos: RecentVideo[] }) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Recent videos</CardTitle>
          <CardDescription>Latest activity across your projects</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/videos">View all</Link>
        </Button>
      </CardHeader>

      <CardContent>
        {videos.length === 0 ? (
          <EmptyState
            icon={Video}
            title="No videos yet"
            description="Create your first video and the pipeline will take it from script to publish."
            action={
              <Button asChild size="sm">
                <Link href="/videos/new">Create video</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-border divide-y">
            {videos.map((video) => (
              <li key={video.id}>
                <Link
                  href={`/videos/${video.id}`}
                  className="hover:bg-accent/50 -mx-2 flex items-center justify-between gap-4 rounded-md px-2 py-3 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-sm font-medium">{video.title}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {video.projectName} ·{" "}
                      <RelativeTime date={video.updatedAt} />
                    </p>
                  </div>
                  <VideoStatusBadge status={video.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
