"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import { archiveProjectAction } from "@/actions/project.action";
import type { ProjectWithVideoCount } from "@/features/projects/types";

/**
 * Archive every selected project.
 *
 * Archive and not delete, deliberately. `deleteProjectAction` cascades: it
 * soft-deletes the project *and every video in it*, and refuses outright if
 * any of those videos is mid-render (see `ProjectService.remove`). One project
 * at a time that is a confirmable trade — `DeleteProjectButton` names the
 * project, counts its videos and says which are published before it arms.
 * Multiplied across a checked page it is a control whose blast radius nobody
 * can hold in their head: "delete 6 projects" could be 200 videos, and none of
 * it comes back. So bulk stops at archiving, which `UnarchiveProjectButton`
 * undoes one row at a time and which touches no video rows at all.
 *
 * No bulk Restore beside it, either. The two are not symmetric jobs: archiving
 * in bulk is a real one — clearing a season's worth of finished projects out
 * of the picker in one pass — while restoring is something you do to one named
 * project because you have a video to put in it, and that is a single click on
 * its row with no dialog to sit through. Adding it would put two controls in
 * this bar that each silently skip the rows in the wrong state, which is a
 * worse thing to hand someone with a mixed selection than one control that
 * does.
 *
 * A loop of `archiveProjectAction` rather than a new bulk service method:
 * `ProjectService.archive` is a conditional `updateMany` scoped to
 * `{ id, userId, deletedAt: null }`, so each call carries exactly the same
 * ownership guard the single-row button gets, and a project belonging to
 * anyone else comes back `NotFoundError` instead of being archived. Six
 * sequential round trips is not a cost worth a new query for.
 */
export function BulkArchiveProjectsButton({
  projects,
  onDone,
}: {
  projects: ProjectWithVideoCount[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Archived projects keep no Archive button of their own in the row, so the
  // bulk action must not invent one for them either.
  const archivable = projects.filter((project) => project.status === "ACTIVE");
  const alreadyArchived = projects.length - archivable.length;
  const videoCount = archivable.reduce(
    (total, project) => total + project._count.videos,
    0,
  );

  function onConfirm() {
    startTransition(async () => {
      const outcomes = await Promise.all(
        archivable.map(async (project) => ({
          project,
          result: await archiveProjectAction(project.id),
        })),
      );

      const failed = outcomes.filter((one) => !one.result.ok);
      const archived = outcomes.length - failed.length;

      // Per-row outcomes, not "done": a partial result the operator is not
      // told about is a partial result they will act on as if it were total.
      if (failed.length > 0) {
        const firstError = failed[0]!.result;
        toast.error(
          `${archived} archived, ${failed.length} failed`,
          {
            description: firstError.ok
              ? undefined
              : `${failed.map((one) => one.project.name).join(", ")} — ${firstError.error.message}`,
          },
        );
      } else if (alreadyArchived > 0) {
        toast.success(
          `${archived} archived, ${alreadyArchived} skipped — already archived`,
        );
      } else {
        toast.success(`${archived} project${archived === 1 ? "" : "s"} archived`);
      }

      onDone();
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          // Every selected project is already archived: there is nothing this
          // could do, and a control that opens a dialog to report that is
          // worse than one that is plainly unavailable.
          disabled={isPending || archivable.length === 0}
        >
          {isPending ? <Loader2 className="animate-spin" /> : <Archive />}
          Archive
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive {archivable.length} project
            {archivable.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* Scale and consequence, before the click. The video count is the
                part an operator misjudges: archiving reads as harmless until
                you learn it took 40 videos out of the new-video picker. */}
            They stay visible for reference and keep their{" "}
            {videoCount === 1 ? "1 video" : `${videoCount} videos`}, which are
            not deleted, not unpublished and not removed from YouTube. New
            videos can no longer be created under them.
            {alreadyArchived > 0 && (
              <>
                {" "}
                {alreadyArchived} of the {projects.length} selected{" "}
                {alreadyArchived === 1 ? "is" : "are"} already archived and will
                be skipped.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            Archive {archivable.length}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
