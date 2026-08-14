import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Workflow } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { LogStream } from "@/features/videos/components/log-stream";
import { PipelinePanel } from "@/features/videos/components/pipeline-panel";
import { ScriptPanel } from "@/features/videos/components/script-panel";
import { ShortsPanel } from "@/features/videos/components/shorts-panel";
import {
  TimelineFallback,
  TimelineSection,
} from "@/features/videos/components/timeline-section";
import { VideoSection } from "@/features/videos/components/video-section";
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

  // Laid out the way a CI run is: the list of stages down the left, the log
  // for the run beside it on the right. Stacked, the log sat below a panel
  // tall enough to push it off screen, so watching a render meant scrolling
  // down to the output and back up to see which stage produced it — the two
  // halves of one question, kept apart.
  //
  // Collapses to a single column below `lg`, where side-by-side would give the
  // log about forty characters a line and make it unreadable.
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="lg:col-span-2">
        <PipelinePanel videoId={videoId} initialState={state} />
      </div>
      <div className="lg:col-span-3">
        <LogStream videoId={videoId} initialLogs={logs} initialPipelineState={state} />
      </div>
    </div>
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
type SectionKey =
  | "pipeline"
  | "preview"
  | "script"
  | "timeline"
  | "shorts"
  | "events";

/**
 * The page's section order, keyed by what the video is currently doing.
 *
 * Every arrangement contains the same six sections — nothing is hidden — but
 * the one an operator opened the page for goes first. The alternative, a fixed
 * order, means somebody always scrolls past two things they do not want; and
 * because the script panel is the tallest block on the page, "somebody" was
 * everyone whose video had already been written.
 */
const ORDERED_SECTIONS: Record<"writing" | "running" | "finished", SectionKey[]> = {
  // The run leads every arrangement — it is the status line for the whole
  // video, and an operator opening this page usually wants to know where it
  // got to before anything else. A draft's is an empty state saying nothing
  // has started, which is itself the answer to that question.
  //
  // Nothing to watch and no run to inspect. Writing is the only move.
  writing: ["pipeline", "script", "preview", "timeline", "shorts", "events"],
  // Mid-flight: the run is the only part still changing, and the player will
  // not have anything in it until the render lands.
  running: ["pipeline", "preview", "script", "timeline", "shorts", "events"],
  // Terminal: the run says "done" at a glance, then watching it is the point,
  // and the timeline is how you find the moment you disliked.
  finished: ["pipeline", "preview", "timeline", "shorts", "script", "events"],
};

function sectionOrderFor(status: VideoStatus): keyof typeof ORDERED_SECTIONS {
  if (status === "DRAFT") return "writing";
  if (status === "QUEUED" || status === "GENERATING" || status === "RENDERING") {
    return "running";
  }

  return "finished";
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

      {/* Everything about the video on one page, in the order its current state
       * makes useful: a draft leads with the script because writing is the only
       * thing that can happen to it; a running video leads with the pipeline
       * because that is the only part still changing; a finished one leads with
       * the player because watching it is the point.
       *
       * This replaced a tabbed version. Tabs did solve a real problem — a 480px
       * script textarea sat between the pipeline and the shorts panel, so
       * checking a render meant scrolling past a script nobody was editing —
       * and simply removing them would bring that straight back. Two things
       * stop it: the order below moves the section you came for to the top, and
       * `ScriptPanel` collapses to a summary once the script is locked, which is
       * exactly when that textarea was costing everyone else their place.
       *
       * Every section is in the DOM from the first byte. `VideoSection` only
       * animates the arrival, so find-in-page, screen readers and crawlers see
       * a whole page regardless of whether the animation runs at all. */}
      <div className="flex flex-col gap-4">
        {ORDERED_SECTIONS[sectionOrderFor(video.status)].map((key, index) => {
          // The first two blocks are what the operator came for, so they are
          // present immediately rather than fading in under their eyes.
          const immediate = index < 2;

          if (key === "pipeline") {
            return (
              <VideoSection key={key} immediate={immediate}>
                {video.status === "DRAFT" ? (
                  // One line, not a full EmptyState. A draft's pipeline has
                  // nothing to report and this sits at the top of the page, so
                  // a centred icon-and-paragraph card spent 360px of the first
                  // screen saying "nothing here" and pushed the script — the
                  // only thing an operator can act on — below the fold.
                  <Card>
                    <CardContent className="text-muted-foreground flex items-center gap-3 py-4 text-sm">
                      <Workflow className="size-4 shrink-0" />
                      <p className="text-pretty">
                        Nothing has run yet. Approving the script starts
                        narration, footage and the render, and their progress
                        appears here.
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <Suspense fallback={<PipelineFallback />}>
                    <PipelineSection userId={user.id} videoId={video.id} />
                  </Suspense>
                )}
              </VideoSection>
            );
          }

          if (key === "preview") {
            return (
              <VideoSection key={key} immediate={immediate}>
                <Suspense fallback={<PreviewFallback />}>
                  <PreviewSection
                    videoId={video.id}
                    renderOutputUrl={renderOutputUrl ?? null}
                    audioPath={video.voiceOver?.audioUrl ?? null}
                    durationSeconds={video.voiceOver?.durationSeconds ?? null}
                    youtubeVideoId={video.publication?.youtubeVideoId ?? null}
                  />
                </Suspense>
              </VideoSection>
            );
          }

          if (key === "script") {
            return (
              // The script keeps its two-thirds column rather than going full
              // width: a monospace textarea spanning an ultrawide monitor gives
              // lines far too long to read back as spoken prose.
              <VideoSection key={key} immediate={immediate} className="grid gap-4 lg:grid-cols-3">
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
              </VideoSection>
            );
          }

          if (key === "timeline") {
            return (
              <VideoSection key={key} immediate={immediate}>
                <Suspense fallback={<TimelineFallback />}>
                  <TimelineSection userId={user.id} videoId={video.id} />
                </Suspense>
              </VideoSection>
            );
          }

          if (key === "shorts") {
            return (
              // Shorts are cut out of a finished render, so this is only ever
              // useful once one exists; the panel explains that rather than
              // vanishing, so an operator can see the feature is there.
              <VideoSection key={key} immediate={immediate}>
                <Suspense fallback={<Skeleton className="h-40 w-full" />}>
                  <ShortsSection userId={user.id} videoId={video.id} status={video.status} />
                </Suspense>
              </VideoSection>
            );
          }

          return (
            <VideoSection key={key} immediate={immediate}>
              <StatusEventsList events={video.statusEvents} />
            </VideoSection>
          );
        })}
      </div>
    </>
  );
}
