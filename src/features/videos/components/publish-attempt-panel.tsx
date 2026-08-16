"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  clearStuckPublicationAction,
  getPublishProgressAction,
} from "@/actions/publish.action";
import { useLiveElapsedSeconds } from "@/hooks/use-live-elapsed-seconds";
import type { PublishProgress } from "@/services/publish.service";
import { formatBytes, formatDuration } from "@/utils/format";

/**
 * How often a running upload is asked how it is doing.
 *
 * Slower than `POLL_INTERVAL_ACTIVE_MS` (2s, pipeline-panel.tsx) on purpose,
 * because the two are watching different things. A render's percentage moves
 * continuously; an upload's moves once per 8 MiB chunk, which on the uplink
 * that produced the two-hour publish is once every couple of minutes. Polling
 * at 2s would be sixty requests per observable change, on a box where the app
 * shares a machine with a render worker on two vCPUs.
 *
 * Five seconds is still well inside "this page is alive" — and the clock
 * between polls does not stutter regardless, because `useLiveElapsedSeconds`
 * advances the elapsed time locally, exactly as the render panel's does.
 */
const PUBLISH_POLL_INTERVAL_MS = 5000;

/**
 * An estimate, phrased as one.
 *
 * `formatDuration`'s `12:04` is right for a measured elapsed time and wrong for
 * a projection — a clock face reads as precision, and this number is derived
 * from an average rate over a link that is not steady. Rounding to a unit the
 * operator can act on ("about 20 minutes") says the same thing without
 * promising the seconds.
 */
function formatEstimate(seconds: number): string {
  if (seconds < 60) return "less than a minute";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `about ${hours} hour${hours === 1 ? "" : "s"}`
    : `about ${hours}h ${rest}m`;
}

/**
 * Bytes sent against bytes total, and what that rate implies.
 *
 * The whole of Defect 2 in one component, and every number in it was written by
 * the server: the operator could not tell a slow upload from a dead one because
 * nothing measured anything, and a measurement owned by a React component would
 * have evaporated the moment they closed the tab — which is precisely when they
 * needed it. This renders `PublishProgress`, which is read from the
 * `Publication` row, so it draws the same thing in the publish dialog, on the
 * video page after a reload, and on a different device.
 *
 * No bar without a total. A file whose size is not yet recorded gets a sentence
 * instead — the same rule `StageProgress` follows in pipeline-panel.tsx, and for
 * the same reason: a horizontal indicator is read as "this far along", so
 * drawing one with nothing behind it invents the one fact this panel exists to
 * report honestly.
 */
export function UploadProgressReadout({
  progress,
  dataUpdatedAt,
}: {
  progress: PublishProgress;
  /** When the numbers below were fetched, so the elapsed clock can advance from
   *  there rather than jumping on each poll. */
  dataUpdatedAt: number;
}) {
  // Ticks only while something is actually uploading. A stalled attempt's
  // elapsed time is frozen, which is the truth about it.
  const elapsedSeconds = useLiveElapsedSeconds(
    progress.elapsedSeconds,
    dataUpdatedAt,
    progress.isLive,
  );

  const percentLabel =
    progress.percent === null ? null : `${Math.floor(progress.percent)}%`;

  return (
    <div className="space-y-2">
      {progress.percent !== null && progress.totalBytes !== null ? (
        <>
          {/* Radix renders `role="progressbar"`; a progressbar with no
            * accessible name is announced as a bare number. Not a live region
            * and must not become one — a progressbar's value changes are not
            * announced, by design. */}
          <Progress
            value={progress.percent}
            aria-label="Upload progress"
            aria-valuetext={`${percentLabel} uploaded to YouTube`}
            className="h-1.5"
          />
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="text-foreground font-medium tabular-nums">
              {percentLabel}
            </span>
            <span className="tabular-nums">
              {formatBytes(progress.uploadedBytes)} of{" "}
              {formatBytes(progress.totalBytes)}
            </span>
            {elapsedSeconds !== null && (
              <span className="tabular-nums">
                {formatDuration(elapsedSeconds)} elapsed
              </span>
            )}
            {/* Only while it is running. "About 12 minutes left" under an
              * upload that died three hours ago would be the same lie the
              * spinner was telling. */}
            {progress.isLive && progress.remainingSeconds !== null && (
              <span>{formatEstimate(progress.remainingSeconds)} left</span>
            )}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          {progress.isLive
            ? "Preparing the upload — reading the render and opening a session with YouTube."
            : "This attempt stopped before any of the file was sent."}
        </p>
      )}
    </div>
  );
}

