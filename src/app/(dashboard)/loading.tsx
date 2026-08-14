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
 *
 * The skeletons are the sighted half of this. A `Skeleton` is an empty `<div>`,
 * so to a screen reader this page is not "loading" — it is nothing at all, on a
 * route whose `<h1>` has not arrived either. The `role="status"` line is the
 * other half: it is inserted with the rest of the fallback, which is what makes
 * a polite live region announce, so the wait gets stated once instead of being
 * passed over in silence.
 *
 * It is a sibling inside the fragment rather than a wrapper around everything,
 * on purpose. `main` in the dashboard layout is a `flex flex-col gap-6` and
 * these two blocks are meant to be its direct children; a wrapper would collapse
 * that gap, and `display: contents` — the usual dodge — has a history of
 * dropping the element out of the accessibility tree, which would remove the
 * very announcement being added here.
 */
export default function DashboardLoading() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading page…
      </span>

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
