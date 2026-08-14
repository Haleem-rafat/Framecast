import { Film } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TimelinePanel } from "@/features/videos/components/timeline-panel";
import { timelineService } from "@/services/timeline.service";

/**
 * Resolves the timeline on the server and hands it to the panel.
 *
 * Same shape as the video detail page's other async sections: the data is
 * fetched here so the card paints with real sections instead of flashing a
 * placeholder a client fetch would immediately replace, and the whole thing
 * sits behind its own Suspense boundary because it reads storage (the
 * narration's alignment) and a `stat` of the render file — neither of which
 * should hold up the rest of the page.
 *
 * `get` throws `NOT_FOUND` for a video this user does not own, which cannot
 * happen where this is mounted (the page has already resolved the video for
 * this user), so a failure here is an infrastructure one. It degrades to a
 * short explanation rather than taking the page down — the same stance
 * `ShortsSection` takes for the same reason.
 */
export async function TimelineSection({
  userId,
  videoId,
}: {
  userId: string;
  videoId: string;
}) {
  const timeline = await timelineService.get(userId, videoId).catch(() => null);

  if (!timeline) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Film className="size-4" />
            Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t work out this video&apos;s timeline. Reloading the page tries
            again — nothing about the video itself has changed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <TimelinePanel timeline={timeline} />;
}

/** Mirrors the panel — a 16:9 player over a strip over a few rows — so the
 *  page does not jump when the real card lands. */
export function TimelineFallback() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-6 w-14" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-12 w-full" />
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_unused, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
