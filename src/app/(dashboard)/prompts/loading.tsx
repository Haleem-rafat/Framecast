import {
  DataTableSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The prompt library is a six-tab strip over one category's `DataTable` —
 * search toolbar, four columns plus a checkbox on `md` and up, cards below it.
 * It used to be a grid of cards, and this file drew that; a fallback still
 * drawing the old shape is worse than the generic one, because it reserves
 * height in the wrong places and the page settles by jumping.
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

        <DataTableSkeleton rows={4} columns={5} />
      </div>
    </>
  );
}
