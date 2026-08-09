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

export function ArchiveProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
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
            Archived projects stay visible for reference but new videos
            should be created under an active project instead.
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
