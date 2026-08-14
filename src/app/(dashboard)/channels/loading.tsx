import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Channel rows are cards with a large avatar and two lines of text, roughly
 * 76px tall — noticeably shorter than the 48px-plus-gap bars the generic
 * fallback draws, and a different internal layout.
 *
 * Two rows: an operator connects one or two YouTube channels, not six.
 */
export default function ChannelsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading channels…</LoadingAnnouncement>

      <PageHeaderSkeleton
        titleWidth="w-32"
        descriptionWidth="w-80"
        actionWidth="w-36"
      />

      <div className="space-y-3">
        {Array.from({ length: 2 }, (_, index) => (
          <Card key={index}>
            <CardContent className="flex items-center gap-4 py-4">
              <Skeleton className="size-11 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="size-8 shrink-0 rounded-md" />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
