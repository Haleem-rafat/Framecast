import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The generic (dashboard)/loading.tsx skeleton is a flat row list; this page
 * is two tables (vault + env-configured providers) plus a spend summary, so
 * using the generic fallback would jump once the real layout paints.
 */
function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function ProvidersLoading() {
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      <div className="space-y-2">
        <Skeleton className="h-4 w-72" />
        {/* One row per aiProviderTypes entry (see provider-table.tsx). */}
        <TableSkeleton rows={4} />
      </div>

      <div className="space-y-2">
        <Skeleton className="h-4 w-96" />
        {/* One row per environment-providers.ts entry. */}
        <TableSkeleton rows={4} />
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="size-4 rounded" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-24" />
            <Skeleton className="mt-2 h-3 w-56" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
