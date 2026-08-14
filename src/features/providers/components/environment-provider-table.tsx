"use client";

import { useMemo } from "react";
import { CircleCheck, CircleDashed } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import type { EnvironmentProviderStatus } from "@/features/providers/environment-providers";

/**
 * Read-only mirror of `ProviderTable` for env-configured services — no
 * actions column, since there's nothing here to edit or revoke. Only the
 * presence booleans computed server-side ever reach this component; it must
 * never render `envVar`'s runtime value, only its name.
 *
 * Four fixed rows, so nothing here is sortable, searchable or paginated: it
 * goes through `DataTable` purely to inherit the same header semantics and
 * caption as every other table rather than to gain any interactivity.
 */
export function EnvironmentProviderTable({
  statuses,
}: {
  statuses: EnvironmentProviderStatus[];
}) {
  const columns = useMemo<DataTableColumn<EnvironmentProviderStatus>[]>(
    () => [
      {
        id: "service",
        header: "Service",
        cell: (status) => status.name,
        cellClassName: "font-medium",
      },
      {
        id: "status",
        header: "Status",
        cell: (status) => (
          <div className="flex items-center gap-2">
            {status.configured ? (
              <Badge
                variant="outline"
                className="gap-1 text-emerald-600 dark:text-emerald-400"
              >
                <CircleCheck className="size-3.5" />
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground gap-1">
                <CircleDashed className="size-3.5" />
                Not configured
              </Badge>
            )}
            {/* `TableCell` is `whitespace-nowrap`, which is right for the
             * short values every other cell holds and very wrong for a
             * sentence: this row alone was ~700px wide, making the table
             * scroll sideways on a phone to reach columns that would
             * otherwise have fitted. */}
            <span className="text-muted-foreground block max-w-sm text-xs whitespace-normal">
              Set as {status.envVar} in the environment — managed by the
              deployment, not editable here.
            </span>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={statuses}
      columns={columns}
      getRowId={(status) => status.name}
      caption="Services configured through deployment environment variables"
    />
  );
}
