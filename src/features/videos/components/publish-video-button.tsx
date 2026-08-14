"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { publishVideoAction } from "@/actions/publish.action";
import type { VideoStatus } from "@/generated/prisma/enums";
import type { SerializedError } from "@/lib/errors";
import {
  publishVisibilityOptions,
  type PublishVisibilityOption,
} from "@/schemas/publish.schema";

/**
 * What each choice actually does, in the terms that decide it.
 *
 * The consequence line matters more than the label here: "unlisted" reads to
 * most people as "a bit less visible than public", when what it really means
 * is that the video is in no search result, no browse surface and no
 * recommendation — it exists only for whoever is handed the link. That was the
 * value this button used to send for every publish, silently, so saying it
 * plainly next to the option is the point of the picker rather than a
 * decoration on it.
 */
const VISIBILITY_CHOICES: Record<
  PublishVisibilityOption,
  { label: string; consequence: string }
> = {
  PUBLIC: {
    label: "Public",
    consequence: "Anyone can find it — search, browse and recommendations.",
  },
  UNLISTED: {
    label: "Unlisted",
    consequence: "Only people you send the link to. Never surfaced by YouTube.",
  },
  PRIVATE: {
    label: "Private",
    consequence: "Nobody but you, until you change it in YouTube Studio.",
  },
};

/** What the success toast says, per choice — the same sentence the operator
 *  just read next to the option they picked, so the confirmation and the
 *  promise cannot drift apart. */
const PUBLISHED_NOTE: Record<PublishVisibilityOption, string> = {
  PUBLIC: "The video is live and public on the connected channel.",
  UNLISTED: "The video is live as unlisted — only people with the link can watch it.",
  PRIVATE: "The video is on the channel as private — only you can watch it.",
};

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
  if (
    error.code === "CONFLICT" &&
    /channel before publishing/i.test(error.message)
  ) {
    return { message: error.message, showChannelsLink: true };
  }

  if (
    error.code === "CONFLICT" &&
    /already being published/i.test(error.message)
  ) {
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
  defaultVisibility,
}: {
  videoId: string;
  status: VideoStatus;
  /** The project's assigned channel, or null if none is connected/assigned —
   * drives both the proactive "connect a channel" state and the
   * confirmation dialog's "publishes to <channel>" line. */
  channelName: string | null;
  /** Set once a `Publication` row exists with a recorded YouTube id. */
  youtubeVideoId: string | null;
  /**
   * `UserSetting.defaultVisibility` — what the picker starts on, and the one
   * thing that column has ever been read for.
   *
   * A *seed*, not a decision: the operator still confirms it on every publish,
   * because this upload cannot be undone from Framecast and cannot be
   * repeated. A saved preference of PUBLIC therefore preselects PUBLIC rather
   * than skipping the question.
   */
  defaultVisibility: PublishVisibilityOption;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [visibility, setVisibility] =
    useState<PublishVisibilityOption>(defaultVisibility);
  // Ids for the picker's labels. Generated rather than written out because
  // this component is rendered per video and nothing stops a future list view
  // from mounting two of them.
  const visibilityId = useId();

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
      // Reopening starts from the saved default again rather than from
      // whatever the last, abandoned attempt happened to leave selected — a
      // dialog that silently remembers PUBLIC from a cancelled publish is the
      // one way this picker could make an irreversible choice quieter than it
      // was before.
      setVisibility(defaultVisibility);
    }
  }

  async function onConfirm() {
    setPhase("uploading");
    setFailure(null);

    const result = await publishVideoAction(videoId, { visibility });

    if (!result.ok) {
      const described = describePublishFailure(result.error);
      setPhase("error");
      setFailure(described);
      toast.error("Could not publish this video", {
        description: described.message,
      });
      return;
    }

    setOpen(false);
    setPhase("confirm");
    toast.success("Published to YouTube", {
      description: PUBLISHED_NOTE[visibility],
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
                  This takes a few minutes for a video this size — don&apos;t
                  close this tab.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Uploading, please wait…
                </div>
              </DialogBody>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Publish to YouTube</DialogTitle>
                <DialogDescription>
                  This is the last step before this video is live on YouTube.
                </DialogDescription>
              </DialogHeader>

              <DialogBody>
                <fieldset className="space-y-2">
                  <legend id={`${visibilityId}-legend`} className="text-sm font-medium">
                    Who can watch it
                  </legend>
                  {/* Radix renders `role="radiogroup"`, which a fieldset's
                    * legend does not name on its own — a screen reader would
                    * announce an unlabelled group. */}
                  <RadioGroup
                    aria-labelledby={`${visibilityId}-legend`}
                    value={visibility}
                    onValueChange={(next) =>
                      setVisibility(next as PublishVisibilityOption)
                    }
                    className="gap-2"
                  >
                    {publishVisibilityOptions.map((option) => (
                      <div key={option} className="flex items-start gap-2.5">
                        <RadioGroupItem
                          value={option}
                          id={`${visibilityId}-${option}`}
                          className="mt-0.5"
                        />
                        {/* Label and consequence are inside one <Label>, so
                          * the whole two-line block is a click target and a
                          * screen reader announces the consequence as part of
                          * the option rather than as loose text after it. */}
                        <Label
                          htmlFor={`${visibilityId}-${option}`}
                          className="flex flex-col items-start gap-0.5 font-normal"
                        >
                          <span className="font-medium">
                            {VISIBILITY_CHOICES[option].label}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {VISIBILITY_CHOICES[option].consequence}
                          </span>
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                </fieldset>

                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    It publishes to{" "}
                    <strong className="text-foreground">{channelName}</strong>.
                  </p>
                  <p>
                    This can&apos;t be undone from Framecast: there&apos;s no
                    unpublish action here, and a video can only be published
                    once. To delete it or change its visibility afterwards, use
                    YouTube Studio.
                  </p>
                </div>

                {phase === "error" && failure && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <div className="space-y-1">
                      <p>{failure.message}</p>
                      {failure.showChannelsLink && (
                        <Link
                          href="/channels"
                          className="underline underline-offset-3"
                        >
                          Go to channels
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </DialogBody>

              <DialogFooter>
                {/* The chosen visibility is named on the button itself, not
                  * just in the picker above it: this is the click that cannot
                  * be taken back, and it should not be possible to make it
                  * without having read which of the three it commits to. */}
                <Button onClick={onConfirm}>
                  <Upload />
                  Publish as {VISIBILITY_CHOICES[visibility].label.toLowerCase()}
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
