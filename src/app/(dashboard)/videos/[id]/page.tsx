import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PipelinePanel } from "@/features/videos/components/pipeline-panel";
import { ScriptPanel } from "@/features/videos/components/script-panel";
import { StatusEventsList } from "@/features/videos/components/status-events-list";
import { VersionHistory } from "@/features/videos/components/version-history";
import { VideoHeader } from "@/features/videos/components/video-header";
import { isAppError } from "@/lib/errors";
import { requireUser } from "@/server/session";
import { pipelineService } from "@/services/pipeline.service";
import { videoService } from "@/services/video.service";

export const metadata: Metadata = { title: "Video" };

interface VideoDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function VideoDetailPage({ params }: VideoDetailPageProps) {
  const user = await requireUser();
  const { id } = await params;

  const video = await videoService.get(user.id, id).catch((error: unknown) => {
    // A missing or foreign video id is a routing miss, not a page crash — the
    // built-in not-found UI is the right response, same as any other bad slug.
    if (isAppError(error) && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  });

  const script = video.script;
  const activeVersion = script?.activeVersion ?? null;
  const versions = script?.versions ?? [];

  // A DRAFT video hasn't been approved yet, so there is no pipeline run to
  // watch — fetching (and showing) the panel here would just be five
  // "pending" rows with nothing behind them. Fetched server-side, not via
  // the client's first poll, so the panel paints with real data instead of
  // a placeholder that immediately flips.
  const pipelineState =
    video.status === "DRAFT" ? null : await pipelineService.getState(user.id, video.id);

  return (
    <>
      <VideoHeader
        videoId={video.id}
        title={video.title}
        status={video.status}
        projectName={video.project.name}
        wordCount={activeVersion?.wordCount ?? 0}
      />

      {pipelineState && (
        <PipelinePanel videoId={video.id} initialState={pipelineState} />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ScriptPanel
            videoId={video.id}
            status={video.status}
            activeVersion={activeVersion}
          />
        </div>

        <div className="space-y-4">
          <VersionHistory
            videoId={video.id}
            status={video.status}
            versions={versions}
            activeVersionId={script?.activeVersionId ?? null}
          />
          <StatusEventsList events={video.statusEvents} />
        </div>
      </div>
    </>
  );
}
