import { Library } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={Library}
        title="No projects yet"
        description="Projects group related videos together and can carry a default publishing channel."
        action={<CreateProjectDialog channels={channels} />}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Videos</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell>
              <p className="font-medium">{project.name}</p>
              {project.description && (
                <p className="text-muted-foreground truncate text-xs">
                  {project.description}
                </p>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={project.status === "ACTIVE" ? "outline" : "secondary"}>
                {project.status === "ACTIVE" ? "Active" : "Archived"}
              </Badge>
            </TableCell>
            <TableCell className="font-mono">{project._count.videos}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              <RelativeTime date={project.updatedAt} />
            </TableCell>
            <TableCell className="text-right">
              {project.status === "ACTIVE" && (
                <ArchiveProjectButton
                  projectId={project.id}
                  projectName={project.name}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
