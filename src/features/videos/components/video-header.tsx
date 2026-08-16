import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ApproveScriptButton } from "@/features/videos/components/approve-script-button";
import { DeleteVideoButton } from "@/features/videos/components/delete-video-button";
import { PublishAttemptPanel } from "@/features/videos/components/publish-attempt-panel";
import { PublishVideoButton } from "@/features/videos/components/publish-video-button";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { FootageStyle, VideoFormat, VideoStatus } from "@/generated/prisma/enums";
import type { PublishVisibilityOption } from "@/schemas/publish.schema";
import { VIDEO_FORMATS, WORDS_PER_MINUTE } from "@/lib/video-format";
import type { PublishProgress, PublishTargets } from "@/services/publish.service";

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
  channelFootageStyle,
  youtubeVideoId,
  defaultVisibility,
  readyShortCount,
  publishTargets,
  publishProgress,
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
  /** That channel's footage style, which the approve dialog states the cost
   * of: illustrated footage is generated at real money per picture, while the
   * other two are stock downloads. Already defaulted by the page for a channel
   * with no brand row. */
  channelFootageStyle: FootageStyle;
  /** Set once Gate 2 has actually published this video. */
  youtubeVideoId: string | null;
  /** `UserSetting.defaultVisibility`, which the publish dialog's picker starts
   * on — see `PublishVideoButton`. */
  defaultVisibility: PublishVisibilityOption;
  /** How many shorts the publish dialog could upload alongside the video —
   * READY, with a file, never published. Zero hides the offer entirely. */
  readyShortCount: number;
  /** The publish dialog's channel picker, already resolved to what may and may
   * not be chosen — see `publishService.listPublishTargets`. Null for a video
   * that cannot be published yet, where there is no picker to draw. */
  publishTargets: PublishTargets | null;
  /**
   * This video's publish attempt, when it has one that has not reached YouTube:
   * an upload running right now, one that stopped when its process died, or one
   * that failed and said why. Null for every video with no `Publication` row and
   * for every video already published — see `publishService.getPublishProgress`.
   */
  publishProgress: PublishProgress | null;
}) {
  const estimatedMinutes = wordCount > 0 ? wordCount / WORDS_PER_MINUTE : 0;
  const canApprove = status === "DRAFT" && wordCount > 0;

  /**
   * An attempt that is running, or has stopped without finishing, takes the
   * publish button's place.
   *
   * Not beside it. A `Publication` row blocks a second `create()` regardless of
   * its status (Gate 2, and it stays that way), so a publish button next to a
   * stuck row is a button whose only possible outcome is "This video is already
   * being published" — which is exactly what an operator spent two hours
   * discovering after a deploy killed an upload mid-flight. The panel says what
   * the row actually is and offers the only action that helps.
   */
  const attemptInFlight =
    publishProgress !== null && publishProgress.youtubeVideoId === null;

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
          footageStyle={channelFootageStyle}
        />
        {attemptInFlight && publishProgress ? (
          <PublishAttemptPanel
            videoId={videoId}
            videoTitle={title}
            initialProgress={publishProgress}
          />
        ) : (
          <PublishVideoButton
            videoId={videoId}
            status={status}
            channelName={channelName}
            channelMadeForKids={channelMadeForKids}
            youtubeVideoId={youtubeVideoId}
            defaultVisibility={defaultVisibility}
            readyShortCount={readyShortCount}
            publishTargets={publishTargets}
          />
        )}
      </div>
    </div>
  );
}
