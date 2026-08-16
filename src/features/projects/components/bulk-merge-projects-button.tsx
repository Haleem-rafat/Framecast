"use client";

import { Merge } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MergeProjectsDialog } from "@/features/projects/components/merge-projects-dialog";
import type { ProjectWithVideoCount } from "@/features/projects/types";
import { chooseMergeTarget, suggestedTargetName } from "@/lib/project-merge";

/**
 * Merge every selected project into one, from the table's bulk bar.
 *
 * The hand-picked half of the feature. `MergeSuggestions` above the table is
 * the half that scales — nobody is ticking sixteen `job-<uuid>` rows across
 * two pages of a 25-row table — but a suggestion can only offer the groups a
 * rule recognises, and "these two are the same thing and I know it" is not
 * always one of them. Two ticks and this button is that case.
 *
 * Unlike `BulkArchiveProjectsButton` next to it, this is not a loop over a
 * single-row action: a merge is one transaction by definition, and half of one
 * is a state nothing else in the app knows how to read. It hands the whole
 * selection to one call.
 *
 * The survivor is pre-picked with the same rule the suggestions use, and the
 * dialog lets it be changed — a default that is right most of the time beats
 * an empty picker, and a default nobody can override is how the wrong project
 * survives.
 */
export function BulkMergeProjectsButton({
  projects,
  channels,
  onDone,
}: {
  projects: ProjectWithVideoCount[];
  channels: { id: string; title: string }[];
  onDone: () => void;
}) {
  const candidates = projects.map((project) => ({
    id: project.id,
    name: project.name,
    channelId: project.channelId,
    status: project.status,
    videoCount: project._count.videos,
    createdAt: project.createdAt,
  }));

  const target = chooseMergeTarget(candidates);

  // One row selected is not a merge, and a selection with no active project in
  // it has no legal survivor — `ProjectService.merge` refuses an archived
  // target outright. Either way the control is plainly unavailable rather than
  // opening a dialog to say so.
  if (projects.length < 2 || !target) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Merge />
        Merge
      </Button>
    );
  }

  return (
    <MergeProjectsDialog
      projects={candidates}
      channels={channels}
      defaultTargetId={target.id}
      defaultName={suggestedTargetName(target, candidates)}
      onDone={onDone}
      trigger={
        <Button variant="outline" size="sm">
          <Merge />
          Merge
        </Button>
      }
    />
  );
}
