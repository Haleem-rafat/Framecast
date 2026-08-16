import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";

import { PipelineRun } from "@/features/videos/components/pipeline-run";
import { ScriptPanel } from "@/features/videos/components/script-panel";
import { ShortsSection } from "@/features/videos/components/shorts-panel";
import {
  TimelineFallback,
  TimelineSection,
} from "@/features/videos/components/timeline-section";
import {
  VideoSection,
  type VideoSectionKey,
} from "@/features/videos/components/video-section";
import { StatusEventsList } from "@/features/videos/components/status-events-list";
import { ThumbnailNotice } from "@/features/videos/components/thumbnail-notice";
import { VersionHistory } from "@/features/videos/components/version-history";
import { VideoHeader } from "@/features/videos/components/video-header";
import { VideoPreview } from "@/features/videos/components/video-preview";
import { statRenderFile } from "@/lib/render-storage";
import { isAppError } from "@/lib/errors";
import { objectSizeBytes } from "@/lib/storage";
import { VIDEO_FORMATS } from "@/lib/video-format";
import { PUBLISHING_DEFAULTS } from "@/lib/youtube-categories";
import { requireUser } from "@/server/session";
import { pipelineService } from "@/services/pipeline.service";
import { promptTemplateService } from "@/services/prompt-template.service";
import { publishService } from "@/services/publish.service";
import { settingsService } from "@/services/settings.service";
import { shortsService } from "@/services/shorts.service";
import { videoService } from "@/services/video.service";
import { formatDuration } from "@/utils/format";
import type { VideoFormat, VideoStatus } from "@/generated/prisma/enums";

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
 * The pipeline section, streamed in rather than blocking the page. Both the
 * state and the log are fetched here on the server so the panel paints with
 * real stages and real log lines — the client's poll then takes over from that
 * state instead of flashing a placeholder that immediately flips.
 *
 * `PipelineRun` owns the section wrapper rather than the page, because the
 * section's header has to stay live while the section is folded and only a
 * client component can subscribe to the poll that makes it so. See its own
 * comment.
 */
async function PipelineSection({
  userId,
  videoId,
  defaultOpen,
}: {
  userId: string;
  videoId: string;
  defaultOpen: boolean;
}) {
  const [state, logs] = await Promise.all([
    pipelineService.getState(userId, videoId),
    pipelineService.getLogStream(userId, videoId),
  ]);

  return (
    <PipelineRun
      videoId={videoId}
      initialState={state}
      initialLogs={logs}
      defaultOpen={defaultOpen}
    />
  );
}

/**
 * The page's section order, keyed by what the video is currently doing.
 *
 * Every arrangement contains the same sections — nothing is hidden — but the
 * one an operator opened the page for goes first. The alternative, a fixed
 * order, means somebody always scrolls past two things they do not want; and
 * because the script panel is the tallest block on the page, "somebody" was
 * everyone whose video had already been written.
 */
const ORDERED_SECTIONS: Record<
  "writing" | "running" | "finished",
  VideoSectionKey[]
