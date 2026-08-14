import { Badge } from "@/components/ui/badge";
import type { PublishStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

/**
 * `Publication.status`, which is not `Video.status` and deliberately says
 * something different: a scheduled video is PUBLISHED as far as `Video` is
 * concerned — Framecast has handed it over and has nothing left to do — while
 * this column keeps saying SCHEDULED until YouTube's own scheduler makes it
 * live. See publish.service.ts for why the two disagree on purpose.
 *
 * Presentation mirrors `VideoStatusBadge` rather than inventing a second
 * vocabulary of colour, so a row that reads "Failed" here looks like a video
 * that reads "Failed" there.
 */
const STATUS_PRESENTATION: Record<
  PublishStatus,
  { label: string; className: string }
> = {
  PENDING: {
    label: "Pending",
    className: "bg-muted text-muted-foreground border-transparent",
  },
  SCHEDULED: {
    label: "Scheduled",
    className: "border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-300",
  },
  UPLOADING: {
    label: "Uploading",
    className:
      "border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  PUBLISHED: {
    label: "Published",
    className: "border-transparent bg-primary/12 text-primary",
  },
  FAILED: {
    label: "Failed",
    className:
      "border-transparent bg-destructive/12 text-destructive dark:text-red-400",
  },
};

export function PublishStatusBadge({
  status,
  className,
}: {
  status: PublishStatus;
  className?: string;
}) {
  const { label, className: toneClass } = STATUS_PRESENTATION[status];

  return (
    <Badge variant="outline" className={cn(toneClass, className)}>
      {label}
    </Badge>
  );
}

/** Order the statuses are sorted in — the arc a publish travels, so grouping
 *  by "where did this get to" reads as a progression rather than as an
 *  alphabet. Same reasoning `VideoTable` applies to `VideoStatus`. */
export const PUBLISH_STATUS_ORDER: PublishStatus[] = [
  "PENDING",
  "UPLOADING",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED",
];
