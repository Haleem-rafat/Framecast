"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
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
import { deleteVideosAction } from "@/actions/video.action";
import type { VideoListItem } from "@/features/videos/types";

/**
 * Statuses a render worker can be holding a lease on. `videoService.removeMany`
 * skips exactly these when the lease is still live (`NOT { status in […],
 * leaseExpiresAt > now }`) — the same guard `DeleteVideoButton` inherits from
 * `remove`, which refuses outright rather than skipping.
 *
 * The list query does not select `leaseExpiresAt`, so this can only warn on
 * status: a `RENDERING` video whose worker died has a lapsed lease and *will*
 * delete. Over-warning is the safe direction — the confirmation says these
 * "may be skipped", and the toast afterwards reports what actually happened.
 */
const BUSY_STATUSES: VideoListItem["status"][] = ["GENERATING", "RENDERING"];

/**
 * Delete every selected video.
 *
 * One `deleteVideosAction` call, not a loop: the bulk path already exists in
 * the service as a single conditional `updateMany` scoped to
 * `{ id: { in: ids }, userId, deletedAt: null }`, so an id belonging to
 * somebody else matches nothing and is counted as skipped rather than deleted.
 * That is also where the busy-video guard lives, which is what keeps this
 * button from doing anything the per-row Delete on the detail page would
 * refuse to do.
 */
export function BulkDeleteVideosButton({
  videos,
  onDone,
}: {
  videos: VideoListItem[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const busy = videos.filter((video) => BUSY_STATUSES.includes(video.status));
  const published = videos.filter((video) => video.status === "PUBLISHED");

  function onConfirm() {
    startTransition(async () => {
      const result = await deleteVideosAction(videos.map((video) => video.id));

      if (!result.ok) {
        toast.error("Could not delete those videos", {
          description: result.error.message,
        });
        return;
      }

      const { deletedCount, skippedCount } = result.data;

      // Per-row outcomes. The service reports counts rather than reasons — it
      // skips on one predicate, so there is only one reason to give — but a
      // bare "deleted" on a batch that dropped three of them is the thing this
      // whole component is written to avoid.
      if (skippedCount > 0) {
        toast.warning(
          `${deletedCount} deleted, ${skippedCount} skipped — still being processed by the render worker`,
          {
            description:
              "Cancel them from the video's own page, then delete them again.",
          },
        );
      } else {
        toast.success(
          `${deletedCount} video${deletedCount === 1 ? "" : "s"} deleted`,
        );
      }

      onDone();
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {videos.length} video{videos.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* Scale, then consequence, then who gets left out — all before the
                confirm, because every one of these is something an operator
                only discovers afterwards otherwise. The wording matches the
                single-row dialog's: "permanently", because the soft delete is
                a storage detail and nothing in this UI brings a video back. */}
            This removes {videos.length === 1 ? "it" : "them"}, along with{" "}
            {videos.length === 1 ? "its" : "their"} scripts and renders, from
            Framecast permanently.
            {published.length > 0 && (
              <>
                {" "}
                {published.length} of {videos.length}{" "}
                {published.length === 1 ? "is" : "are"} published:{" "}
                {published.length === 1 ? "that one stays" : "those stay"} on
                YouTube, and taking{" "}
                {published.length === 1 ? "it" : "them"} down is a separate step
                in YouTube Studio.
              </>
            )}
            {busy.length > 0 && (
              <>
                {" "}
                {busy.length}{" "}
                {busy.length === 1 ? "is" : "are"} generating or rendering right
                now and may be skipped — a video cannot be deleted out from
                under the worker holding it.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete {videos.length}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
