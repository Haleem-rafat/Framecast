"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteReleaseCadenceAction,
  pauseReleaseCadenceAction,
  resumeReleaseCadenceAction,
} from "@/actions/release.action";
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

/**
 * Pause, resume and delete a channel's drip.
 *
 * Modelled on `ScheduleControls` down to the missing confirmation on Pause, and
 * the reason is sharper here. Pause is what an operator reaches for when clips
 * are going out that should not be, and a publish cannot be undone from this
 * app — every second between the click and the effect is a second in which
 * another one could go up. A dialog in front of that button would be a dialog
 * between the operator and the thing they are trying to stop. Delete keeps its
 * dialog, because that one throws the history away.
 *
 * `router.refresh()` after every success re-reads the server components above
 * this, so the badge, the next-release time and the queue all change in the
 * same paint.
 */
export function ReleaseCadenceControls({
  cadenceId,
  channelTitle,
  status,
  /** True while a worker holds this cadence. Pausing cannot recall an upload
   *  already in flight, and saying so up front is better than the operator
   *  discovering it when a clip appears on the channel afterwards. */
  releaseInFlight = false,
  /** Compact variant for the list, where the channel's name is already on
   *  screen beside the buttons. */
  compact = false,
}: {
  cadenceId: string;
  channelTitle: string;
  status: "ACTIVE" | "PAUSED";
  releaseInFlight?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function toggle(): void {
    startTransition(async () => {
      const response =
        status === "ACTIVE"
          ? await pauseReleaseCadenceAction(cadenceId)
          : await resumeReleaseCadenceAction(cadenceId);

      if (!response.ok) {
        toast.error(
          status === "ACTIVE"
            ? "Could not pause that cadence"
            : "Could not resume that cadence",
          { description: response.error.message },
        );
        return;
      }

      toast.success(
        status === "ACTIVE"
          ? `Paused the drip on ${channelTitle}`
          : `Resumed the drip on ${channelTitle}`,
        {
          description:
            status === "ACTIVE"
              ? releaseInFlight
                ? "No further clips will go out. The upload already under way will finish — its bytes are already with YouTube."
                : "No further clips will go out until you resume it. Nothing already published is affected."
              : "It picks up from the next slot, not from the ones it missed while paused.",
        },
      );

      router.refresh();
    });
  }

  function onDelete(): void {
    startTransition(async () => {
      const response = await deleteReleaseCadenceAction(cadenceId);

      if (!response.ok) {
        toast.error("Could not delete that cadence", {
          description: response.error.message,
        });
        return;
      }

      toast.success(`Deleted the drip on ${channelTitle}`);
      router.push("/automation/releases");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={status === "ACTIVE" ? "outline" : "default"}
        size={compact ? "sm" : "default"}
        onClick={toggle}
        disabled={isPending}
      >
        {isPending ? (
          <Loader2 className="animate-spin" />
        ) : status === "ACTIVE" ? (
          <Pause />
        ) : (
          <Play />
        )}
        {status === "ACTIVE" ? "Pause" : "Resume"}
      </Button>

      {!compact && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm" disabled={isPending}>
              <Trash2 />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete the drip on {channelTitle}?</AlertDialogTitle>
              <AlertDialogDescription>
                The drip stops immediately and its release history goes with it.
                Clips already published stay on YouTube, and the ones still
                banked stay banked — a new cadence on this channel would find
                exactly the same queue. If you only want it to stop, pause it
                instead and keep the history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete} disabled={isPending}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
