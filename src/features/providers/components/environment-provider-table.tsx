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
          // Wraps rather than staying one line: below `md` this cell is the
          // value half of a card's label/value pair, roughly 200px wide, and
          // unwrapped the sentence ran straight out of the card — which clips
          // it silently, since `Card` is `overflow-hidden`.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {status.configured ? (
              <Badge
                variant="outline"
                // emerald-600 sits near 3:1 on the card; 700 clears the
                // 4.5:1 this 12px badge text needs without changing the hue.
                className="gap-1 text-emerald-700 dark:text-emerald-300"
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
             * otherwise have fitted. `break-words` covers the one token that
             * cannot wrap on its own — the env var name, which has no break
             * opportunity in it at all. */}
            <span className="text-muted-foreground block max-w-sm text-xs break-words whitespace-normal">
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
