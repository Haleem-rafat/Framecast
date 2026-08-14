import Link from "next/link";
import { Activity } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ActivityLogEntry } from "@/features/logs/types";
import type { LogLevel } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

const LEVEL_CLASS: Record<LogLevel, string> = {
  DEBUG: "text-muted-foreground",
  INFO: "text-sky-600 dark:text-sky-400",
  WARN: "text-amber-600 dark:text-amber-400",
  ERROR: "text-destructive",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: "Debug",
  INFO: "Info",
  WARN: "Warn",
  ERROR: "Error",
};

/**
 * `entityType` is a free-text discriminator rather than a real relation, so
 * only the values this app is known to write can be turned into a link — an
 * unrecognised type renders as plain text rather than guessing at a route that
 * would 404.
 */
function entityHref(entry: ActivityLogEntry): string | null {
  if (entry.entityType === "Video" && entry.entityId) {
    return `/videos/${entry.entityId}`;
  }
  return null;
}

interface ActivityLogListProps {
  entries: ActivityLogEntry[];
  /** Changes the empty copy: no rows at all reads differently from no matches. */
  hasFilter: boolean;
}

export function ActivityLogList({ entries, hasFilter }: ActivityLogListProps) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title={hasFilter ? "No matching activity" : "Nothing logged yet"}
        description={
          hasFilter
            ? "No events match these filters. Try widening them."
            : "Generating a script, narration or publish will start filling this log."
        }
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-32">When</TableHead>
          <TableHead className="w-20">Level</TableHead>
          <TableHead className="w-56">Action</TableHead>
          <TableHead>Message</TableHead>
          <TableHead className="w-24">Target</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const href = entityHref(entry);

          return (
            <TableRow key={entry.id}>
              <TableCell className="text-muted-foreground whitespace-nowrap">
                <RelativeTime date={entry.createdAt} />
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn("font-normal", LEVEL_CLASS[entry.level])}
                >
                  {LEVEL_LABEL[entry.level]}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">{entry.action}</TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {entry.message ?? "—"}
              </TableCell>
              <TableCell>
                {href ? (
                  <Link href={href} className="text-sm underline-offset-4 hover:underline">
                    {entry.entityType}
                  </Link>
                ) : (
                  <span className="text-muted-foreground text-sm">
                    {entry.entityType ?? "—"}
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
