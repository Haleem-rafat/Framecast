import "server-only";

import { NotFoundError } from "@/lib/errors";
import type { LogLevel, RenderStatus, VideoStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { formatBytes, formatDuration } from "@/utils/format";

export type PipelineStageKey =
  | "narration"
  | "footage"
  | "captions"
  | "render"
  | "upload";

export type PipelineStageStatus = "pending" | "running" | "done" | "failed";

export interface PipelineStage {
  key: PipelineStageKey;
  label: string;
  status: PipelineStageStatus;
  detail?: string;
}

export interface PipelineLogLine {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: Date;
}

export interface PipelineState {
  videoId: string;
  stages: PipelineStage[];
  /** The latest `RenderJob`'s percent complete (0-100). `null` until a render
   * has ever been started for this video. */
  progress: number | null;
  /** Seconds the latest `RenderJob` has been running, frozen at its finish
   * time once it's no longer active. `null` before any render has started. */
  elapsedSeconds: number | null;
  /** True once nothing here can change on its own again. `READY` is included
   * even though the video isn't fully done — the pipeline stops there and
   * waits on an operator to click Publish, so there is nothing left to poll
   * for. The single definition of "finished", so the panel never re-derives
   * it and risks disagreeing with the service about when to stop polling. */
  isTerminal: boolean;
  /** True while something is genuinely in flight — the latest `RenderJob` is
   * `RUNNING`, or the video itself is `GENERATING`/`RENDERING`. `false` for
   * `QUEUED` with no running job (nothing will change until a render worker
   * claims it) and for every terminal status. The single definition of
   * "actually moving", so the panel picks its poll interval from this
   * instead of re-deriving it from `VideoStatus`/`RenderStatus` itself. */
  isActive: boolean;
  /** Most recent `RenderLog` lines for the latest `RenderJob`, oldest first.
   * Only ever populated while that job is `RUNNING` or after it `FAILED` —
   * the only times the tail is shown or useful — so an idle poll never pays
   * for fetching lines nobody will look at. */
  logs: PipelineLogLine[];
}

const TERMINAL_STATUSES: ReadonlySet<VideoStatus> = new Set([
  "READY",
  "PUBLISHED",
  "FAILED",
]);

/** RenderLog rows can run into the thousands on a slow FFmpeg failure; this
 * is enough recent lines to diagnose a crash without paging through history. */
const LOG_LIMIT = 20;

/** Source table a merged log-stream entry came from. Kept distinct from
 * `LogLevel` — a `VideoStatusEvent` carries no level of its own (see
 * `statusEventLevel` below), so the stream needs a separate signal for "which
 * table" versus "how severe". */
export type PipelineLogSource = "render" | "status" | "activity";

export interface PipelineLogEntry {
  id: string;
  source: PipelineLogSource;
  level: LogLevel;
  message: string;
  createdAt: Date;
}

export interface PipelineLogStream {
  videoId: string;
  /** Oldest first, capped at `LOG_STREAM_LIMIT` — the merge queries newest
   * first (see `getLogStream`) and reverses once, here, so callers never
   * re-sort. */
  entries: PipelineLogEntry[];
  /** True when older lines exist beyond what was fetched, so the UI can say
   * so plainly instead of implying this is the whole history. */
  truncated: boolean;
}

/** The full merged stream, not the render-only preview `getState` embeds in
 * the panel (`LOG_LIMIT`, above). FFmpeg alone can emit hundreds of lines on
 * a slow failure; this is enough to diagnose one without an unbounded fetch. */
const LOG_STREAM_LIMIT = 200;

/** One more than the display cap, per source. Fetching `LOG_STREAM_LIMIT + 1`
 * from every source guarantees the true global top-`LOG_STREAM_LIMIT` (by
 * `createdAt`) is fully contained in the union — no source can contribute
 * more than that many rows to the merged head — while the "+1" turns "did any
 * source hit its own cap" into an exact truncation signal: if the merged
 * candidate count exceeds `LOG_STREAM_LIMIT`, something real was cut; if not,
 * every source returned its true total and nothing was. */
const LOG_STREAM_FETCH_LIMIT = LOG_STREAM_LIMIT + 1;

const STATUS_EVENT_MESSAGE_FALLBACK = (from: VideoStatus | null, to: VideoStatus): string =>
  from ? `${from} → ${to}` : to;

const STAGE_LABELS: Record<PipelineStageKey, string> = {
  narration: "Narration",
  footage: "Footage",
  captions: "Captions",
  render: "Render",
  upload: "Upload",
};

/** The order the pipeline actually runs in. Also doubles as the search order
 * for "which stage is active/failed" below, since the CLI runs these stages
 * one at a time rather than fanning them out. */
const STAGE_ORDER: readonly PipelineStageKey[] = [
  "narration",
  "footage",
  "captions",
  "render",
  "upload",
];

/** Unlike the other stages, `RenderJob` carries its own row-level status, so
 * render never needs the video-wide "first incomplete stage" fallback below
 * to know it failed. */
function renderStageStatus(job: { status: RenderStatus } | null): PipelineStageStatus {
  if (!job) return "pending";
  if (job.status === "RUNNING" || job.status === "QUEUED") return "running";
  if (job.status === "SUCCEEDED") return "done";
  return "failed"; // FAILED or CANCELLED
}

function titleCase(value: string): string {
  return value.length ? `${value[0]}${value.slice(1).toLowerCase()}` : value;
}

function footageDetail(
  clips: { provider: string | null; sizeBytes: bigint | null }[],
): string | undefined {
  if (clips.length === 0) return undefined;

  const bySource = new Map<string, number>();
  let totalBytes = BigInt(0);
  for (const clip of clips) {
    if (clip.provider) {
      bySource.set(clip.provider, (bySource.get(clip.provider) ?? 0) + 1);
    }
    if (clip.sizeBytes) {
      totalBytes += clip.sizeBytes;
    }
  }

  const sources = [...bySource.entries()]
    .map(([source, count]) => `${titleCase(source)} ${count}`)
    .join(", ");
  // Zero when every clip predates sizeBytes being recorded, or (harmlessly)
  // when they're all genuinely empty — either way there's nothing worth
  // showing, so the size segment is simply omitted rather than reading "0B".
  const size = totalBytes > BigInt(0) ? ` · ${formatBytes(Number(totalBytes))}` : "";

  return sources ? `${clips.length} clips · ${sources}${size}` : `${clips.length} clips${size}`;
}

/**
 * Read model for the pipeline progress panel. Every field here is exactly
 * what the panel renders — no storage paths and no tokens, so a client can
 * never use this response to bypass a signed URL.
 */
export class PipelineService {
  async getState(userId: string, videoId: string): Promise<PipelineState> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        // Narration's detail reports "characters sent" alongside its
        // duration — the same character count voiceover.service.ts actually
        // sent to ElevenLabs, already stored here rather than duplicated
        // onto VoiceOver as a new column.
        script: { select: { activeVersion: { select: { content: true } } } },
        voiceOver: { select: { audioUrl: true, durationSeconds: true } },
        publication: { select: { id: true } },
        renderJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            progress: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // Asset carries no videoId column (see schema.prisma's comment on the
    // model) — every object lives under `videos/{videoId}/...` in storage,
    // so the storage-path prefix is the scoping key, the same convention
    // render.service.ts and footage.service.ts already established. There's
    // no relation to walk here, so this can't be folded into the `select`
    // above the way voiceOver/publication/renderJobs are.
    const assets = await prisma.asset.findMany({
      where: {
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
        kind: { in: ["VIDEO", "SUBTITLE"] },
      },
      select: { kind: true, provider: true, sizeBytes: true },
    });

    const clips = assets.filter((asset) => asset.kind === "VIDEO");
    const hasCaptions = assets.some((asset) => asset.kind === "SUBTITLE");
    const renderJob = video.renderJobs[0] ?? null;
    const isTerminal = TERMINAL_STATUSES.has(video.status);
    // Only one stage is ever actually in flight — the CLI calls these
    // services one after another rather than fanning them out — so "the
    // first stage that isn't done yet" doubles as "what's running now" even
    // for narration/footage/captions, none of which have an in-progress row
    // of their own the way RenderJob does. This is deliberately looser than
    // the outward `isActive` below (it also promotes a merely-`QUEUED`
    // video, since something is nominally "next up" even before a worker
    // claims it) — it only decides which stage row gets the spinner, never
    // the poll interval.
    const promoteNextPendingStage = !isTerminal && video.status !== "DRAFT";
    // The read model's one definition of "genuinely in flight": a render
    // actually running, or the video actively mid-stage. `QUEUED` with no
    // `RUNNING` RenderJob is deliberately excluded — there is no render
    // worker yet, so that state can sit forever and the panel must poll it
    // slowly rather than as if progress were imminent.
    const isActive =
      !isTerminal &&
      (video.status === "GENERATING" ||
        video.status === "RENDERING" ||
        renderJob?.status === "RUNNING");

    // The tail is only ever displayed while the render row is expanded, and
    // only matters while it's running or after it failed — fetching it on
    // every idle poll (the common case with no render worker yet) would pay
    // for LOG_LIMIT rows nobody looks at. Queried separately, rather than
    // nested off `renderJobs` above, so that cost is skipped entirely
    // outside those two statuses instead of always joining it in.
    const logs =
      renderJob && (renderJob.status === "RUNNING" || renderJob.status === "FAILED")
        ? await prisma.renderLog.findMany({
            where: { renderJobId: renderJob.id },
            orderBy: { createdAt: "desc" },
            take: LOG_LIMIT,
            select: { id: true, level: true, message: true, createdAt: true },
          })
        : [];

    // Computed here (rather than where it's returned, below) so the render
    // stage's own `detail` can report elapsed time alongside percentage,
    // matching the CLI's "encoding … 42% (12.3s)" — the top-level
    // `elapsedSeconds` field is the same number, not a second computation.
    const elapsedSeconds = renderJob?.startedAt
      ? Math.max(
          0,
          Math.round(
            ((renderJob.finishedAt ?? new Date()).getTime() -
              renderJob.startedAt.getTime()) /
              1000,
          ),
        )
      : null;

    const characterCount = video.script?.activeVersion?.content?.length;

    const stageResults: Record<PipelineStageKey, Pick<PipelineStage, "status" | "detail">> = {
      narration: {
        status: video.voiceOver?.audioUrl ? "done" : "pending",
        detail:
          video.voiceOver?.durationSeconds != null
            ? `${formatDuration(video.voiceOver.durationSeconds)} narration` +
              (characterCount ? ` · ${characterCount.toLocaleString()} characters` : "")
            : undefined,
      },
      footage: {
        status: clips.length > 0 ? "done" : "pending",
        detail: footageDetail(clips),
      },
      captions: {
        status: hasCaptions ? "done" : "pending",
      },
      render: (() => {
        const status = renderStageStatus(renderJob);
        return {
          status,
          detail:
            renderJob && status === "running"
              ? `${renderJob.progress}%` +
                (elapsedSeconds != null ? ` · ${formatDuration(elapsedSeconds)} elapsed` : "")
              : undefined,
        };
      })(),
      upload: {
        status: video.publication ? "done" : "pending",
      },
    };

    const stages: PipelineStage[] = STAGE_ORDER.map((key) => ({
      key,
      label: STAGE_LABELS[key],
      ...stageResults[key],
    }));

    if (promoteNextPendingStage) {
      const runningIndex = stages.findIndex((stage) => stage.status === "pending");
      if (runningIndex !== -1) {
        stages[runningIndex] = { ...stages[runningIndex], status: "running" };
      }
    }

    // Render already carries its own definitive failure signal from
    // RenderJob.status (handled in renderStageStatus above) — if it fired,
    // the fallback below must not also flag Upload just because it happens
    // to be the next incomplete stage in the list.
    const hasRowLevelFailure = stages.some((stage) => stage.status === "failed");

    if (video.status === "FAILED" && !hasRowLevelFailure) {
      // No stage had its own row-level failure signal, so attribute the
      // failure to the first stage that never finished — in practice almost
      // always Upload, since publish.service.ts's error path deliberately
      // never creates a Publication row on a failed upload, leaving nothing
      // else to distinguish "hasn't started" from "failed here".
      const failedIndex = stages.findIndex((stage) => stage.status !== "done");
      if (failedIndex !== -1) {
        stages[failedIndex] = { ...stages[failedIndex], status: "failed" };
      }
    }

    return {
      videoId: video.id,
      stages,
      progress: renderJob?.progress ?? null,
      elapsedSeconds,
      isTerminal,
      isActive,
      // Queried newest-first to respect LOG_LIMIT; reversed here so the
      // panel can render top-to-bottom like a terminal without re-sorting.
      logs: [...logs].reverse(),
    };
  }

  /**
   * Merged, time-ordered view of everything the pipeline did to a video:
   * FFmpeg's stderr (`RenderLog`, across every render attempt — not just the
   * latest, unlike `getState`'s panel preview), every status transition
   * (`VideoStatusEvent`), and app-level actions (`ActivityLog`, scoped by
   * `entityType`/`entityId` rather than `userId` — a video's log is a video's
   * log regardless of which of its owner's actions produced a given row).
   * `userId` ownership is enforced by the initial video lookup alone, the
   * same pattern `getState` uses: only an owner can ever obtain a `videoId`
   * to pass in, so scoping the follow-up queries by it too would be
   * redundant, not safer. No `metadata` — `ActivityLog.metadata` is nullable,
   * schema-free JSON no code in this app currently populates with anything,
   * so surfacing it here would forward whatever a future writer puts there,
   * sight unseen, straight to the browser.
   */
  async getLogStream(userId: string, videoId: string): Promise<PipelineLogStream> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const [renderLogs, statusEvents, activityLogs] = await Promise.all([
      prisma.renderLog.findMany({
        // Every render attempt for this video, not just the latest job — a
        // retry's earlier FAILED attempt is exactly the kind of history this
        // stream exists to surface.
        where: { renderJob: { videoId } },
        orderBy: { createdAt: "desc" },
        take: LOG_STREAM_FETCH_LIMIT,
        select: { id: true, level: true, message: true, createdAt: true },
      }),
      prisma.videoStatusEvent.findMany({
        where: { videoId },
        orderBy: { createdAt: "desc" },
        take: LOG_STREAM_FETCH_LIMIT,
        select: { id: true, from: true, to: true, message: true, createdAt: true },
      }),
      prisma.activityLog.findMany({
        where: { entityType: "Video", entityId: videoId },
        orderBy: { createdAt: "desc" },
        take: LOG_STREAM_FETCH_LIMIT,
        select: { id: true, level: true, action: true, message: true, createdAt: true },
      }),
    ]);

    const candidates: PipelineLogEntry[] = [
      ...renderLogs.map((log) => ({
        id: log.id,
        source: "render" as const,
        level: log.level,
        message: log.message,
        createdAt: log.createdAt,
      })),
      ...statusEvents.map((event) => ({
        id: event.id,
        source: "status" as const,
        // VideoStatusEvent carries no level column of its own; a transition
        // *to* FAILED is the one case worth flagging as an error rather than
        // routine progress, so the "warnings and errors" filter catches it.
        level: (event.to === "FAILED" ? "ERROR" : "INFO") as LogLevel,
        message: event.message ?? STATUS_EVENT_MESSAGE_FALLBACK(event.from, event.to),
        createdAt: event.createdAt,
      })),
      ...activityLogs.map((entry) => ({
        id: entry.id,
        source: "activity" as const,
        level: entry.level,
        // `message` is optional on ActivityLog (some actions only ever set
        // `action`); the action name itself is still a meaningful line
        // rather than showing nothing.
        message: entry.message ?? entry.action,
        createdAt: entry.createdAt,
      })),
    ];

    candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // See LOG_STREAM_FETCH_LIMIT's comment: exceeding the display cap here
    // proves a real row was cut, and staying under it proves every source
    // returned its true total.
    const truncated = candidates.length > LOG_STREAM_LIMIT;
    const newestFirst = candidates.slice(0, LOG_STREAM_LIMIT);

    return {
      videoId: video.id,
      // Reversed once, here, to oldest-first — the stream reads top-to-bottom
      // like a terminal, same convention as getState's `logs`.
      entries: newestFirst.reverse(),
      truncated,
    };
  }
}

export const pipelineService = new PipelineService();
