"use client";

import { useMemo } from "react";
import { Library } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { ArchiveProjectButton } from "@/features/projects/components/archive-project-button";
import { CreateProjectDialog } from "@/features/projects/components/create-project-dialog";
import type { ProjectWithVideoCount } from "@/features/projects/types";

export function ProjectTable({
  projects,
  channels,
}: {
  projects: ProjectWithVideoCount[];
  channels: { id: string; title: string }[];
}) {
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
        // Archived projects keep the column but not the button — there is
        // nothing left to archive, and an empty cell says so more quietly
        // than a disabled control would.
        cell: (project) =>
          project.status === "ACTIVE" ? (
            <ArchiveProjectButton
              projectId={project.id}
              projectName={project.name}
            />
          ) : null,
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={projects}
      columns={columns}
      getRowId={(project) => project.id}
      caption="Projects"
      searchPlaceholder="Search projects"
      pageSize={25}
      empty={
        <EmptyState
          icon={Library}
          title="No projects yet"
          description="Projects group related videos together and can carry a default publishing channel."
          action={<CreateProjectDialog channels={channels} />}
        />
      }
    />
  );
}

function statusLabel(status: ProjectWithVideoCount["status"]) {
  return status === "ACTIVE" ? "Active" : "Archived";
}
