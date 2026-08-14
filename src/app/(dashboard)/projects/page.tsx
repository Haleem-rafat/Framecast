import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { CreateProjectDialog } from "@/features/projects/components/create-project-dialog";
import { ProjectTable } from "@/features/projects/components/project-table";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const user = await requireUser();

  const [projects, channels] = await Promise.all([
    projectService.list(user.id),
    channelService.list(user.id),
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
            <CreateProjectDialog channels={channelOptions} />
          ) : undefined
        }
      />

      <Reveal>
        <ProjectTable projects={projects} channels={channelOptions} />
      </Reveal>
    </>
  );
}
