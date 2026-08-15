import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Cards of visibly different heights, each given its own field count for the
 * same reason the settings skeleton does it: four equal boxes settle
 * noticeably as the real form paints. Look carries a 16:9 preview under its
 * three fields, Voice a four-item list above two, Music a paragraph above one,
 * and Publishing the audience block.
 */
function BrandingCardSkeleton({
  fields,
  lead,
  extra,
}: {
  fields: number;
  /** Height of anything above the fields — an explanatory list or paragraph. */
  lead?: string;
  /** Height of anything below them — a preview, the audience block. */
  extra?: string;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3.5 w-72" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {lead && <Skeleton className={lead} />}
          {Array.from({ length: fields }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full sm:max-w-sm" />
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
          {extra && <Skeleton className={extra} />}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ChannelBrandingLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading this channel…</LoadingAnnouncement>

      <div>
        <Skeleton className="mb-2 h-8 w-28" />
        <PageHeaderSkeleton titleWidth="w-48" descriptionWidth="w-96" />
      </div>

      {/* Logo: the square and the generate button, side by side. */}
      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-3.5 w-80" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Skeleton className="size-24 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-8 w-40" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {/* Look: two colours, a font select, then the headline preview. */}
        <BrandingCardSkeleton fields={3} extra="aspect-video w-full max-w-sm" />
        {/* Voice: what tone and niche reach, then the two fields. */}
        <BrandingCardSkeleton fields={2} lead="h-20 w-full" />
        {/* Music: why the query is what it is, then one field. */}
        <BrandingCardSkeleton fields={1} lead="h-12 w-full" />
        {/* Publishing: language, category, the audience block, footage. */}
        <BrandingCardSkeleton fields={3} extra="h-28 w-full" />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      <Skeleton className="h-3 w-48" />
    </>
  );
}
