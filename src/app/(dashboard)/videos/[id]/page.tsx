import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Workflow } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { LogStream } from "@/features/videos/components/log-stream";
import { PipelinePanel } from "@/features/videos/components/pipeline-panel";
import { ScriptPanel } from "@/features/videos/components/script-panel";
import { ShortsPanel } from "@/features/videos/components/shorts-panel";
import { StatusEventsList } from "@/features/videos/components/status-events-list";
import { VersionHistory } from "@/features/videos/components/version-history";
import { VideoHeader } from "@/features/videos/components/video-header";
import { VideoPreview } from "@/features/videos/components/video-preview";
import { statRenderFile } from "@/lib/render-storage";
import { isAppError } from "@/lib/errors";
import { objectSizeBytes } from "@/lib/storage";
import { requireUser } from "@/server/session";
import { pipelineService } from "@/services/pipeline.service";
import { shortsService } from "@/services/shorts.service";
import { videoService } from "@/services/video.service";
import type { VideoStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Video" };

interface VideoDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * The narration's counterpart to `resolveRenderPreview` below: a URL the browser
 * can play, plus (best-effort) its size. No signed URL to mint — the browser
 * is pointed at this app's own route, which resolves the object from the video
 * id behind a session check. Never throws: this page's narration is worth
 * showing even if the size lookup fails.
 */
async function resolvePreviewAsset(
  videoId: string,
  storagePath: string,
): Promise<{ url: string; sizeBytes: number | null }> {
  const sizeBytes = await objectSizeBytes(storagePath).catch(() => null);
  return { url: `/api/videos/${videoId}/narration`, sizeBytes };
}

/**
 * The rendered video's local-disk counterpart to `resolvePreviewAsset`
 * above. No signed URL to mint — the browser is pointed at this app's own
 * streaming route (`/api/videos/[id]/file`, see render-storage.ts), which
 * resolves the render from the video id server-side. `statRenderFile`
 * already returns `null` (not a throw) for a missing render, but this still
 * wraps it in `.catch` — the *page's* contract is "never throw", regardless
 * of which failure (missing render vs. a real disk error) produced it.
 * Either way this section falls back to "couldn't load" rather than taking
 * the page down; the operator's next move either way is to re-render.
 */
async function resolveRenderPreview(
  videoId: string,
  outputUrl: string,
): Promise<{ url: string; sizeBytes: number | null } | null> {
  const fileStat = await statRenderFile(outputUrl).catch(() => null);

  if (!fileStat) {
    return null;
  }

  return { url: `/api/videos/${videoId}/file`, sizeBytes: fileStat.sizeBytes };
}

/**
 * The pipeline panel and its log stream, streamed in rather than blocking the
 * page. Both are fetched here on the server so the panel paints with real
 * stages and real log lines — the client's poll then takes over from that
 * state instead of flashing a placeholder that immediately flips.
 */
async function PipelineSection({ userId, videoId }: { userId: string; videoId: string }) {
  const [state, logs] = await Promise.all([
    pipelineService.getState(userId, videoId),
    pipelineService.getLogStream(userId, videoId),
  ]);

  return (
    <>
      <PipelinePanel videoId={videoId} initialState={state} />
      <LogStream videoId={videoId} initialLogs={logs} initialPipelineState={state} />
    </>
  );
}

/**
 * The player. Its render source resolves via a disk `stat` (`statRenderFile`
 * above), which is why this is behind its own boundary rather than holding
 * up the page.
 *
 * Both paths stay on the server: the browser is handed this app's own
 * streaming route for the render and this app's own narration route for the
 * audio, never a raw storage path. Passing a storage path to the client is
 * how private storage ends up de facto public.
 */
/**
 * Which tab the page opens on, given where the video is.
 *
 * DRAFT has nothing to watch and no run to inspect, so it opens on the one
 * thing that can be done: writing. Anything mid-flight opens on the run, which
 * is the only part still changing. Everything terminal opens on the result.
 */
function openingTabFor(status: VideoStatus): "overview" | "script" | "pipeline" {
  if (status === "DRAFT") return "script";
  if (status === "QUEUED" || status === "GENERATING" || status === "RENDERING") {
    return "pipeline";
  }

  return "overview";
}

async function PreviewSection({
  videoId,
  renderOutputUrl,
  audioPath,
  durationSeconds,
  youtubeVideoId,
}: {
  videoId: string;
  renderOutputUrl: string | null;
  audioPath: string | null;
  durationSeconds: number | null;
  /** Lets the preview fall back to a YouTube embed once publishing has
   * reclaimed the local render — see VideoPreview's own comment. */
  youtubeVideoId: string | null;
}) {
  const [render, audio] = await Promise.all([
    renderOutputUrl ? resolveRenderPreview(videoId, renderOutputUrl) : Promise.resolve(null),
    audioPath ? resolvePreviewAsset(videoId, audioPath) : Promise.resolve(null),
  ]);

  return (
    <VideoPreview
      render={render}
      audio={audio}
      durationSeconds={durationSeconds}
      youtubeVideoId={youtubeVideoId}
    />
  );
}

/**
 * The shorts panel, with its list resolved on the server so it paints with
 * real rows instead of flashing an empty state the client's first poll would
 * immediately replace. `list` throws for a video this user does not own, which
 * cannot happen here — the page has already resolved the video for this user —
 * so a failure is an infrastructure one and falls back to an empty list rather
 * than taking the page down.
 */
async function ShortsSection({
  userId,
  videoId,
  status,
}: {
  userId: string;
  videoId: string;
  status: VideoStatus;
}) {
  const shorts = await shortsService.list(userId, videoId).catch(() => []);

  return <ShortsPanel videoId={videoId} status={status} initialShorts={shorts} />;
}

/** Mirrors PipelinePanel's card so the layout doesn't jump when it lands. */
function PipelineFallback() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-8 w-24" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Mirrors VideoPreview: a 16:9 player beside the narration card. */
function PreviewFallback() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="aspect-video w-full lg:col-span-2" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
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

  const renderOutputUrl = video.renderJobs[0]?.outputUrl;

  return (
    <>
      <VideoHeader
        videoId={video.id}
        title={video.title}
        status={video.status}
        projectName={video.project.name}
        wordCount={activeVersion?.wordCount ?? 0}
        channelName={video.project.channel?.title ?? null}
        youtubeVideoId={video.publication?.youtubeVideoId ?? null}
      />

      {/* Four jobs live on this page — writing, watching a run, reviewing the
       * result, cutting shorts — and only one of them is ever the reason an
       * operator opened it. Stacked vertically they cost each other: a 480px
       * script textarea sat between the pipeline and the shorts panel, so
       * checking a render meant scrolling past a script nobody was editing.
       *
       * `Tabs` is the client component here; this page stays a server
       * component and hands it already-rendered children, so every Suspense
       * boundary below still streams exactly as it did.
       *
       * The opening tab follows the video's own state rather than being fixed,
       * because what an operator wants is entirely determined by it: a draft
       * needs writing, a running video needs watching, a finished one needs
       * reviewing. */}
      <Tabs defaultValue={openingTabFor(video.status)} className="gap-4">
        {/* Four tabs just fit a 375px screen and would not survive a fifth or
         * a longer label, and `TabsList` has no scroll container of its own —
         * an over-wide strip pushes the document sideways instead. */}
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="script">Script</TabsTrigger>
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="shorts">Shorts</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <Suspense fallback={<PreviewFallback />}>
            <PreviewSection
              videoId={video.id}
              renderOutputUrl={renderOutputUrl ?? null}
              audioPath={video.voiceOver?.audioUrl ?? null}
              durationSeconds={video.voiceOver?.durationSeconds ?? null}
              youtubeVideoId={video.publication?.youtubeVideoId ?? null}
            />
          </Suspense>
          <StatusEventsList events={video.statusEvents} />
        </TabsContent>

        <TabsContent value="script" className="grid gap-4 lg:grid-cols-3">
          {/* The script keeps its two-thirds column rather than going full
           * width: a 480px monospace textarea spanning an ultrawide monitor
           * gives lines far too long to read back as spoken prose. */}
          <div className="lg:col-span-2">
            <ScriptPanel
              videoId={video.id}
              status={video.status}
              activeVersion={activeVersion}
            />
          </div>
          <VersionHistory
            videoId={video.id}
            status={video.status}
            versions={versions}
            activeVersionId={script?.activeVersionId ?? null}
          />
        </TabsContent>

        <TabsContent value="pipeline">
          {video.status === "DRAFT" ? (
            <EmptyState
              icon={Workflow}
              title="Nothing has run yet"
              description="Approve the script and the pipeline starts: narration, footage, render. Its progress and logs appear here."
            />
          ) : (
            <Suspense fallback={<PipelineFallback />}>
              <PipelineSection userId={user.id} videoId={video.id} />
            </Suspense>
          )}
        </TabsContent>

        <TabsContent value="shorts">
          {/* Shorts are cut out of a finished render, so this is only ever
           * useful once one exists; the panel itself explains that rather than
           * vanishing, so an operator can see the feature is there. */}
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <ShortsSection userId={user.id} videoId={video.id} status={video.status} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
