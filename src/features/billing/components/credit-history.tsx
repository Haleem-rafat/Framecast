import Link from "next/link";

import { RelativeTime } from "@/components/shared/relative-time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CreditReason } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

const REASON: Record<CreditReason, string> = {
  GRANT: "Added",
  CHARGE: "Video",
  REFUND: "Refund",
  EXPIRE: "Expired",
};

export function CreditHistory({
  rows,
}: {
  rows: {
    id: string;
    delta: number;
    reason: CreditReason;
    note: string | null;
    videoId: string | null;
    createdAt: Date;
  }[];
}) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">No credit activity yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>What</TableHead>
            <TableHead className="text-right">Credits</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <span className="font-medium">{REASON[row.reason]}</span>
                {row.note && <span className="text-muted-foreground"> · {row.note}</span>}
                {row.videoId && (
                  <>
                    {" · "}
                    <Link href={`/videos/${row.videoId}`} className="underline underline-offset-4">
                      open video
                    </Link>
                  </>
                )}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono tabular-nums",
                  row.delta < 0 ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {row.delta > 0 ? `+${row.delta}` : row.delta}
              </TableCell>
              <TableCell className="text-muted-foreground">
                <RelativeTime date={row.createdAt} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
