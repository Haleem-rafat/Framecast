import { Skeleton } from "@/components/ui/skeleton";

/**
 * Fallback for every dashboard route that doesn't have a more specific
 * loading.tsx. Next wraps page.tsx (and everything below it) in a Suspense
 * boundary at this level, so this is what the operator sees between a click
 * and the server component resolving — without it the previous page just
 * sits there looking frozen.
 *
 * Shaped after PageHeader plus a row list, the layout shared by
 * channels/projects/prompts/videos. Routes with a meaningfully different
 * shape (video detail, providers) override this with their own loading.tsx.
 */
export default function DashboardLoading() {
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </>
  );
}
