import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ApproveScriptButton } from "@/features/videos/components/approve-script-button";
import { DeleteVideoButton } from "@/features/videos/components/delete-video-button";
import { PublishVideoButton } from "@/features/videos/components/publish-video-button";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { VideoFormat, VideoStatus } from "@/generated/prisma/enums";
import type { PublishVisibilityOption } from "@/schemas/publish.schema";
import { VIDEO_FORMATS, WORDS_PER_MINUTE } from "@/lib/video-format";

export function VideoHeader({
  videoId,
  title,
  status,
  format,
  projectName,
  wordCount,
  characterCount,
  channelName,
  channelMadeForKids,
  youtubeVideoId,
  defaultVisibility,
  readyShortCount,
}: {
  videoId: string;
  title: string;
  status: VideoStatus;
  /** Landscape until the operator approves the script as something else. Shown
   *  beside the status because it is the other thing about a video that cannot
   *  be changed after Gate 1, and because everything below the header — the
   *  player, the timeline, the shorts panel — is a different shape because of
   *  it. */
  format: VideoFormat;
  projectName: string;
  wordCount: number;
  /** The active script's length in characters. Only the approve dialog uses
   *  it, and only to state what the narration will actually be billed. */
  characterCount: number;
  /** The video's project's assigned channel, if any — Gate 2's confirmation
   * names it so the operator isn't guessing where the upload goes. */
  channelName: string | null;
  /** That channel's audience declaration, which the publish dialog states as
   * a fact about the upload it is about to make. Already defaulted by the
   * page for a channel with no brand row. */
  channelMadeForKids: boolean;
  /** Set once Gate 2 has actually published this video. */
  youtubeVideoId: string | null;
  /** `UserSetting.defaultVisibility`, which the publish dialog's picker starts
   * on — see `PublishVideoButton`. */
  defaultVisibility: PublishVisibilityOption;
  /** How many shorts the publish dialog could upload alongside the video —
   * READY, with a file, never published. Zero hides the offer entirely. */
  readyShortCount: number;
}) {
  const estimatedMinutes = wordCount > 0 ? wordCount / WORDS_PER_MINUTE : 0;
  const canApprove = status === "DRAFT" && wordCount > 0;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {title}
          </h1>
          <VideoStatusBadge status={status} />
          {/* Only once it means something. A draft's format is still the
            * approve dialog's to decide, and a badge saying "Full video" on a
            * video nobody has approved yet would be stating a default as a
            * decision. */}
          {status !== "DRAFT" && (
            <Badge variant="outline" className="font-normal">
              {VIDEO_FORMATS[format].label} · {VIDEO_FORMATS[format].dimensions}
            </Badge>
          )}
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

      {/* Delete, Approve and Publish come to more than 343px together, and a
       * row that cannot wrap takes the page with it. */}
      <div className="flex flex-wrap items-start gap-2">
        <DeleteVideoButton
          videoId={videoId}
          title={title}
          status={status}
          redirectToList
        />
        <ApproveScriptButton
          videoId={videoId}
          canApprove={canApprove}
          wordCount={wordCount}
          characterCount={characterCount}
        />
        <PublishVideoButton
          videoId={videoId}
          status={status}
          channelName={channelName}
          channelMadeForKids={channelMadeForKids}
          youtubeVideoId={youtubeVideoId}
          defaultVisibility={defaultVisibility}
          readyShortCount={readyShortCount}
        />
      </div>
    </div>
  );
}
