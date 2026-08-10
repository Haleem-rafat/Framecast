import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LogStream } from "@/features/videos/components/log-stream";
import { PipelinePanel } from "@/features/videos/components/pipeline-panel";
import { ScriptPanel } from "@/features/videos/components/script-panel";
import { StatusEventsList } from "@/features/videos/components/status-events-list";
import { VersionHistory } from "@/features/videos/components/version-history";
import { VideoHeader } from "@/features/videos/components/video-header";
import { VideoPreview } from "@/features/videos/components/video-preview";
import { isAppError } from "@/lib/errors";
import { objectSizeBytes, signedUrl } from "@/lib/storage";
import { requireUser } from "@/server/session";
import { pipelineService } from "@/services/pipeline.service";
import { videoService } from "@/services/video.service";

export const metadata: Metadata = { title: "Video" };

interface VideoDetailPageProps {
  params: Promise<{ id: string }>;
}

/** Long enough that an operator reviewing a video doesn't hit expiry
 * mid-watch; short enough that a leaked link to unpublished, unapproved work
 * goes stale on its own. A page left open past this needs a reload — the
 * player and download link will 403 until then. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Turns a private-bucket path into something the browser can play — a signed
 * URL plus (best-effort) its size. Never throws: this page's rendered video
 * and narration are worth showing even if the storage round trip for one of
 * them fails, so a failure here just means that section falls back to its
 * "couldn't load" state instead of taking the whole page down.
 */
async function resolvePreviewAsset(
  storagePath: string,
): Promise<{ url: string; sizeBytes: number | null } | null> {
  const url = await signedUrl(storagePath, SIGNED_URL_TTL_SECONDS).catch(() => null);

  if (!url) {
    return null;
  }

  const sizeBytes = await objectSizeBytes(storagePath).catch(() => null);
  return { url, sizeBytes };
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
  // Same DRAFT gate as pipelineState below — there is no pipeline run to
  // watch yet, so the log stream would just be an empty box. Fetched
  // alongside pipelineState (both server-side) so the page paints with real
  // logs on first load instead of the client's first poll.
  const [pipelineState, pipelineLogs] =
    video.status === "DRAFT"
      ? [null, null]
      : await Promise.all([
          pipelineService.getState(user.id, video.id),
          pipelineService.getLogStream(user.id, video.id),
        ]);

  // outputUrl/audioUrl are storage paths, not URLs — resolved here, server-side,
  // so the client only ever receives a signed URL. Passing a raw path to the
  // browser (plus this app's service-role key) is exactly how a private bucket
  // ends up de facto public.
  const [renderPreview, audioPreview] = await Promise.all([
    video.renderJobs[0]?.outputUrl
      ? resolvePreviewAsset(video.renderJobs[0].outputUrl)
      : Promise.resolve(null),
    video.voiceOver?.audioUrl
      ? resolvePreviewAsset(video.voiceOver.audioUrl)
      : Promise.resolve(null),
  ]);

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

      {pipelineState && pipelineLogs && (
        <LogStream
          videoId={video.id}
          initialLogs={pipelineLogs}
          initialPipelineState={pipelineState}
        />
      )}

      {/* Above the script panel: once a video exists, watching it is the
       * primary action on this page, and it's the one an operator needs to
       * see before Gate 2 (YouTube publish) means anything. */}
      <VideoPreview
        render={video.renderJobs[0]?.outputUrl ? renderPreview : null}
        audio={video.voiceOver?.audioUrl ? audioPreview : null}
        durationSeconds={video.voiceOver?.durationSeconds ?? null}
      />

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
