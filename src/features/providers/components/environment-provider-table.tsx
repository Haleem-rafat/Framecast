import { CircleCheck, CircleDashed } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EnvironmentProviderStatus } from "@/features/providers/environment-providers";

/**
 * Read-only mirror of `ProviderTable` for env-configured services — no
 * actions column, since there's nothing here to edit or revoke. Only the
 * presence booleans computed server-side ever reach this component; it must
 * never render `envVar`'s runtime value, only its name.
 */
export function EnvironmentProviderTable({
  statuses,
}: {
  statuses: EnvironmentProviderStatus[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Service</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {statuses.map((status) => (
          <TableRow key={status.name}>
            <TableCell className="font-medium">{status.name}</TableCell>
            <TableCell>
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
                <span className="text-muted-foreground text-xs">
                  Set as {status.envVar} in the environment — managed by the
                  deployment, not editable here.
                </span>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
