import { Badge } from "@/components/ui/badge";
import type { VideoStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";

interface VideoStatusBadgeProps {
  status: VideoStatus;
  className?: string;
}

const STATUS_PRESENTATION: Record<VideoStatus, { label: string; className: string }> =
  {
    DRAFT: {
      label: "Draft",
      className: "bg-muted text-muted-foreground border-transparent",
    },
    QUEUED: {
      label: "Queued",
      className:
        "border-transparent bg-sky-500/12 text-sky-700 dark:text-sky-300",
    },
    GENERATING: {
      label: "Generating",
      className:
        "border-transparent bg-violet-500/12 text-violet-700 dark:text-violet-300",
    },
    RENDERING: {
      label: "Rendering",
      className:
        "border-transparent bg-amber-500/12 text-amber-700 dark:text-amber-300",
    },
    READY: {
      label: "Ready",
      className:
        "border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
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

export function VideoStatusBadge({ status, className }: VideoStatusBadgeProps) {
  const { label, className: toneClass } = STATUS_PRESENTATION[status];

  return (
    <Badge variant="outline" className={cn(toneClass, className)}>
      {label}
    </Badge>
  );
}
