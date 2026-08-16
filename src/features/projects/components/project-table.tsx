"use client";

import { useMemo } from "react";
import { Library, Pencil } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArchiveProjectButton } from "@/features/projects/components/archive-project-button";
import { BulkArchiveProjectsButton } from "@/features/projects/components/bulk-archive-projects-button";
import { DeleteProjectButton } from "@/features/projects/components/delete-project-button";
import { ProjectDialog } from "@/features/projects/components/project-dialog";
import { UnarchiveProjectButton } from "@/features/projects/components/unarchive-project-button";
import type { ProjectWithVideoCount } from "@/features/projects/types";

export function ProjectTable({
  projects,
  channels,
}: {
  projects: ProjectWithVideoCount[];
  channels: { id: string; title: string }[];
}) {
  // `projectService.list` selects `channelId` but not the channel's title, and
  // an id in a cell tells the operator nothing. The page already fetched the
  // channel list for the dialog's picker, so the join happens here rather than
  // costing the query an `include` every table in the app would then carry.
  const channelTitles = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.title])),
    [channels],
  );

  const columns = useMemo<DataTableColumn<ProjectWithVideoCount>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        // Capped and truncated for the same reason the video table's title is: a
        // table cell sizes to its content, so one long name widens the column
        // past the viewport and puts the whole table into horizontal scroll. The
        // `truncate` on the description did nothing on its own — truncation
        // needs a bound, and nothing supplied one.
        cell: (project) => (
          <div className="max-w-[22rem]" title={project.name}>
            <p className="truncate font-medium">{project.name}</p>
            {project.description && (
              <p className="text-muted-foreground truncate text-xs">
                {project.description}
              </p>
            )}
          </div>
        ),
        sortValue: (project) => project.name,
        filterValue: (project) => `${project.name} ${project.description ?? ""}`,
        alwaysVisible: true,
      },
      {
        id: "channel",
        header: "Channel",
        /**
         * On screen because it is the field this table exists to let people
         * fix. A project with no default channel publishes nowhere, and until
         * the Edit button beside this column there was no way to give it one —
         * but the state was also invisible, so nobody could see which project
         * was the problem.
         */
        cell: (project) =>
          project.channelId ? (
            (channelTitles.get(project.channelId) ?? "Disconnected channel")
          ) : (
            <span className="text-muted-foreground">None</span>
          ),
        sortValue: (project) =>
          project.channelId
            ? (channelTitles.get(project.channelId) ?? "")
            : null,
        filterValue: (project) =>
          project.channelId ? (channelTitles.get(project.channelId) ?? "") : "",
        cellClassName: "text-sm",
      },
      {
        id: "status",
        header: "Status",
        cell: (project) => (
          <Badge variant={project.status === "ACTIVE" ? "outline" : "secondary"}>
            {project.status === "ACTIVE" ? "Active" : "Archived"}
          </Badge>
        ),
        // Only two states, so ordering by the visible word is unambiguous —
        // and it puts Active above Archived, which is the useful way round.
        sortValue: (project) => statusLabel(project.status),
        filterValue: (project) => statusLabel(project.status),
      },
      {
        id: "videos",
        header: "Videos",
        cell: (project) => project._count.videos,
        sortValue: (project) => project._count.videos,
        // Biggest project first: "which of these is actually in use" is the
        // reason to sort a count at all.
        firstSortDirection: "desc",
        cellClassName: "font-mono",
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: (project) => <RelativeTime date={project.updatedAt} />,
        sortValue: (project) => project.updatedAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "actions",
        header: "Actions",
        /**
         * Edit stays on archived projects: an archived project can still be
         * renamed or pointed at a different channel, and it is the row the
         * operator is most likely to be repairing. Archive does not — there is
         * nothing left to archive, and an empty slot says so more quietly than
         * a disabled control would.
         *
         * Restore and Delete are the archived row's other half, and Delete is
         * there and nowhere else on purpose. It is the only irreversible
         * control in this table and it takes every video in the project with
         * it; requiring the project to be archived first makes that a
         * deliberate two-step rather than a neighbour of Edit. Archiving costs
         * nothing now that Restore undoes it, so nothing is trapped behind the
         * extra step. See `DeleteProjectButton`.
         */
        cell: (project) => (
          <div className="flex items-center justify-end gap-1">
            <ProjectDialog
              channels={channels}
              project={{
                id: project.id,
                name: project.name,
                description: project.description,
                channelId: project.channelId,
                // What makes the channel picker in that dialog say out loud
                // that changing it moves shows as well. Zero — the common case
                // — draws nothing at all.
                seriesCount: project._count.series,
              }}
              trigger={
                <Button variant="ghost" size="sm">
                  <Pencil />
                  Edit
                </Button>
              }
            />
            {project.status === "ACTIVE" ? (
              <ArchiveProjectButton
                projectId={project.id}
                projectName={project.name}
                videoCount={project._count.videos}
              />
            ) : (
              <>
                <UnarchiveProjectButton
                  projectId={project.id}
                  projectName={project.name}
                />
                <DeleteProjectButton
                  projectId={project.id}
                  projectName={project.name}
                />
              </>
            )}
          </div>
        ),
        align: "right",
        alwaysVisible: true,
      },
    ],
    [channels, channelTitles],
  );

  return (
    <DataTable
      rows={projects}
      columns={columns}
      getRowId={(project) => project.id}
      caption="Projects"
      searchPlaceholder="Search projects"
      pageSize={25}
      selection={{
        rowLabel: (project) => project.name,
        actions: ({ rows, clear }) => (
          <BulkArchiveProjectsButton projects={rows} onDone={clear} />
        ),
      }}
      empty={
        <EmptyState
          icon={Library}
          title="No projects yet"
          description="Projects group related videos together and can carry a default publishing channel."
          action={<ProjectDialog channels={channels} />}
        />
      }
    />
  );
}

function statusLabel(status: ProjectWithVideoCount["status"]) {
  return status === "ACTIVE" ? "Active" : "Archived";
}
