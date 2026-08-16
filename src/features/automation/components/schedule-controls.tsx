"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteScheduleAction,
  pauseScheduleAction,
  resumeScheduleAction,
} from "@/actions/schedule.action";
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
 * Pause, resume and delete.
 *
 * Pause deliberately has no confirmation step. It is the button an operator
 * reaches for when they want the spending to stop *now* — "are you sure?" in
 * front of it would be a dialog between them and the thing they are trying to
 * halt, and pausing is completely reversible anyway. Delete gets the dialog,
 * because that one is not.
 *
 * `router.refresh()` after every success re-reads the server components above
 * this, so the status badge, the next-run time and the history all change in
 * the same paint. Pausing has to *look* immediate as well as be immediate:
 * this is the button an operator presses when they think money is being spent
 * wrongly, and a stale "Active" badge left on screen afterwards would read as a
 * button that did nothing.
 */
export function ScheduleControls({
  scheduleId,
  scheduleName,
  status,
  /** True while a worker holds this schedule. Pausing cannot recall a run that
   *  has already started, and saying so up front is better than an operator
   *  discovering it when a video appears afterwards. */
  runInFlight = false,
  /** Compact variant for the list, where the schedule's name is already on
   *  screen beside the buttons. */
  compact = false,
  /**
   * False for a cadence a series owns. `ScheduleService.remove` refuses those —
   * deleting one would leave a show with a recipe and no queue — so the button
   * is not offered rather than offered and refused. Pause and resume stay,
   * because those mean exactly the same thing whoever presses them.
   */
  deletable = true,
}: {
  scheduleId: string;
  scheduleName: string;
  status: "ACTIVE" | "PAUSED";
  runInFlight?: boolean;
  compact?: boolean;
  deletable?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function toggle(): void {
    startTransition(async () => {
      const response =
        status === "ACTIVE"
          ? await pauseScheduleAction(scheduleId)
          : await resumeScheduleAction(scheduleId);

      if (!response.ok) {
        toast.error(
          status === "ACTIVE"
            ? "Could not pause that schedule"
            : "Could not resume that schedule",
          { description: response.error.message },
        );
        return;
      }

      toast.success(
        status === "ACTIVE" ? `Paused ${scheduleName}` : `Resumed ${scheduleName}`,
        {
          description:
            status === "ACTIVE"
              ? runInFlight
                ? "No further runs will start. The run already under way will finish — it has already been billed for a script."
                : "No further runs will start until you resume it."
              : "It picks up from the next occurrence, not from the ones it missed while paused.",
        },
      );

      router.refresh();
    });
  }

  function onDelete(): void {
    startTransition(async () => {
      const response = await deleteScheduleAction(scheduleId);

      if (!response.ok) {
        toast.error("Could not delete that schedule", {
          description: response.error.message,
        });
        return;
      }

      toast.success(`Deleted ${scheduleName}`);
      router.push("/automation/schedules");
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

      {!compact && deletable && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm" disabled={isPending}>
              <Trash2 />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {scheduleName}?</AlertDialogTitle>
              <AlertDialogDescription>
                The schedule stops immediately and disappears from this list.
                Videos it already produced are untouched — this only removes the
                instruction to keep producing them.
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
