import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * This route loads a video plus its script, every version, and its status
 * events in one request — the slowest fetch in the dashboard — so the
 * generic (dashboard)/loading.tsx skeleton (a flat row list) would jump
 * noticeably once the real header/script/sidebar layout paints. Mirrors
 * VideoHeader + ScriptPanel + VersionHistory/StatusEventsList instead.
 */
export default function VideoDetailLoading() {
  return (
    <>
      {/* The slowest fetch in the dashboard is also the longest a screen reader
       * spends on a page with no text on it. See (dashboard)/loading.tsx for
       * why this is a sibling in the fragment rather than a wrapper. */}
      <span role="status" className="sr-only">
        Loading video…
      </span>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Mirrors VideoPreview's layout so a video that has a render doesn't
       * jump the page once the real player paints in. A DRAFT video has
       * neither a RenderJob nor a VoiceOver and would just show two empty
       * cards here — acceptable since this skeleton is on screen for a single
       * fetch, not indefinitely. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="aspect-video w-full lg:col-span-2" />
        <Skeleton className="h-24 w-full" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-40" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-28" />
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
              <Skeleton className="h-[480px] w-full" />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="space-y-2">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
