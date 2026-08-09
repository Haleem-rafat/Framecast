import { Clock } from "lucide-react";

import { ApproveScriptButton } from "@/features/videos/components/approve-script-button";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { VideoStatus } from "@/generated/prisma/enums";

/** Reading pace used to translate a script's word count into a runtime estimate. */
const WORDS_PER_MINUTE = 150;

export function VideoHeader({
  videoId,
  title,
  status,
  projectName,
  wordCount,
}: {
  videoId: string;
  title: string;
  status: VideoStatus;
  projectName: string;
  wordCount: number;
}) {
  const estimatedMinutes = wordCount > 0 ? wordCount / WORDS_PER_MINUTE : 0;
  const canApprove = status === "DRAFT" && wordCount > 0;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <VideoStatusBadge status={status} />
        </div>
        <p className="text-muted-foreground flex items-center gap-3 text-sm">
          <span>{projectName}</span>
          {wordCount > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" />
              ~{estimatedMinutes.toFixed(1)} min estimated
            </span>
          )}
        </p>
      </div>

      <ApproveScriptButton videoId={videoId} canApprove={canApprove} />
    </div>
  );
}
