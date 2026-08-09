import type { projectService } from "@/services/project.service";

export type ProjectWithVideoCount = Awaited<
  ReturnType<typeof projectService.list>
>[number];
