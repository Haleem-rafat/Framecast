"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ArchiveRestore, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { unarchiveProjectAction } from "@/actions/project.action";

/**
 * The way back from Archive, on archived rows only.
 *
 * No confirmation dialog, unlike its counterpart. Archiving is worth
 * confirming because it quietly withdraws a project from the new-video picker;
 * restoring only puts it back, touches no video rows, and is undone by the
 * Archive button that reappears the instant this one succeeds. A dialog asking
 * "restore this project?" would be a click charged for nothing.
 */
export function UnarchiveProjectButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const result = await unarchiveProjectAction(projectId);

      if (!result.ok) {
        toast.error("Could not restore that project", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Restored ${projectName}`, {
        description: "New videos can be created under it again.",
      });
      router.refresh();
    });
  }

  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={isPending}>
      {isPending ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
      Restore
    </Button>
  );
}
