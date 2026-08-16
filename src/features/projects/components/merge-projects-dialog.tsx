"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CircleCheck, Loader2, Merge, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/shared/form-field";
import { Input } from "@/components/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/shared/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  mergeProjectsAction,
  projectMergeImpactAction,
} from "@/actions/project.action";
import {
  describeChannelGain,
  describeMerge,
  describeMergeRefusal,
} from "@/features/projects/merge-copy";
import type { MergeImpact } from "@/services/project.service";

/** The minimum a candidate row has to supply for the target picker. */
export interface MergeCandidateProject {
  id: string;
  name: string;
  channelId: string | null;
  status: "ACTIVE" | "ARCHIVED";
}

interface MergeProjectsDialogProps {
  /**
   * Every project in play — the survivor is picked from this list, and
   * everything else in it is dissolved. Two or more, or the dialog has nothing
   * to offer.
   */
  projects: MergeCandidateProject[];
  channels: { id: string; title: string }[];
  /** Which project starts out as the survivor. */
  defaultTargetId: string;
  /** What the survivor starts out called. See `suggestedTargetName`. */
  defaultName?: string;
  trigger: ReactNode;
  /** Called after a merge lands, so a bulk selection can clear itself. */
  onDone?: () => void;
}

/**
 * Merge several projects into one.
 *
 * The two things this dialog is for, in order of how badly they are needed:
 *
 *  1. **Say which project survives, and let it be changed.** Everything else
 *     is deleted, so this is the only choice that matters and it is the first
 *     control. It is a picker rather than a fixed value because both callers
 *     arrive with a guess — the bulk bar has no idea which of the ticked rows
 *     the operator considers canonical, and a suggestion picked one by rule
 *     (see `chooseMergeTarget`).
 *
 *  2. **State the consequence before the click, in the server's own words.**
 *     `projectMergeImpactAction` is re-read on open *and* on every change of
 *     target, because the answer genuinely depends on which one survives: a
 *     merge that is refused with project A as the target can be perfectly
 *     legal with project B as the target, and the operator should discover
 *     that by flipping the picker rather than by submitting and reading a
 *     toast. The refusals rendered here are the same strings
 *     `ProjectService.merge` throws, so the two cannot drift.
 *
 * The name field is the third control and the reason it exists is narrow: the
 * survivor is chosen for its channel, which can easily be a project still
 * called `job-4f2c…`. Renaming it in the same transaction is the difference
 * between a merged project the operator recognises and one they have to go and
 * fix afterwards.
 */
export function MergeProjectsDialog({
  projects,
  channels,
  defaultTargetId,
  defaultName,
  trigger,
  onDone,
}: MergeProjectsDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState(defaultTargetId);
  const [name, setName] = useState(defaultName ?? "");
  const [impact, setImpact] = useState<MergeImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const sourceIds = projects
    .map((project) => project.id)
    .filter((id) => id !== targetId);

  const loadImpact = useCallback(
    async (nextTargetId: string, nextSourceIds: string[]) => {
      setImpact(null);
      setImpactError(null);

      if (nextSourceIds.length === 0) {
        setImpactError("Select at least two projects to merge.");
        return;
      }

      const result = await projectMergeImpactAction({
        targetId: nextTargetId,
        sourceIds: nextSourceIds,
      });

      if (result.ok) {
        setImpact(result.data);
      } else {
        setImpactError(result.error.message);
      }
    },
    [],
  );

  // Re-read whenever the dialog is open and the survivor changes — including
  // the open itself, which is what makes the counts current rather than
  // whatever they were when the page was rendered.
  useEffect(() => {
    if (!open) return;

    void loadImpact(targetId, sourceIds);
    // `sourceIds` is derived from `projects` and `targetId`; depending on the
    // array itself would re-fetch on every render, since it is rebuilt each
    // time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetId, projects, loadImpact]);

  function onOpenChange(next: boolean) {
    setOpen(next);

    // Reopening shows the suggestion again, not whatever was half-chosen and
    // abandoned last time.
    if (!next) {
      setTargetId(defaultTargetId);
      setName(defaultName ?? "");
      setImpact(null);
      setImpactError(null);
    }
  }

  async function onConfirm() {
    setIsPending(true);

    const result = await mergeProjectsAction({
      targetId,
      sourceIds,
      name: name.trim() || undefined,
    });

    setIsPending(false);

    if (!result.ok) {
      // The service refuses for reasons the pre-check may have missed — a
      // render that started while the dialog was open, a project someone else
      // deleted — and its message names them precisely.
      toast.error("Could not merge these projects", {
        description: result.error.message,
      });
      return;
    }

    const { mergedProjectCount, videoCount } = result.data;
    toast.success(
      `Merged ${mergedProjectCount} project${mergedProjectCount === 1 ? "" : "s"} into "${result.data.name}"`,
      {
        description:
          videoCount === 0
            ? undefined
            : `${videoCount} video${videoCount === 1 ? "" : "s"} moved.`,
      },
    );

    setOpen(false);
    onDone?.();
    router.refresh();
  }

  const refusal = impact ? describeMergeRefusal(impact) : null;
  const gain = impact ? describeChannelGain(impact) : null;
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > 80;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogTrigger asChild>{trigger}</ResponsiveDialogTrigger>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Merge {projects.length} projects
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            One project is kept. The rest are deleted and everything filed under
            them — videos, schedules and series — moves into the one you keep.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <FormField
            name="targetId"
            label="Keep this project"
            description="Its channel decides where every video moved into it publishes."
          >
            {(controlProps) => (
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger {...controlProps} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                      {" — "}
                      {project.channelId
                        ? (channels.find((channel) => channel.id === project.channelId)
                            ?.title ?? "disconnected channel")
                        : "no channel"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField
            name="name"
            label="Name"
            description="What the project you keep is called afterwards."
            error={nameTooLong ? "Name must be 80 characters or fewer" : undefined}
          >
            {(controlProps) => (
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={impact?.target.name ?? "Project name"}
                {...controlProps}
              />
            )}
          </FormField>

          <div className="text-muted-foreground text-sm">
            {impactError
              ? `Could not check what this would move — ${impactError}`
              : impact
                ? describeMerge(impact)
                : "Checking what this would move…"}
          </div>

          {/* A gain, not a warning, and drawn as one — but drawn, because it
              is still a change to where something uploads. */}
          {gain && (
            <Alert>
              <CircleCheck />
              <AlertDescription>{gain}</AlertDescription>
            </Alert>
          )}

          {refusal && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{refusal}</AlertDescription>
            </Alert>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button
            type="button"
            onClick={onConfirm}
            // Not armed until the consequence is on screen. Confirming during
            // the "Checking…" state is confirming a blank, and confirming past
            // a refusal is submitting something the server will reject anyway.
            disabled={isPending || !impact || refusal !== null || nameTooLong}
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Merge />}
            Merge {sourceIds.length} into 1
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
