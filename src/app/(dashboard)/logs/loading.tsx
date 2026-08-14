import {
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The activity log is a hand-rolled table, not a `DataTable`: no toolbar, no
 * mobile card view, and — the part worth mirroring exactly — fixed column
 * widths (`w-32` When, `w-20` Level, `w-56` Action, flexible Message, `w-24`
 * Target). A skeleton with evenly-divided columns would slide every column
 * sideways the moment the real header painted, which is precisely the jump
 * this file exists to prevent.
 *
 * Twelve rows rather than the page's full fifty: fifty skeleton rows is a wall
 * of grey well past the fold, and the first screenful is all anyone sees
 * before the data arrives.
 */
export default function LogsLoading() {
  const columns = ["w-32", "w-20", "w-56", "flex-1", "w-24"];

  return (
    <>
      <LoadingAnnouncement>Loading activity…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-28" descriptionWidth="w-96" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-full sm:w-64" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
        <Skeleton className="h-4 w-20" />
      </div>

      <div>
        <div className="flex items-center gap-4 border-b py-2">
          {columns.map((width) => (
            <Skeleton key={width} className={`h-4 ${width}`} />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: 12 }, (_, row) => (
            <div key={row} className="flex items-center gap-4 py-3">
              {columns.map((width) => (
                <Skeleton key={width} className={`h-4 ${width}`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
