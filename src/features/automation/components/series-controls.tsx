"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteSeriesAction,
  generateFromSeriesAction,
  pauseSeriesAction,
  resumeSeriesAction,
} from "@/actions/series.action";
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
 * Make one now, pause, resume, delete.
 *
 * "Make one now" is the button this whole feature is for: one press applies the
 * script style, the format, the project, the channel's brand and the stored
 * prompt answers, and takes the next topic off the queue — the operator answers
 * nothing. It is the primary action here because a show the operator just
 * configured is a show they want to see produce something before next Monday.
 *
 * It has no confirmation dialog and deliberately so, but it *is* honest about
 * what it spends: the caption under it on the detail page says a script is
 * billed the moment it is pressed. A dialog in front of it would be a dialog in
 * front of the feature's one-click promise; a sentence beside it is not.
 *
 * Pause has no confirmation either, for the reason `ScheduleControls` gives:
 * it is the button an operator reaches for when they want spending to stop
 * *now*, and it is completely reversible. Delete gets the dialog, because that
 * one is not.
 */
export function SeriesControls({
  seriesId,
  seriesName,
  status,
  queuedTopicCount,
  /** True while a worker holds this show's schedule. Pausing cannot recall a
   *  run already under way, and saying so beats an operator discovering it when
   *  a video appears afterwards. */
  runInFlight = false,
  /** Compact variant for the list, where the show's name is already on screen
   *  beside the buttons and there is no room for a delete. */
  compact = false,
}: {
  seriesId: string;
  seriesName: string;
  status: "ACTIVE" | "PAUSED";
  queuedTopicCount: number;
  runInFlight?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onGenerate(): void {
    startTransition(async () => {
      const response = await generateFromSeriesAction(seriesId);

      if (!response.ok) {
        toast.error(`Could not make a video from ${seriesName}`, {
          description: response.error.message,
        });
        return;
      }

      toast.success(`Making "${response.data.topic}"`, {
        description:
          "Written in this series' script style, in its format, on its channel — " +
          "nothing was re-asked. It stops at a finished video; publishing is " +
          "still yours.",
      });

      // The progress view of the guided flow, which is the same run: a render
      // takes minutes on a worker, and this is the page built to be left and
      // come back to.
      router.push(`/automation/generate?video=${response.data.videoId}`);
      router.refresh();
    });
  }

  function toggle(): void {
    startTransition(async () => {
      const response =
        status === "ACTIVE"
          ? await pauseSeriesAction(seriesId)
          : await resumeSeriesAction(seriesId);

      if (!response.ok) {
        toast.error(
          status === "ACTIVE"
            ? `Could not pause ${seriesName}`
            : `Could not resume ${seriesName}`,
          { description: response.error.message },
        );
        return;
      }

      toast.success(
        status === "ACTIVE" ? `Paused ${seriesName}` : `Resumed ${seriesName}`,
        {
          description:
            status === "ACTIVE"
              ? runInFlight
                ? "No further episodes will start. The one already under way will finish — it has already been billed for a script."
                : "No further episodes will start until you resume it."
              : "It picks up from the next occurrence, not from the ones it missed while paused.",
        },
      );

      router.refresh();
    });
  }

  function onDelete(): void {
    startTransition(async () => {
      const response = await deleteSeriesAction(seriesId);

      if (!response.ok) {
        toast.error(`Could not delete ${seriesName}`, {
          description: response.error.message,
        });
        return;
      }

      toast.success(`Deleted ${seriesName}`);
      router.push("/automation");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        size={compact ? "sm" : "default"}
        onClick={onGenerate}
        // An empty queue is a refusal rather than a prompt to invent a subject,
        // so the button says so before it is pressed instead of after.
        disabled={isPending || queuedTopicCount === 0}
        title={
          queuedTopicCount === 0
            ? "Add a topic first — nothing here invents a subject."
            : undefined
        }
      >
        {isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
        Make one now
      </Button>

      <Button
        type="button"
        variant="outline"
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
              <AlertDialogTitle>Delete {seriesName}?</AlertDialogTitle>
              <AlertDialogDescription>
                The series and its cadence stop immediately. Videos it already
                made are untouched — this only removes the instruction to keep
                making them.
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
