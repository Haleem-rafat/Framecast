"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ImageOff, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { retryThumbnailAction } from "@/actions/publish.action";

/**
 * Says, on the video page, that a published video went up without the
 * thumbnail this app made for it — and offers the one-click fix.
 *
 * This exists because the alternative was nothing. The thumbnail attach has
 * always been allowed to fail softly (it runs after the upload has already
 * committed, and no thumbnail problem may unwind a publish that succeeded),
 * but the failure was recorded only as `Publication.thumbnailApplied = false`
 * in a table no page reads, plus a `console.error` in a container log that is
 * discarded on the next deploy. The operator's first published video went out
 * with a YouTube-chosen frame and the app never mentioned it.
 *
 * Rendered only for a real failure — a published video with a recorded reason.
 * A video published with no thumbnail at all is not a failure and gets nothing
 * here, because a warning that fires when nothing is wrong is a warning the
 * operator learns to scroll past.
 *
 * The retry is safe to press repeatedly, which is why it is a plain button and
 * not behind a confirmation: `thumbnails.set` replaces rather than adds, costs
 * 50 quota units against a different allowance from the daily upload count,
 * and cannot re-upload the video — see `retryThumbnailAction`. It is
 * deliberately not in the publish dialog, which is the one-shot control.
 */
export function ThumbnailNotice({
  videoId,
  error,
}: {
  videoId: string;
  /** The recorded reason from `Publication.thumbnailError`. Null means there
   *  is nothing to report and this component renders nothing. */
  error: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onRetry() {
    startTransition(async () => {
      const result = await retryThumbnailAction(videoId);

      if (!result.ok) {
        toast.error("Could not retry the thumbnail", {
          description: result.error.message,
        });
        return;
      }

      if (!result.data.applied) {
        // The retry ran and YouTube refused again. The new reason is already
        // persisted, so the notice below re-renders with it after the refresh;
        // the toast is what tells the operator the click did something.
        toast.error("YouTube refused the thumbnail again", {
          description: result.data.error ?? undefined,
        });
        router.refresh();
        return;
      }

      toast.success("Thumbnail applied", {
        description: "It can take a few minutes to appear on YouTube.",
      });
      router.refresh();
    });
  }

  if (!error) {
    return null;
  }

  return (
    <div
      role="status"
      className="border-foreground/10 bg-card flex flex-wrap items-start gap-3 rounded-lg border p-3"
    >
      <ImageOff
        aria-hidden="true"
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Thumbnail could not be applied</p>
        <p className="text-muted-foreground text-sm text-pretty">
          {/* Verbatim, and deliberately: the reason is written to be shown —
              see `describeThumbnailFailure` in publish.service.ts — and
              paraphrasing "verify the channel at youtube.com/verify" into
              "something went wrong" is how this failure stayed invisible for a
              whole video in the first place. */}
          {error}. The video itself published fine and is still on YouTube —
          only the custom image is missing, and YouTube picked a frame instead.
        </p>
      </div>
      <Button
        onClick={onRetry}
        disabled={isPending}
        variant="outline"
        size="sm"
        className="shrink-0"
      >
        {isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
        Retry thumbnail
      </Button>
    </div>
  );
}
