import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Pending accounts are a short list of wide rows — avatar, three stacked lines,
 * and the two decision buttons on the right — not the full-width bars the
 * generic dashboard fallback draws.
 *
 * Three rows, not six: this queue is normally empty or nearly so, and a
 * skeleton that promises six waiting people to an operator who has one is
 * misinformation, not a placeholder.
 */
export default function ApprovalsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading pending approvals…</LoadingAnnouncement>

      {/* The real header's action is a small "N waiting" badge. */}
      <PageHeaderSkeleton
        titleWidth="w-32"
        descriptionWidth="w-96"
        actionWidth="w-24"
      />

      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index}>
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3.5 w-56" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
