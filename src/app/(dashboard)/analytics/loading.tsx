import {
  ContentCardSkeleton,
  FootnoteSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
  SectionHeadingSkeleton,
} from "@/components/shared/skeletons";
import { StatCardSkeleton } from "@/components/shared/stat-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Analytics is one heavy aggregate over the whole library, so this is the
 * longest wait on the dashboard — and the page it resolves into is nine
 * stacked blocks, nothing like the flat row list the generic
 * `(dashboard)/loading.tsx` draws. Falling back to that meant the page
 * reflowed from top to bottom the instant the query landed.
 *
 * The stat grids reuse `StatCardSkeleton` rather than approximating a card
 * with a rectangle: it is the same component the real cards are built from, so
 * the two cannot drift apart.
 */
export default function AnalyticsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading analytics…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-36" descriptionWidth="w-96" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* "Videos by status" — a BarList of the seven VideoStatus values. */}
        <ContentCardSkeleton headingWidth="w-36" bodyLines={5} />

        {/* "Render timings" is a three-column definition list over a
         * separator, not a bar list, so it gets its own shape. */}
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-52" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3 sm:gap-4">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-16" />
                </div>
              ))}
            </div>
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-3 w-4/5" />
          </CardContent>
        </Card>
      </div>

      <ContentCardSkeleton headingWidth="w-24" bodyLines={4} />

      <div className="space-y-2">
        <SectionHeadingSkeleton width="w-40" />
        <FootnoteSkeleton lines={3} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      {/* The daily cost chart: a fixed `h-40` bar row over its axis labels.
       * Reserving that exact height is the whole point — a chart is the tallest
       * thing on the page and the cheapest to get wrong. */}
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </CardHeader>
        <CardContent>
          <div className="flex h-40 items-end gap-0.5">
            {Array.from({ length: 30 }, (_, index) => (
              <Skeleton
                key={index}
                className="flex-1"
                // A flat row of equal bars reads as a table; varying the
                // heights keeps it legible as a chart without implying data.
                style={{ height: `${30 + ((index * 37) % 60)}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-16" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <ContentCardSkeleton headingWidth="w-28" bodyLines={4} />

        {/* Operation reliability is a five-column table inside a card. */}
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3 border-b pb-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-3 flex-1" />
              ))}
            </div>
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 py-1.5">
                {Array.from({ length: 5 }, (_, column) => (
                  <Skeleton key={column} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <FootnoteSkeleton lines={4} />
    </>
  );
}
