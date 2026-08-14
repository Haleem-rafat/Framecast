import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Four form cards of visibly different heights — Appearance carries a swatch
 * row and a live preview and is roughly twice the height of Storage, which has
 * one input. Drawing four equal cards would settle noticeably as the real form
 * paints, so each is given its own field count.
 */
function SettingsCardSkeleton({
  fields,
  extra,
}: {
  fields: number;
  /** Height of anything beyond the plain fields — a preview, a swatch row. */
  extra?: string;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-72" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {Array.from({ length: fields }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full sm:max-w-sm" />
              {/* Every field on this form carries a one-line note under it. */}
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
          {extra && <Skeleton className={extra} />}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading settings…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-28" descriptionWidth="w-80" />

      {/* The page renders a standing informational Alert above the form. */}
      <Card>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </CardContent>
      </Card>

      <div className="space-y-6">
        {/* Appearance: theme select, then the accent picker and its preview. */}
        <SettingsCardSkeleton fields={1} extra="h-36 w-full" />
        {/* Generation defaults: two side-by-side selects, then two more fields. */}
        <SettingsCardSkeleton fields={4} />
        {/* Publishing defaults: visibility and tags. */}
        <SettingsCardSkeleton fields={2} />
        {/* Storage: one bucket input. */}
        <SettingsCardSkeleton fields={1} />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      <Skeleton className="h-3 w-48" />
    </>
  );
}
