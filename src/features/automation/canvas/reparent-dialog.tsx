"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { reparentAutomationAction } from "@/actions/canvas.action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AutomationEntry } from "@/services/automation-list.service";

/**
 * Confirming a move between channels.
 *
 * ## Why a dialog rather than just doing it
 *
 * Dropping a card is a cheap, easily-mistaken gesture, and this particular drop
 * changes where an automation's finished videos get uploaded. Those two facts
 * do not belong together without something in between. Every other canvas
 * action here is reversible in one click; this one moves a show to a different
 * audience.
 *
 * ## Why the project has to be asked about
 *
 * A channel can hold several projects, and which one an automation is filed
 * under decides where its videos live. The server cannot pick — both are
 * equally valid — and picking the first alphabetically would be a silent guess
 * about the operator's filing. So: no project on the target channel means the
 * move is refused with the reason; exactly one means it is named in the
 * sentence and confirmed with a button; more than one means a picker.
 *
 * That three-way split is why this is a component rather than a `confirm()`.
 */
export interface PendingMove {
  entry: AutomationEntry;
  channelId: string;
  channelTitle: string;
  projects: { id: string; name: string }[];
}

export function ReparentDialog({
  move,
  onDone,
}: {
  move: PendingMove;
  onDone: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(move.projects[0]?.id ?? "");

  const impossible = move.projects.length === 0;

  const confirm = () => {
    startTransition(async () => {
      const response = await reparentAutomationAction({
        kind: move.entry.kind === "SERIES" ? "SERIES" : "TOPIC_QUEUE",
        id: move.entry.id,
        channelId: move.channelId,
        projectId,
      });

      if (!response.ok) {
        toast.error("Could not move that", { description: response.error.message });
        return;
      }

      toast.success(`Moved to ${move.channelTitle}`);
      onDone();
      router.refresh();
    });
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onDone()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {impossible
              ? `${move.channelTitle} has no project to file this under`
              : `Move "${move.entry.name}" to ${move.channelTitle}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {impossible ? (
              <>
                An automation is filed in a project, and that project is what
                decides which channel its videos publish to. Create a project on{" "}
                {move.channelTitle} first, then move this.
              </>
            ) : (
              <>
                Every video this makes from now on will publish to{" "}
                {move.channelTitle} instead. Videos it has already made stay
                where they are.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Only when there is a decision to make. One project is named in the
            sentence above rather than presented as a choice of one. */}
        {move.projects.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="reparent-project">File it under</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="reparent-project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {move.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {move.projects.length === 1 && (
          <p className="text-muted-foreground text-sm">
            It will be filed under <strong>{move.projects[0].name}</strong>.
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {!impossible && (
            <AlertDialogAction
              onClick={(event) => {
                // The dialog closes itself on action; this one must stay open
                // until the server has answered, so a failure can be shown
                // against the thing that failed.
                event.preventDefault();
                confirm();
              }}
              disabled={isPending || !projectId}
            >
              {isPending ? "Moving…" : "Move it"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