> = {
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

/**
 * Which sections start open, by the same reasoning the order above uses.
 *
 * Ordering solved half the problem — the section you came for is at the top —
 * and this is the other half: it is also already open, and the five you did
 * not come for are one line each instead of a screen each. The rule that makes
 * this safe rather than annoying is that folding must never add a click to the
 * common path, so every arrangement opens exactly the section its ordering
 * already decided to lead with.
 *
 * An operator's own choice, once they make one, outranks all of this — see
 * `VideoSection`'s localStorage handling.
 */
const DEFAULT_OPEN_SECTIONS: Record<
  keyof typeof ORDERED_SECTIONS,
  VideoSectionKey[]
> = {
  // A draft's pipeline has nothing in it and its player is empty, so writing
  // is the only thing that can happen and the script is the only thing worth
  // opening.
  writing: ["script"],
  // Mid-flight the run is the only part still changing. Note that the pipeline
  // section also forces itself open whenever a run starts, so this default
  // only matters for the first paint.
  running: ["pipeline"],
  // Watching it is the point, and the timeline is how you find the moment you
  // disliked — the two things a finished video is opened for.
  finished: ["preview", "timeline"],
};

function sectionOrderFor(status: VideoStatus): keyof typeof ORDERED_SECTIONS {
  if (status === "DRAFT") return "writing";
  if (
    status === "QUEUED" ||
    status === "GENERATING" ||
    status === "RENDERING"
  ) {
    return "running";
  }

  return "finished";
}

async function PreviewSection({
  videoId,
  format,
  renderOutputUrl,
  audioPath,
  durationSeconds,
  youtubeVideoId,
}: {
  videoId: string;
  /** Decides the player's shape and the resolution it reports. A 9:16 render
   * inside a 16:9 player is two black pillars and a stamp-sized video. */
  format: VideoFormat;
  renderOutputUrl: string | null;
  audioPath: string | null;
  durationSeconds: number | null;
  /** Lets the preview fall back to a YouTube embed once publishing has
   * reclaimed the local render — see VideoPreview's own comment. */
  youtubeVideoId: string | null;
}) {
  const [render, audio] = await Promise.all([
    renderOutputUrl
      ? resolveRenderPreview(videoId, renderOutputUrl)
      : Promise.resolve(null),
    audioPath ? resolvePreviewAsset(videoId, audioPath) : Promise.resolve(null),
  ]);

  return (
    <VideoPreview
      format={format}
      render={render}
      audio={audio}
      durationSeconds={durationSeconds}
      youtubeVideoId={youtubeVideoId}
    />
  );
}

/**
 * The shorts list, resolved on the server so the panel paints with real rows
 * instead of flashing an empty state the client's first poll would immediately
 * replace. `list` throws for a video this user does not own, which cannot
 * happen here — the page has already resolved the video for this user — so a
 * failure is an infrastructure one and falls back to an empty list rather than
 * taking the page down.
 */
async function ShortsSectionData({
  userId,
  videoId,
  status,
  format,
  defaultOpen,
}: {
  userId: string;
  videoId: string;
  status: VideoStatus;
  /** A vertical video already is a short, so the panel offers nothing and says
   * why — see `ShortsPanel`. */
  format: VideoFormat;
  defaultOpen: boolean;
}) {
  const shorts = await shortsService.list(userId, videoId).catch(() => []);

  return (
    <ShortsSection
      videoId={videoId}
      status={status}
      format={format}
      initialShorts={shorts}
      defaultOpen={defaultOpen}
    />
  );
}

/**
 * Mirrors the pipeline section closely enough that the page does not jump when
 * the real one lands: the same header bar, then the stage rail beside the log.
 * The stage placeholders are deliberately inert grey — a shimmer here would be
 * animating over stages whose status is not merely unknown to the operator but
 * unknown to this process.
 */
function PipelineFallback() {
  return (
    <div className="bg-card ring-foreground/10 overflow-hidden rounded-xl ring-1">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto h-3 w-28" />
      </div>
      <div className="border-foreground/10 grid gap-4 border-t px-4 py-4 lg:grid-cols-5">
        <div className="space-y-3 lg:col-span-2">
          {Array.from({ length: 5 }, (_unused, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
        <Skeleton className="h-40 w-full lg:col-span-3" />
      </div>
    </div>
  );
}

/** Mirrors VideoPreview: a 16:9 player beside the narration block. */
function PreviewFallback() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="aspect-video w-full lg:col-span-2" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export default async function VideoDetailPage({
  params,
}: VideoDetailPageProps) {
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

  // The publish dialog's visibility picker starts here, on the operator's own
  // saved preference — `settingsService.get` returns PRIVATE for an operator
  // who has never saved, and never writes a row just because a page was
  // rendered. Read on the page rather than inside the dialog because the
  // dialog is a client component and this is one indexed lookup on a page
  // that already makes several.
  const { defaultVisibility } = await settingsService.get(user.id);

  // Whether the dialog offers "also publish these shorts", and for how many.
  // Only asked for a video that can actually be published — the button renders
  // nothing at any other status, so a count taken for a draft would be one
  // indexed query spent on a control that is not on the page. The shorts panel
  // below loads its own list inside a Suspense boundary; this is the count the
  // *header* needs before that boundary resolves, which is why it is not read
  // from the same place.
  // A vertical video can have no shorts (`ShortsService` refuses one), so
  // there is never an offer to make and the count is not worth a query.
  const readyShortCount =
    video.status === "READY" && video.format === "LANDSCAPE"
      ? await publishService.countPublishableShorts(user.id, video.id)
      : 0;

  // Which script prompts the panel's picker offers. Only fetched for a draft:
  // generating is refused at every other status (`scriptService.generate`), so
  // for a video past the draft stage this is a query spent on a control the
  // panel does not render. Three columns per row, never `content` — see
  // `listForCategory`.
  const scriptTemplates =
    video.status === "DRAFT"
      ? await promptTemplateService.listForCategory(user.id, "SCRIPT")
      : [];

  const script = video.script;
  const activeVersion = script?.activeVersion ?? null;
  const versions = script?.versions ?? [];

  const renderOutputUrl = video.renderJobs[0]?.outputUrl ?? null;
  const audioPath = video.voiceOver?.audioUrl ?? null;
  const youtubeVideoId = video.publication?.youtubeVideoId ?? null;

  // Why the published video's custom thumbnail is not on YouTube, when it is
  // not. Read only for a video that actually reached YouTube — for anything
  // else there is no `Publication` row to ask about, and this would be one
  // indexed query spent on a notice that cannot render. Null covers both "it
  // attached" and "there was no thumbnail to attach", which is the common case
  // and draws nothing; see `ThumbnailNotice` for why silence is right there.
  const thumbnailError = youtubeVideoId
    ? ((await publishService.getThumbnailState(user.id, video.id))?.error ?? null)
    : null;

  const durationSeconds = video.voiceOver?.durationSeconds ?? null;
  const durationLabel =
    durationSeconds != null ? formatDuration(durationSeconds) : null;

  // Whether there is anything at all to play. Checked here rather than left to
  // `VideoPreview` returning null, because a section whose header says
  // "Preview" and whose body is empty is worse than no section: the whole
  // point of a folded header is that it is a promise about what is inside.
  const hasPreview = Boolean(renderOutputUrl || audioPath || youtubeVideoId);

  const arrangement = sectionOrderFor(video.status);
  const defaultOpen = DEFAULT_OPEN_SECTIONS[arrangement];
  const isOpenByDefault = (key: VideoSectionKey) => defaultOpen.includes(key);

  return (
    <>
      <VideoHeader
        videoId={video.id}
        title={video.title}
        status={video.status}
        format={video.format}
        projectName={video.project.name}
        wordCount={activeVersion?.wordCount ?? 0}
        characterCount={activeVersion?.content.length ?? 0}
        channelName={video.project.channel?.title ?? null}
        channelMadeForKids={
          video.project.channel?.brand?.madeForKids ??
          PUBLISHING_DEFAULTS.madeForKids
        }
        channelFootageStyle={
          video.project.channel?.brand?.footageStyle ??
          PUBLISHING_DEFAULTS.footageStyle
        }
        youtubeVideoId={youtubeVideoId}
        defaultVisibility={defaultVisibility}
        readyShortCount={readyShortCount}
      />

      {/* Everything about the video on one page, folded, in the order its
       * current state makes useful: a draft leads with the script because
       * writing is the only thing that can happen to it; a running video leads
       * with the pipeline because that is the only part still changing; a
       * finished one leads with the player because watching it is the point.
       *
       * This replaced a tabbed version, and then a stack of six always-open
       * cards. Tabs solved a real problem — a 480px script textarea sat between
       * the pipeline and the shorts panel, so checking a render meant scrolling
       * past a script nobody was editing — but they hid five sixths of the video
       * behind a click each. The six open cards brought the scrolling back. What
       * is here now is the pair that actually works together: the section you
       * came for is both first *and* already open, and the other five cost one
       * line each while still saying enough in that line to be worth not
       * opening.
       *
       * Every section is in the DOM from the first byte whether open or shut
       * (see `VideoSection` on `hidden="until-found"`), so find-in-page, screen
       * readers and crawlers see a whole page regardless. */}
      <div className="flex flex-col gap-4">
        {ORDERED_SECTIONS[arrangement].map((key) => {
          if (key === "pipeline") {
            return video.status === "DRAFT" ? (
              // A draft's pipeline has nothing to report, so the section says
              // so in its own header and has a single sentence behind it. The
              // alternative — a centred icon-and-paragraph empty state — spent
              // 360px of the first screen saying "nothing here".
              <VideoSection
                key={key}
                id="pipeline"
                title="Pipeline"
                summary="Not started"
                defaultOpen={isOpenByDefault(key)}
              >
                <p className="text-muted-foreground max-w-prose text-sm text-pretty">
                  Nothing has run yet. Approving the script starts narration,
                  footage and the render, and their progress appears here.
                </p>
              </VideoSection>
            ) : (
              <Suspense key={key} fallback={<PipelineFallback />}>
                <PipelineSection
                  userId={user.id}
                  videoId={video.id}
                  defaultOpen={isOpenByDefault(key)}
                />
              </Suspense>
            );
          }

          if (key === "preview") {
            // Dropped entirely rather than rendered empty — see `hasPreview`.
            if (!hasPreview) return null;

            return (
              <VideoSection
                key={key}
                id="preview"
                title="Preview"
                summary={
                  renderOutputUrl || youtubeVideoId
                    ? [durationLabel, VIDEO_FORMATS[video.format].dimensions]
                        .filter(Boolean)
                        .join(" · ")
                    : "Narration only"
                }
                defaultOpen={isOpenByDefault(key)}
                bodyClassName="space-y-4"
              >
                {/* Above the player, not below it: this is the section an
                    operator opens after publishing, and the fact that the
                    video went up with a YouTube-chosen frame has to be visible
                    without scrolling past a 16:9 embed to find it. Renders
                    nothing at all unless a failure was actually recorded. */}
                <ThumbnailNotice videoId={video.id} error={thumbnailError} />
                <Suspense fallback={<PreviewFallback />}>
                  <PreviewSection
                    videoId={video.id}
                    format={video.format}
                    renderOutputUrl={renderOutputUrl}
                    audioPath={audioPath}
                    durationSeconds={durationSeconds}
                    youtubeVideoId={youtubeVideoId}
                  />
                </Suspense>
              </VideoSection>
            );
          }

          if (key === "script") {
            return (
              <VideoSection
                key={key}
                id="script"
                title="Script"
                summary={
                  activeVersion
                    ? `v${activeVersion.version} · ${activeVersion.wordCount} words${
                        video.status === "DRAFT" ? "" : " · locked"
                      }`
                    : "Not written"
                }
                defaultOpen={isOpenByDefault(key)}
                // The script keeps its two-thirds column rather than going full
                // width: a monospace textarea spanning an ultrawide monitor
                // gives lines far too long to read back as spoken prose.
                bodyClassName="grid gap-4 lg:grid-cols-3"
              >
                <div className="lg:col-span-2">
                  <ScriptPanel
                    videoId={video.id}
                    status={video.status}
                    activeVersion={activeVersion}
                    scriptTemplates={scriptTemplates}
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
              <VideoSection
                key={key}
                id="timeline"
                title="Timeline"
                // The section count would be the better summary, but it only
                // exists inside `timelineService.get`, which this page
                // deliberately does not await — the whole reason the timeline
                // is behind its own Suspense boundary is that it reads storage
                // and stats the render. The duration is what the page already
                // knows for free, and it answers the same question: every
                // timing on the timeline is derived from the narration's
                // alignment, so a video with no narration has no timings yet
                // and this says which of the two it is. Never left blank — a
                // header with nothing in it is the one thing a collapsed
                // section must not be.
                summary={durationLabel ?? "Awaiting narration"}
                defaultOpen={isOpenByDefault(key)}
              >
                <Suspense fallback={<TimelineFallback />}>
                  <TimelineSection
                    userId={user.id}
                    videoId={video.id}
                    format={video.format}
                  />
                </Suspense>
              </VideoSection>
            );
          }

          if (key === "shorts") {
            return (
              <Suspense
                key={key}
                fallback={<Skeleton className="h-12 w-full rounded-xl" />}
              >
                <ShortsSectionData
                  userId={user.id}
                  videoId={video.id}
                  status={video.status}
                  format={video.format}
                  defaultOpen={isOpenByDefault(key)}
                />
              </Suspense>
            );
          }

          return (
            <VideoSection
              key={key}
              id="events"
              title="Activity"
              summary={
                video.statusEvents.length > 0
                  ? `${video.statusEvents.length} event${video.statusEvents.length === 1 ? "" : "s"}`
                  : "No events"
              }
              defaultOpen={isOpenByDefault(key)}
            >
              <StatusEventsList events={video.statusEvents} />
            </VideoSection>
          );
        })}
      </div>
    </>
  );
}
