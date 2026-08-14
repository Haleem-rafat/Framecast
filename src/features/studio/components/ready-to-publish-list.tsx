import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";

import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ReadyVideoEntry } from "@/features/studio/types";

/**
 * Videos that have finished rendering and have no publication claiming them.
 *
 * Each row links to the video rather than publishing from here. That is not
 * timidity about the click: `publish()` buffers the whole ~170MB render into
 * the app process, takes minutes, cannot be undone from this app, and leaves
 * a `Publication` row that permanently blocks a retry (see publish.service.ts
 * on all four). It already has one carefully-built confirmation dialog on the
 * video's own page; a second entry point would be a second way to make an
 * irreversible mistake, and the two would have to be kept in step forever.
 *
 * The blockers are surfaced here instead, so an operator sees why a video
 * would be refused before opening it.
 */
export function ReadyToPublishList({ videos }: { videos: ReadyVideoEntry[] }) {
  if (videos.length === 0) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <CircleCheck className="size-4" />
          Nothing is waiting — every finished video has been published or is on
          its way.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {videos.map((video) => (
        <Card key={video.videoId}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium">{video.title}</p>
              <p className="text-muted-foreground text-xs">
                {video.projectName} · rendered <RelativeTime date={video.updatedAt} />
              </p>

              {video.channelTitle === null ? (
                <p className="text-destructive text-xs text-balance">
                  This video&apos;s project has no channel assigned, so
                  publishing will be refused until one is.
                </p>
              ) : video.isFinalizing ? (
                <p className="text-muted-foreground text-xs text-balance">
                  Still being finished off — its title, tags and thumbnail are
                  generated after the render, and publishing is refused until
                  they land.
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Publishes to {video.channelTitle}
                </p>
              )}
            </div>

            <Button asChild variant="outline" size="sm">
              <Link href={`/videos/${video.videoId}`}>
                Open video
                <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
