"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlert, ExternalLink, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { publishVideoAction } from "@/actions/publish.action";
import type { VideoStatus } from "@/generated/prisma/enums";
import type { SerializedError } from "@/lib/errors";

/** publish.service.ts hardcodes this — see its `uploadToYouTube` doc
 * comment. No client-side toggle exists for it, so the confirmation states
 * it as a fact rather than a choice the operator is making here. */
const UPLOAD_VISIBILITY_NOTE =
  "The video uploads as unlisted, not public — only people with the link can watch it.";

interface PublishFailure {
  message: string;
  showChannelsLink: boolean;
}

/**
 * `publish.service.ts`'s thrown messages are already specific and safe to
 * show verbatim (see `AppError`/`toSerializedError`) — every branch below
 * just adds the one thing the raw message can't: a next step. The channel
 * case is the only one the brief calls out by name (link to `/channels`);
 * every other branch still gets its exact server message, just not a bare
 * toast that vanishes before the operator reads it.
 */
function describePublishFailure(error: SerializedError): PublishFailure {
  if (error.code === "CONFLICT" && /channel before publishing/i.test(error.message)) {
    return { message: error.message, showChannelsLink: true };
  }

  if (error.code === "CONFLICT" && /already being published/i.test(error.message)) {
    return {
      message:
        `${error.message} There's no automatic retry for a stalled or failed publish — ` +
        "clearing the previous attempt is a manual step this button can't do.",
      showChannelsLink: false,
    };
  }

  // Covers PROVIDER_ERROR (the upload itself failing — its message is
  // already e.g. "The YouTube upload failed (500)."), the
  // RenderFileMissingError case ("no longer available"), and anything else —
  // every message reaching here is already a complete, specific sentence.
  return { message: error.message, showChannelsLink: false };
}

type Phase = "confirm" | "uploading" | "error";

export function PublishVideoButton({
  videoId,
  status,
  channelName,
  youtubeVideoId,
}: {
  videoId: string;
  status: VideoStatus;
  /** The project's assigned channel, or null if none is connected/assigned —
   * drives both the proactive "connect a channel" state and the
   * confirmation dialog's "publishes to <channel>" line. */
  channelName: string | null;
  /** Set once a `Publication` row exists with a recorded YouTube id. */
  youtubeVideoId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [failure, setFailure] = useState<PublishFailure | null>(null);

  // Gate 2 already ran — the only thing left to show is the real result,
  // not another confirmation.
  if (status === "PUBLISHED") {
    if (!youtubeVideoId) {
      return null;
    }

    return (
      <Button asChild variant="outline" size="lg">
        <a
          href={`https://youtube.com/watch?v=${youtubeVideoId}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink />
          View on YouTube
        </a>
      </Button>
    );
  }

  // Gate 2 only applies to a finished render — every other status either
  // hasn't reached it yet, or (FAILED) needs a human to look at what went
  // wrong before this button means anything again.
  if (status !== "READY") {
    return null;
  }

  function onOpenChange(next: boolean) {
    // Uploading a 170MB file takes minutes; closing the dialog mid-upload
    // would make the operator think nothing is happening when it actually
    // is. The request itself isn't cancelled by closing — only the ability
    // to close is gated.
    if (phase === "uploading") {
      return;
    }
    setOpen(next);
    if (!next) {
      // Some failures (a missing render file, the upload itself failing)
      // flip the video to FAILED server-side — see publish.service.ts's
      // second try/catch. Refreshing is deferred to here, on close, rather
      // than done the instant the error arrives: this component's own
      // `status !== "READY"` check further down would otherwise unmount
      // this dialog the moment fresh props (status: FAILED) land, wiping
      // the error message off the screen before the operator can read it.
      if (phase === "error") {
        router.refresh();
      }
      setPhase("confirm");
      setFailure(null);
    }
  }

  async function onConfirm() {
    setPhase("uploading");
    setFailure(null);

    const result = await publishVideoAction(videoId);

    if (!result.ok) {
      const described = describePublishFailure(result.error);
      setPhase("error");
      setFailure(described);
      toast.error("Could not publish this video", { description: described.message });
      return;
    }

    setOpen(false);
    setPhase("confirm");
    toast.success("Published to YouTube", {
      description: "The video is live as unlisted on the connected channel.",
    });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button size="lg" disabled={!channelName}>
            <Upload />
            Publish to YouTube
          </Button>
        </DialogTrigger>

        <DialogContent
          showCloseButton={phase !== "uploading"}
          onEscapeKeyDown={(event) => {
            if (phase === "uploading") event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (phase === "uploading") event.preventDefault();
          }}
        >
          {phase === "uploading" ? (
            <>
              <DialogHeader>
                <DialogTitle>Uploading to YouTube</DialogTitle>
                <DialogDescription>
                  This takes a few minutes for a video this size — don&apos;t close this tab.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Uploading, please wait…
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Publish to YouTube</DialogTitle>
                <DialogDescription>
                  This is the last step before this video is live on YouTube.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{UPLOAD_VISIBILITY_NOTE}</p>
                <p>
                  It publishes to <strong className="text-foreground">{channelName}</strong>.
                </p>
                <p>
                  This can&apos;t be undone from Framecast: there&apos;s no unpublish action
                  here, and a video can only be published once. To delete it or change its
                  visibility afterwards, use YouTube Studio.
                </p>
              </div>

              {phase === "error" && failure && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1">
                    <p>{failure.message}</p>
                    {failure.showChannelsLink && (
                      <Link href="/channels" className="underline underline-offset-3">
                        Go to channels
                      </Link>
                    )}
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button onClick={onConfirm}>
                  <Upload />
                  Publish
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {!channelName && (
        <p className="text-muted-foreground text-xs">
          <Link href="/channels" className="underline underline-offset-3">
            Connect a channel
          </Link>{" "}
          to publish this video.
        </p>
      )}
    </div>
  );
}
