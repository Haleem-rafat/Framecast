"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { CircleCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { approveScriptAction } from "@/actions/video.action";

export function ApproveScriptButton({
  videoId,
  canApprove,
}: {
  videoId: string;
  /** True only when status is DRAFT and the active version has non-empty content. */
  canApprove: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onApprove() {
    startTransition(async () => {
      const result = await approveScriptAction(videoId);

      if (!result.ok) {
        toast.error("Could not approve this script", {
          description: result.error.message,
        });
        return;
      }

      // Gate 1 — this is the moment the video becomes eligible for paid
      // downstream steps, so the confirmation has to be unambiguous.
      toast.success("Script approved", {
        description: "The video moved to QUEUED and is ready for the next stage.",
      });
      router.refresh();
    });
  }

  return (
    <Button onClick={onApprove} disabled={!canApprove || isPending} size="lg">
      {isPending ? <Loader2 className="animate-spin" /> : <CircleCheck />}
      Approve script
    </Button>
  );
}
