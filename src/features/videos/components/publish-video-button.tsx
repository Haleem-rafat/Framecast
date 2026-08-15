"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Check, CircleAlert, ExternalLink, Loader2, Upload, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { publishVideoAction } from "@/actions/publish.action";
import type { VideoStatus } from "@/generated/prisma/enums";
import type { SerializedError } from "@/lib/errors";
import {
  audienceConsequence,
  audienceStatement,
} from "@/lib/youtube-audience";
import {
  publishVisibilityOptions,
  type PublishVisibilityOption,
} from "@/schemas/publish.schema";
import type { ShortPublishOutcome } from "@/services/publish.service";

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
  // Quota before anything else, because it is the failure whose fix is a clock
  // rather than an action and the one most likely to arrive at the end of a
  // day's publishing. The service's sentence already names the allowance and
  // when it resets (see `YouTubeQuotaError`), so there is nothing to add — this
  // branch exists so that no later branch can wrap it in advice that does not
  // apply.
  if (error.code === "PROVIDER_ERROR" && /daily upload allowance/i.test(error.message)) {
    return { message: error.message, showChannelsLink: false };
  }

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

/**
 * YouTube's own numbers, checked against the Data API docs rather than
 * remembered: a project gets 100 `videos.insert` calls a day in a bucket of
 * their own, and that bucket resets at midnight Pacific. The "1,600 units,
 * about six uploads a day" figure this app was built around was true until 4
 * December 2025 — the revision history records the cost dropping to roughly 100
 * units, and the quota tables now describe uploads as a flat 100-a-day
 * allocation. Stated in the dialog because "publish" is about to mean four
 * uploads instead of one, and the operator should know what that spends before
 * they click, not after a 403.
 */
const DAILY_UPLOAD_ALLOWANCE = 100;

type Phase = "confirm" | "uploading" | "error" | "results";

