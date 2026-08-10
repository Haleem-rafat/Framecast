import { Clock } from "lucide-react";

import { ApproveScriptButton } from "@/features/videos/components/approve-script-button";
import { DeleteVideoButton } from "@/features/videos/components/delete-video-button";
import { PublishVideoButton } from "@/features/videos/components/publish-video-button";
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
  channelName,
  youtubeVideoId,
}: {
  videoId: string;
  title: string;
  status: VideoStatus;
  projectName: string;
  wordCount: number;
  /** The video's project's assigned channel, if any — Gate 2's confirmation
   * names it so the operator isn't guessing where the upload goes. */
  channelName: string | null;
  /** Set once Gate 2 has actually published this video. */
  youtubeVideoId: string | null;
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

      <div className="flex items-start gap-2">
        <DeleteVideoButton
          videoId={videoId}
          title={title}
          status={status}
          redirectToList
        />
        <ApproveScriptButton videoId={videoId} canApprove={canApprove} />
        <PublishVideoButton
          videoId={videoId}
          status={status}
          channelName={channelName}
          youtubeVideoId={youtubeVideoId}
        />
      </div>
    </div>
  );
}
