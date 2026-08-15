"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  deleteProjectAction,
  projectDeletionImpactAction,
} from "@/actions/project.action";
import {
  describeDeletion,
  describeRefusal,
  type DeletionImpact,
} from "@/features/projects/deletion-copy";

/**
 * Delete a project and, with it, every video in it.
 *
 * Offered on archived rows only. `deleteProjectAction` is the one control in
 * this table with no way back — it soft-deletes the project *and* cascades
 * `deletedAt` onto all of its videos, and nothing in this UI un-deletes
 * either. Archiving is now reversible (see `UnarchiveProjectButton`), which
 * makes archive-then-delete a genuine two-step: the operator has already said
 * "I am done with this project", lived with it out of the way, and come back.
 * Putting Delete next to Edit on an everyday active row would make the
 * irreversible thing one mis-click from the reversible ones, for no workflow
 * that archiving first does not already serve.
 *
 * The confirmation refuses to guess. It fetches the real counts when it opens
 * (`projectDeletionImpactAction`) rather than reusing the row's cached video
 * count, because one of those numbers — how many videos the render worker is
 * actively holding — is the reason the service will refuse outright, and it is
 * only true as of the moment it is read. When it is non-zero the dialog says
 * so and the confirm button will not arm: a refusal explained before the click
 * beats the same refusal delivered as a toast after it.
 */
export function DeleteProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;

    // Re-read on every open, not once: the dialog may well be reopened
    // minutes later, after a render has started or finished.
    setImpact(null);
    setImpactError(null);

    void projectDeletionImpactAction(projectId).then((result) => {
      if (result.ok) {
        setImpact(result.data);
      } else {
        setImpactError(result.error.message);
      }
    });
  }

  function onConfirm() {
    startTransition(async () => {
      const result = await deleteProjectAction(projectId);

      if (!result.ok) {
        // `projectService.remove` refuses while the worker holds a lease and
        // says exactly which videos; that message beats anything generic. It
        // can still land here despite the pre-check above — a render can start
        // while the dialog is open.
        toast.error("Could not delete this project", {
          description: result.error.message,
        });
        return;
      }

      const { deletedVideoCount } = result.data;
      toast.success(`Deleted ${projectName}`, {
        description:
          deletedVideoCount === 0
            ? undefined
            : `${deletedVideoCount} video${deletedVideoCount === 1 ? "" : "s"} deleted with it.`,
      });
      setOpen(false);
      router.refresh();
    });
  }

  const refusal = impact ? describeRefusal(impact) : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {projectName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {/* The count, before the click: "delete project" reads as removing
                a folder, and it removes everything in it. See
                `describeDeletion` for the wording and why it is testable. */}
            {impactError
              ? `Could not check what this would delete — ${impactError}`
              : impact
                ? describeDeletion(impact)
                : "Checking what this would delete…"}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {refusal && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            // Not armed until the consequence is on screen: an operator who
            // confirms during the "Checking…" state has confirmed a blank.
            disabled={isPending || refusal !== null || !impact}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
