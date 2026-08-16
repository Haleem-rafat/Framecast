import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { ProjectDialog } from "@/features/projects/components/project-dialog";
import { ProjectTable } from "@/features/projects/components/project-table";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const user = await requireUser();

  const [projects, channels, mergeSuggestions] = await Promise.all([
    projectService.list(user.id),
    channelService.list(user.id),
    // Read here rather than in the table so the duplicate groups are as fresh
    // as the rows they describe, and so a merge's `revalidatePath("/projects")`
    // takes the acted-on card away with it.
    projectService.mergeSuggestions(user.id),
  ]);

  const channelOptions = channels.map((channel) => ({
    id: channel.id,
    title: channel.title,
  }));

  return (
    <>
      <PageHeader
        title="Projects"
        description="Group videos together and set a default publishing channel."
        actions={
          projects.length > 0 ? (
            <ProjectDialog channels={channelOptions} />
          ) : undefined
        }
      />

      <Reveal>
        <ProjectTable
          projects={projects}
          channels={channelOptions}
          mergeSuggestions={mergeSuggestions}
        />
      </Reveal>
    </>
  );
}
