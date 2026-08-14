import {
  FootnoteSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { StatCardSkeleton } from "@/components/shared/stat-card";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A gallery, not a list. The `aspect-video` block at the top of each card is
 * the reason this file exists: it is by far the tallest element per row, its
 * height depends on the column width, and nothing about the generic fallback
 * reserves it — so the page grew by several hundred pixels the instant the
 * images arrived.
 *
 * `aspect-video` rather than a fixed height, so the reservation stays correct
 * across all three column counts the grid uses.
 */
export default function ThumbnailStudioLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading thumbnails…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-36" descriptionWidth="w-full max-w-2xl" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Card key={index} className="overflow-hidden pt-0">
            <Skeleton className="aspect-video w-full rounded-none" />
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-5 w-12 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
              <Skeleton className="h-3 w-32" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <FootnoteSkeleton lines={3} />
    </>
  );
}
