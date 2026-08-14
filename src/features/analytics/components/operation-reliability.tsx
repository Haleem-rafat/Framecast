import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OperationUsageRow } from "@/services/analytics.service";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPercent } from "@/utils/format";

/**
 * Per-operation reliability, cost and latency — the table view of the same
 * `ProviderUsage` rows the spend chart draws from.
 *
 * Latency shows an average rather than a percentile because computing a p95
 * would mean pulling every raw row; the average is labelled as an average so
 * it is not mistaken for a tail figure. A blank cell means the operation never
 * records a latency at all, which is different from being instant.
 */
export function OperationReliability({ rows }: { rows: OperationUsageRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By operation</CardTitle>
        <CardDescription>
          How often each pipeline step calls a provider, how often it fails, and
          what it costs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No provider calls recorded in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operation</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Failure rate</TableHead>
                <TableHead className="text-right">Avg latency</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const failureRate =
                  row.requests > 0 ? row.failures / row.requests : 0;

                return (
                  <TableRow key={row.operation}>
                    <TableCell className="font-mono text-xs">
                      {row.operation}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {row.requests}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-sm",
                        row.failures > 0 && "text-destructive",
                      )}
                    >
                      {formatPercent(failureRate)}
                      {row.failures > 0 && (
                        <span className="text-muted-foreground ml-1 text-xs">
                          ({row.failures})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono text-sm">
                      {row.avgLatencyMs === null
                        ? "not measured"
                        : `${Math.round(row.avgLatencyMs)}ms`}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatCurrency(row.costUsd)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