export function PublishVideoButton({
  videoId,
  status,
  channelName,
  channelMadeForKids,
  youtubeVideoId,
  defaultVisibility,
  readyShortCount,
}: {
  videoId: string;
  status: VideoStatus;
  /** The project's assigned channel, or null if none is connected/assigned —
   * drives both the proactive "connect a channel" state and the
   * confirmation dialog's "publishes to <channel>" line. */
  channelName: string | null;
  /**
   * The channel's audience declaration, stated in this dialog and editable
   * only on `/channels`.
   *
   * Deliberately not a control here. It is a COPPA declaration — the US FTC
   * has taken enforcement action over child-directed content declared
   * otherwise — and this is the dialog whose button cannot be un-clicked, so
   * a toggle in it would be a legal statement one stray click from being
   * false. But it is *shown*, because the operator should never send a
   * declaration they have not seen.
   */
  channelMadeForKids: boolean;
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
  /**
   * How many of this video's shorts this publish could upload: READY, with a
   * file, and never published before. A server-side count taken when the page
   * rendered (see `publishService.countPublishableShorts`), which is why the
   * dialog says what it *would* do and the result list says what it did.
   *
   * Zero means no control at all rather than a disabled one — there is nothing
   * an operator could do about it from here, and a greyed-out row that says
   * "0 shorts" is a question nobody asked.
   */
  readyShortCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [visibility, setVisibility] =
    useState<PublishVisibilityOption>(defaultVisibility);
  // Off by default, every time the dialog opens. Publishing cannot be undone
  // from here and a short cannot be published twice, so the expensive,
  // irreversible option is the one the operator has to reach for — never the
  // one they have to notice and turn off.
  const [includeShorts, setIncludeShorts] = useState(false);
  const [shortOutcomes, setShortOutcomes] = useState<ShortPublishOutcome[]>([]);
  // Ids for the picker's labels. Generated rather than written out because
  // this component is rendered per video and nothing stops a future list view
  // from mounting two of them.
  const visibilityId = useId();
  const shortsToggleId = useId();

  const uploadCount = 1 + (includeShorts ? readyShortCount : 0);

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
      //
      // `results` is deferred for the same reason and a stronger one: the
      // video published, so fresh props say PUBLISHED, and this component
      // swaps itself for a "View on YouTube" link the moment they land. A
      // report saying which of three clips failed must survive until the
      // operator closes it themselves.
      if (phase === "error" || phase === "results") {
        router.refresh();
      }
      setPhase("confirm");
      setFailure(null);
      setShortOutcomes([]);
      // Same reasoning as the visibility reset below: a reopened dialog asks
      // both questions again rather than remembering a tick from an attempt
      // that was abandoned.
      setIncludeShorts(false);
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

    const result = await publishVideoAction(videoId, { visibility, includeShorts });

    if (!result.ok) {
      const described = describePublishFailure(result.error);
      setPhase("error");
      setFailure(described);
      toast.error("Could not publish this video", {
        description: described.message,
      });
      return;
    }

    const shorts = result.data.shorts;
    const failed = shorts.filter((short) => short.error !== null);

    // A publish where the video went up and one clip did not is neither a
    // success nor a failure, and collapsing it to either would be a lie about
    // something that cannot be repeated. The dialog stays open and says which.
    if (failed.length > 0) {
      setShortOutcomes(shorts);
      setPhase("results");
      toast.warning("Published, but not every short made it", {
        description:
          `The video is live. ${failed.length} of ${shorts.length} shorts could not be ` +
          "uploaded, and shorts cannot be published twice — see the dialog for which.",
      });
      return;
    }

    setOpen(false);
    setPhase("confirm");
    toast.success("Published to YouTube", {
      description:
        shorts.length > 0
          ? `${PUBLISHED_NOTE[visibility]} ${shorts.length} short${
              shorts.length === 1 ? "" : "s"
            } went up alongside it.`
          : PUBLISHED_NOTE[visibility],
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
                  {uploadCount > 1
                    ? `Uploading ${uploadCount} videos, one after another — please wait…`
                    : "Uploading, please wait…"}
                </div>
              </DialogBody>
            </>
          ) : phase === "results" ? (
            <>
              <DialogHeader>
                <DialogTitle>Published, with problems</DialogTitle>
                <DialogDescription>
                  The video is on YouTube. Not every short is.
                </DialogDescription>
              </DialogHeader>

              <DialogBody>
                {/* Per short, never a summary. "2 of 3 uploaded" leaves the
                  * operator to work out which one is missing from a channel
                  * page, and shorts cannot be published twice — so the row that
                  * failed is the only thing that tells them what they now have
                  * to upload by hand, and why. */}
                <ul className="space-y-2 text-sm">
                  <li className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
                    <span>
                      The video published as{" "}
                      {VISIBILITY_CHOICES[visibility].label.toLowerCase()}.
                    </span>
                  </li>
                  {shortOutcomes.map((short) => (
                    <li key={short.shortId} className="flex items-start gap-2">
                      {short.error === null ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
                      ) : (
                        <X className="text-destructive mt-0.5 size-4 shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="font-medium">
                          Short {short.index + 1}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {short.title}
                        </span>
                        {short.error !== null && (
                          <span className="text-destructive block text-xs">
                            {short.error}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="text-muted-foreground text-sm">
                  A short that failed can&apos;t be retried from here — the
                  attempt is recorded so a second click can never upload a clip
                  YouTube may already hold. Upload the missing ones by hand from
                  the shorts panel&apos;s players.
                </p>
              </DialogBody>

              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </DialogFooter>
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

                {/* Not rendered at all when there is nothing to offer, rather
                  * than rendered disabled: an operator whose shorts are still
                  * encoding (or who has none) can do nothing about it from
                  * inside this dialog, and a greyed-out "0 shorts" row is a
                  * question nobody asked. */}
                {readyShortCount > 0 && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <Label
                        htmlFor={shortsToggleId}
                        className="flex flex-col items-start gap-0.5 font-normal"
                      >
                        <span className="font-medium">
                          Also publish {readyShortCount} ready short
                          {readyShortCount === 1 ? "" : "s"}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          Each goes up as its own video on the same channel, at
                          the same visibility, and can only be published once.
                        </span>
                      </Label>
                      <Switch
                        id={shortsToggleId}
                        checked={includeShorts}
                        onCheckedChange={setIncludeShorts}
                        className="mt-0.5"
                      />
                    </div>

                    {/* The cost, before the click rather than after a 403.
                      * Uploads have their own daily allocation — see
                      * DAILY_UPLOAD_ALLOWANCE — so this is a count of videos,
                      * not a units calculation. */}
                    <p className="text-muted-foreground text-xs">
                      This uploads {uploadCount} video
                      {uploadCount === 1 ? "" : "s"} — {uploadCount} of the{" "}
                      {DAILY_UPLOAD_ALLOWANCE} uploads YouTube allows this
                      project per day, which resets at midnight Pacific.
                    </p>
                  </div>
                )}

                {/* Stated, never asked. The declaration is the channel's and
                  * is set on /channels; what belongs here is the fact that it
                  * is about to be sent, on this video and on every short going
                  * up with it. An operator who has never opened the channel
                  * dialog sees "not made for kids" here — which is exactly the
                  * moment to notice it, before the upload rather than after
                  * YouTube has the declaration. */}
                <div className="space-y-1 rounded-lg border p-3 text-sm">
                  <p className="font-medium">
                    {audienceStatement(channelMadeForKids)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {audienceConsequence(channelMadeForKids)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Set per channel, and it applies to{" "}
                    {uploadCount > 1 ? "every file in this upload" : "this upload"}.{" "}
                    <Link
                      href="/channels"
                      className="underline underline-offset-3"
                    >
                      Change it on the channel
                    </Link>{" "}
                    before publishing if it is wrong.
                  </p>
                </div>

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
                  * without having read which of the three it commits to. The
                  * count joins it for the same reason — "publish" meaning four
                  * uploads instead of one is exactly the kind of thing that
                  * should be legible on the button doing it. */}
                <Button onClick={onConfirm}>
                  <Upload />
                  Publish {uploadCount > 1 ? `${uploadCount} videos ` : ""}as{" "}
                  {VISIBILITY_CHOICES[visibility].label.toLowerCase()}
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
