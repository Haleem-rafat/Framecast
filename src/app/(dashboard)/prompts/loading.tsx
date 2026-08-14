import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The prompt library is a six-tab strip over a two-column grid of template
 * cards — the furthest of any route from the generic fallback's row list.
 *
 * The tab strip is drawn as one bar rather than six separate pills: the six
 * category names have very different widths, and six equal pills would visibly
 * redistribute when the real labels land. One bar of roughly the right total
 * width reserves the correct height and no false structure.
 */
export default function PromptsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading prompt templates…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-44" descriptionWidth="w-96" />

      <div className="space-y-4">
        <Skeleton className="h-9 w-full max-w-[29rem] rounded-lg" />

        <div className="flex items-center justify-end">
          <Skeleton className="h-8 w-32" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-3/4" />
                </div>
                <Skeleton className="ml-3 h-5 w-16 shrink-0 rounded-full" />
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
