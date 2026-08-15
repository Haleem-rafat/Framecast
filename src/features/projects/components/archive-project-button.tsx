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

/**
 * Archive one project, with a confirmation that says what that actually costs.
 *
 * The count comes from the row rather than a fresh read: archiving touches no
 * video rows at all (see `ProjectService.archive`), so an off-by-one from a
 * stale page misstates nothing that the action then goes on to change. Delete
 * is the one that has to re-read — see `DeleteProjectButton`.
 */
export function ArchiveProjectButton({
  projectId,
  projectName,
  videoCount,
}: {
  projectId: string;
  projectName: string;
  videoCount: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      const result = await archiveProjectAction(projectId);

      if (!result.ok) {
        toast.error("Could not archive that project", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Archived ${projectName}`);
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Archive />}
          Archive
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {projectName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {/* What it does and what it costs, both of which the old copy left
                to be discovered: "new videos should be created elsewhere" read
                as advice, when it is actually enforced — an archived project
                disappears from the new-video picker. And the reassurance is
                only honest now that Restore exists. */}
            It stays in this list
            {videoCount > 0 && (
              <>
                {" "}
                with its {videoCount === 1 ? "1 video" : `${videoCount} videos`}
                , which are not deleted, not unpublished and not removed from
                YouTube
              </>
            )}
            , but new videos can no longer be created under it. Restore it from
            this table whenever you want it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
