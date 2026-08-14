import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { CreateVideoDialog } from "@/features/videos/components/create-video-dialog";
import { VideoStatusFilter } from "@/features/videos/components/video-status-filter";
import { VideoTable } from "@/features/videos/components/video-table";
import type { VideoStatus } from "@/generated/prisma/enums";
import { VideoStatus as VideoStatusValues } from "@/generated/prisma/enums";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Videos" };

const VALID_STATUSES = new Set<string>(Object.values(VideoStatusValues));

interface VideosPageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function VideosPage({ searchParams }: VideosPageProps) {
  const user = await requireUser();
  const { status } = await searchParams;
  const statusFilter = status && VALID_STATUSES.has(status) ? (status as VideoStatus) : undefined;

  // The status filter goes to Postgres rather than to `Array.filter` here:
  // `@@index([userId, status, deletedAt])` covers it exactly, so a narrowed
  // list reads only the matching rows instead of fetching the operator's
  // whole back catalogue and throwing most of it away.
  const [filtered, projects] = await Promise.all([
    videoService.list(user.id, statusFilter),
    projectService.list(user.id),
  ]);

  const activeProjects = projects
    .filter((project) => project.status === "ACTIVE")
    .map((project) => ({ id: project.id, name: project.name }));

  return (
    <>
      <PageHeader
        title="Videos"
        description="Every video across your projects, from draft to published."
        actions={<CreateVideoDialog projects={activeProjects} />}
      />

      <div className="flex justify-end">
        <VideoStatusFilter current={statusFilter ?? "ALL"} />
      </div>

      {/* Same reasoning as /logs: the status filter navigates and rebuilds this
       * table, and the reveal declines to arm a region the operator can see —
       * so filtering never costs them an animation they have to wait out. */}
      <Reveal>
        <VideoTable videos={filtered} hasFilter={Boolean(statusFilter)} />
      </Reveal>
    </>
  );
}
