"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { deleteVideoAction } from "@/actions/video.action";
import type { VideoStatus } from "@/generated/prisma/enums";

/**
 * Deleting here removes the video from Framecast. It is a soft delete — the
 * row is retained with `deletedAt` set, the same convention every other
 * "delete" in this app follows — but the operator has no way to bring it back
 * from the UI, so the confirmation says "permanently" rather than implying an
 * undo that does not exist.
 */
export function DeleteVideoButton({
  videoId,
  title,
  status,
  redirectToList = false,
}: {
  videoId: string;
  title: string;
  status: VideoStatus;
  /** Set on the detail page, where staying put would leave the operator
   *  looking at a video that no longer exists. */
  redirectToList?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      const result = await deleteVideoAction(videoId);

      if (!result.ok) {
        // videoService.remove refuses while a worker holds the lease, and its
        // message already explains that — showing it verbatim beats a generic
        // "could not delete".
        toast.error("Could not delete this video", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Deleted ${title}`);

      if (redirectToList) {
        router.push("/videos");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {title}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the video, its script and its render from Framecast
            permanently.
            {status === "PUBLISHED" && (
              <>
                {" "}
                It stays on YouTube — deleting it there is a separate step in
                YouTube Studio.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