/**
 * The dialog that stands between an operator and the one recoverable mistake
 * left in this path.
 *
 * Clearing a stuck record is safe exactly when the video is not on the channel,
 * and *nothing in Framecast can check that* — an upload killed mid-PUT may have
 * had every byte accepted before the process died reading the response. So the
 * app states what it knows, names the channel, links straight to it, and makes
 * the confirmation a claim about something the operator has actually done. The
 * switch is not friction for its own sake: it is the difference between a
 * button that means "yes, clear it" and one that means "I have looked".
 */
function ClearAttemptDialog({
  videoId,
  progress,
}: {
  videoId: string;
  progress: PublishProgress;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Generated rather than written out: nothing stops a future list view from
  // mounting two of these, and two switches sharing an id would both toggle
  // from one label.
  const confirmId = useId();

  async function onConfirm() {
    setClearing(true);
    const result = await clearStuckPublicationAction(videoId);
    setClearing(false);

    if (!result.ok) {
      // Every refusal from `clearStuckPublication` is already a complete
      // sentence naming what to do instead — an upload that came back to life,
      // a video that turned out to be on YouTube — so it is shown verbatim.
      toast.error("Could not clear this attempt", {
        description: result.error.message,
      });
      return;
    }

    setOpen(false);
    setChecked(false);
    toast.success("Cleared the stuck publish attempt", {
      description: result.data.videoRestoredToReady
        ? "This video can be published again. Nothing was sent to YouTube."
        : "The record is gone. This video has no finished render left, so it needs " +
          "rendering again before it can be published.",
    });
    router.refresh();
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Reopening asks again. A tick left over from a dialog the operator
        // backed out of is the one way this confirmation could be given by
        // somebody who never read it.
        if (!next) setChecked(false);
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 />
          Clear this attempt
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Check {progress.channelTitle} on YouTube first
          </AlertDialogTitle>
          <AlertDialogDescription>
            This upload stopped partway. Framecast cannot tell whether YouTube kept
            what it received, and you are the only one who can look.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-sm">
          <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
            <a
              href={`https://studio.youtube.com/channel/${progress.youtubeChannelId}/videos`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
              Open {progress.channelTitle} in YouTube Studio
            </a>
          </Button>

          <ul className="space-y-2">
            <li>
              <strong>If the video is there</strong> — even as a draft, or still
              processing — do not clear this. Publishing again would upload a
              second copy, and neither copy can be deleted from Framecast. Delete
              or hide the one on YouTube from Studio instead.
            </li>
            <li>
              <strong>If it is not there</strong> — clearing this record lets you
              publish the video again. Nothing is sent to YouTube by clearing it.
            </li>
          </ul>

          <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <Label
              htmlFor={confirmId}
              className="flex flex-col items-start gap-0.5 font-normal"
            >
              <span className="font-medium">
                I checked {progress.channelTitle}
              </span>
              <span className="text-muted-foreground text-xs">
                This video is not on the channel, in any state.
              </span>
            </Label>
            <Switch
              id={confirmId}
              checked={checked}
              onCheckedChange={setChecked}
              className="mt-0.5"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!checked || clearing}
            onClick={(event) => {
              // The dialog closes itself on action by default; it has to stay
              // open while the server answers, and stay open with a toast on
              // it if the server refuses.
              event.preventDefault();
              void onConfirm();
            }}
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Clear the record
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What the video page shows in place of a publish button when a publish is
 * running, or has stopped running without finishing.
 *
 * Both defects meet here, because they are the same fact seen at two moments.
 * While the lease is live this is a progress bar: server-written bytes, polled,
 * with the clock smoothed between polls — and it survives the tab being closed,
 * because none of it lives in this component. Once the lease has lapsed the
 * exact same row is a stalled upload, and the panel says so in the only terms
 * that are true: the process is gone, nothing will retry it, and here is what
 * you can do about it after you have looked at your channel.
 *
 * Rendered *instead of* `PublishVideoButton` (see video-header.tsx). A publish
 * button beside a stuck row would just produce "This video is already being
 * published" on every click, which is what the operator spent two hours
 * discovering.
 */
export function PublishAttemptPanel({
  videoId,
  videoTitle,
  initialProgress,
}: {
  videoId: string;
  /** Named in the dialog so the operator knows what to search Studio for. */
  videoTitle: string;
  /** Read on the server when the page rendered, so the panel is correct before
   *  a single poll — and correct with JavaScript disabled entirely. */
  initialProgress: PublishProgress;
}) {
  const { data: progress, dataUpdatedAt } = useQuery({
    queryKey: ["publish-progress", videoId],
    queryFn: async () => {
      const result = await getPublishProgressAction(videoId);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    initialData: initialProgress,
    // Only while something is actually moving. A stalled or failed attempt is
    // a settled fact — polling it would be a request every five seconds, for
    // as long as the tab is open, to be told the same thing.
    refetchInterval: (query) =>
      query.state.data?.isLive ? PUBLISH_POLL_INTERVAL_MS : false,
  });

  // The row was cleared, or the publish finished, in another tab. Nothing to
  // draw; the page refresh that follows will put the real control back.
  if (!progress || progress.youtubeVideoId !== null) {
    return null;
  }

  if (progress.isLive) {
    return (
      <div className="w-full max-w-sm space-y-2 rounded-lg border p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Upload className="size-4" />
          Uploading to {progress.channelTitle}
        </p>
        <UploadProgressReadout progress={progress} dataUpdatedAt={dataUpdatedAt} />
        <p className="text-muted-foreground text-xs">
          This keeps going whether or not this page is open — it runs on the
          server. Come back any time.
        </p>
      </div>
    );
  }

  const stalled = progress.isStalled;

  return (
    <Alert variant="destructive" className="w-full max-w-sm">
      <CircleAlert />
      <AlertTitle>
        {stalled
          ? "This upload stopped without finishing"
          : "The last publish attempt failed"}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <div className="w-full space-y-2">
          {stalled ? (
            <p>
              Nothing has been heard from it
              {progress.silentForSeconds !== null
                ? ` for ${formatDuration(progress.silentForSeconds)}`
                : ""}
              . The process that was uploading is gone — a restart or a deploy
              partway through does exactly this. It will not resume on its own.
            </p>
          ) : (
            <p>{progress.error ?? "No reason was recorded."}</p>
          )}

          {/* How far it got, on a failure as much as on a stall: "it stopped at
            * 94%" and "it never sent a byte" are different situations, and the
            * second one cannot have left anything on the channel. */}
          <UploadProgressReadout progress={progress} dataUpdatedAt={dataUpdatedAt} />

          <p>
            Framecast will not retry this by itself. It cannot tell whether
            YouTube kept what it received, and a second upload would put a
            second copy of &ldquo;{videoTitle}&rdquo; on {progress.channelTitle}
            {" "}that could not be removed from here.
          </p>
        </div>

        {progress.canClear && (
          <ClearAttemptDialog videoId={videoId} progress={progress} />
        )}
      </AlertDescription>
    </Alert>
  );
}
