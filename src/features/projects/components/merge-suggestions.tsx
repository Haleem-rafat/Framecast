"use client";

import { useState } from "react";
import { Merge, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MergeProjectsDialog } from "@/features/projects/components/merge-projects-dialog";
import { joinNames } from "@/features/projects/merge-copy";
import type { ProjectWithVideoCount } from "@/features/projects/types";
import type { MergeSuggestion } from "@/lib/project-merge";

/**
 * "These look like the same project" — offered above the table so the operator
 * does not have to find the duplicates themselves.
 *
 * This is the part that makes merging usable rather than merely possible. The
 * account this was built for has 39 projects; the table pages at 25 and clears
 * the selection when you page, so a flow that starts with "tick the sixteen
 * `job-<uuid>` rows" is a flow nobody completes. A card that has already found
 * them and asks for one confirmation is a different feature.
 *
 * Every card is a proposal, never an action. It opens the same dialog the bulk
 * bar opens, with the same editable survivor, the same editable name and the
 * same server-computed refusals — the suggestion only decides what is
 * pre-filled. Dismissing one hides it for the session, because a group the
 * operator has decided to keep should not keep asking; there is no stored
 * "dismissed" state, so a reload brings it back rather than silently losing
 * something they will want later.
 */
export function MergeSuggestions({
  suggestions,
  projects,
  channels,
}: {
  suggestions: MergeSuggestion[];
  projects: ProjectWithVideoCount[];
  channels: { id: string; title: string }[];
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);

  const visible = suggestions.filter(
    (suggestion) => !dismissed.includes(suggestion.targetId),
  );

  if (visible.length === 0) {
    return null;
  }

  const byId = new Map(projects.map((project) => [project.id, project]));

  return (
    <div className="space-y-3">
      {visible.map((suggestion) => {
        const members = [suggestion.targetId, ...suggestion.sourceIds]
          .map((id) => byId.get(id))
          .filter((project): project is ProjectWithVideoCount => project !== undefined);

        // The page's projects and the suggestion were read in the same request,
        // so this only bites if something changed underneath — in which case
        // saying nothing beats offering a merge over rows that are not there.
        if (members.length !== suggestion.sourceIds.length + 1) {
          return null;
        }

        const candidates = members.map((project) => ({
          id: project.id,
          name: project.name,
          channelId: project.channelId,
          status: project.status,
        }));

        return (
          <Card key={suggestion.targetId} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="text-muted-foreground size-4 shrink-0" />
                {suggestion.kind === "duplicate-name"
                  ? `${members.length} projects called "${suggestion.name}"`
                  : `${members.length} one-click projects`}
              </CardTitle>
              <CardDescription>
                {suggestion.kind === "duplicate-name"
                  ? "Same name, separate rows — most likely one project that got " +
                    "created more than once."
                  : "Each was created automatically for a single one-click run and " +
                    "named after it. They hold " +
                    (suggestion.videoCount === 1
                      ? "1 video"
                      : `${suggestion.videoCount} videos`) +
                    " between them."}
              </CardDescription>
              <CardAction>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dismiss this suggestion"
                  onClick={() =>
                    setDismissed((current) => [...current, suggestion.targetId])
                  }
                >
                  <X />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-sm">
                {joinNames(members.map((project) => `"${project.name}"`))}
              </p>
              <MergeProjectsDialog
                projects={candidates}
                channels={channels}
                defaultTargetId={suggestion.targetId}
                defaultName={suggestion.name}
                trigger={
                  <Button variant="outline" size="sm">
                    <Merge />
                    Review merge
                  </Button>
                }
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
