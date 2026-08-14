import {
  DataTableSkeleton,
  FootnoteSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
  SectionHeadingSkeleton,
} from "@/components/shared/skeletons";
import { StatCardSkeleton } from "@/components/shared/stat-card";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Two sections under a four-card stat grid: a short "ready to publish" list and
 * the full publications table. The stat grid is the part that matters most —
 * it sits directly under the header, so getting its height wrong moves
 * everything below it.
 */
export default function PublishingLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading publishing…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-36" descriptionWidth="w-96" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <div className="space-y-2">
        <SectionHeadingSkeleton width="w-44" />
        <div className="space-y-2">
          {Array.from({ length: 2 }, (_, index) => (
            <Card key={index}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-4 w-64" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-8 w-28" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <SectionHeadingSkeleton width="w-32" />
        {/* Eight columns, and this table does render the column toggle. */}
        <DataTableSkeleton rows={6} columns={8} hasColumnToggle />
      </div>

      <FootnoteSkeleton lines={3} />
    </>
  );
}
