import "server-only";

import { NotFoundError } from "@/lib/errors";
import type { LogLevel, PublishStatus, RenderStatus, VideoStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { MAX_ATTEMPTS } from "@/services/job.service";
import { formatBytes, formatDuration } from "@/utils/format";

export type PipelineStageKey =
  | "narration"
  | "footage"
  | "captions"
  | "render"
  | "metadata"
  | "thumbnail"
  | "upload";

/** `skipped` exists only for the two optional stages (`metadata`,
 * `thumbnail`, see `OPTIONAL_STAGE_KEYS`) — the video is finished (or will
 * never automatically try again) and the stage never completed. It is
 * deliberately not `failed`: neither stage has a persisted "this attempt
 * threw" signal to read back (both are documented to swallow their own
 * errors — see metadata.service.ts / thumbnail.service.ts), so this state
 * covers "generation ran and quietly produced nothing" and "this video
 * predates the feature entirely" identically, without guessing which one
 * happened. See the "first incomplete stage" fallback in `getState` for why
 * conflating either of those with an actual pipeline failure would be worse
 * than not distinguishing them. */
export type PipelineStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

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
   * for — *except* while `isFinalizing` is also true (see its own comment):
   * `metadata` and `thumbnail` can still be running behind an
   * already-`READY` status, and that is exactly the case this flips to
   * `false` for, so `isTerminal` stays true to its name — nothing left to
   * happen — rather than being true merely because `VideoStatus` looks
   * finished. The single definition of "finished", so the panel never
   * re-derives it and risks disagreeing with the service about when to stop
   * polling. */
  isTerminal: boolean;
  /** True exactly during the window where `render.service.ts` has already
   * committed `READY` (inside its own transaction, the moment the encode
   * succeeds) but `runPipeline` (pipeline-runner.ts) has not yet finished
   * running the `metadata` and `thumbnail` stages that come after it. The
   * signal is `Video.leaseExpiresAt`: the worker (or the CLI's direct lease)
   * holds and renews that lease for the *entire* duration of `runPipeline`,
   * from claim to its own `release()` call, which only runs after every
   * stage — metadata and thumbnail included — has resolved. So a live lease
   * on a `READY` video is proof those two stages are still in flight, not
   * proof of anything wrong; a `READY` video with no live lease has already
   * had its one automatic chance at both. Exists so the panel can keep
   * polling and show the right stage as `running` during that window instead
   * of reading `isTerminal` and freezing on "Render done, Metadata pending"
   * until the operator reloads the page. */
  isFinalizing: boolean;
  /** True while something is genuinely in flight — the latest `RenderJob` is
   * `RUNNING`, or the video itself is `GENERATING`/`RENDERING`. `false` for
   * `QUEUED` with no running job (nothing will change until a render worker
   * claims it) and for every terminal status — deliberately *not* widened to
   * include `isFinalizing`: unlike a running render, there is nothing an
   * operator can do about metadata/thumbnail generation (no cancel endpoint
   * accepts a `READY` video — see pipeline-runner.ts's own comment on why —
   * and no manual re-run), so this stays the specific signal the Cancel
   * button gates on, not a general "is anything happening" flag. The single
   * definition of "actually moving" for that purpose, so the panel picks its
   * poll interval from this instead of re-deriving it from
   * `VideoStatus`/`RenderStatus` itself. */
  isActive: boolean;
  /** True precisely when `VideoStatus` is `FAILED` — the one discriminator
   * `isTerminal` alone can't give the Run/Cancel/Retry controls, since
   * `READY`/`PUBLISHED` are terminal too but call for no button at all.
   * Deliberately not inferred from `stages` (a stage can read "failed" from
   * a stale `RenderJob` row even while the video itself is freshly `QUEUED`
   * again after a retry — see `getState`'s render-stage comment), so this is
   * read straight off the video row instead. */
  isFailed: boolean;
  /** How many claim attempts this video has spent. 0 until a worker first
   * claims it (`JobService.claimNext` increments on claim, not on queue). */
  attempts: number;
  /** The cap `JobService.claimNext`/`JobService.retry` both enforce,
   * forwarded rather than hardcoded a second time in the panel. */
  maxAttempts: number;
  /** True once `attempts` has reached `maxAttempts` — `claimNext` will never
   * claim this video again, so Retry has nothing left to offer and the panel
   * must say so instead of rendering a button that does nothing. */
  attemptsExhausted: boolean;
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
  metadata: "Metadata",
  thumbnail: "Thumbnail",
  upload: "Upload",
};

/** The order the pipeline actually runs in. Also doubles as the search order
 * for "which stage is active/failed" below, since the CLI runs these stages
 * one at a time rather than fanning them out. `metadata` and `thumbnail` sit
 * between `render` and `upload` because that is the order `runPipeline`
 * (pipeline-runner.ts) actually runs them in — after the render succeeds,
 * before the operator's manual publish — and specifically in that relative
 * order to each other: `thumbnail` reads `Video.generatedTitle` for its
 * headline text, so `metadata` must have already run for the thumbnail to
 * draw the generated title rather than the operator's placeholder one. */
const STAGE_ORDER: readonly PipelineStageKey[] = [
  "narration",
  "footage",
  "captions",
  "render",
  "metadata",
  "thumbnail",
  "upload",
];

/**
 * `metadata` and `thumbnail` — the two stages `runOptionalStage`
 * (pipeline-runner.ts) runs, both documented to swallow their own errors
 * rather than fail the pipeline. Marked out from the rest of `STAGE_ORDER`
 * for two unrelated reasons below, both stemming from the same fact: unlike
 * every other stage, one of these being incomplete is an expected, silent
 * outcome rather than evidence of anything having gone wrong.
 *
 * 1. The "first incomplete stage" fallback that attributes a video-wide
 *    `FAILED` status to a specific row must skip both. `publish()` creates
 *    its `Publication` row *before* the upload as its concurrency claim (see
 *    publish.service.ts), so `upload` already reads "done" the moment a
 *    publish attempt starts — meaning a failed publish, with metadata or
 *    thumbnail sitting incomplete for entirely unrelated reasons, would
 *    otherwise have the fallback land on one of them and hide the real
 *    failure (upload) from the panel entirely.
 * 2. `promoteNextPendingStage` must not promote past them into `upload`
 *    while `isFinalizing` (see that field's own comment): the video is
 *    `READY`, `upload` only ever moves via an operator's own manual publish
 *    click, and nothing here is doing that automatically.
 */
const OPTIONAL_STAGE_KEYS: ReadonlySet<PipelineStageKey> = new Set(["metadata", "thumbnail"]);

/** Unlike the other stages, `RenderJob` carries its own row-level status, so
 * render never needs the video-wide "first incomplete stage" fallback below
 * to know it failed. */
function renderStageStatus(job: { status: RenderStatus } | null): PipelineStageStatus {
  if (!job) return "pending";
  if (job.status === "RUNNING" || job.status === "QUEUED") return "running";
  if (job.status === "SUCCEEDED") return "done";
  return "failed"; // FAILED or CANCELLED
}

/**
 * Same reasoning as `renderStageStatus` above, and for the same underlying
 * bug it once shared with `upload`: `publish.service.ts` creates the
 * `Publication` row *before* the actual YouTube upload, as its concurrency
 * claim (`Publication.videoId` is `@unique` — see that file's own comment on
 * why), and never deletes it on failure, only flips its `status` to
 * `FAILED`. Deriving `upload`'s status from "does a `Publication` row exist"
 * therefore reads a failed publish as *done* — the row is right there, it
 * just failed. `Publication` carries its own row-level status for exactly
 * this reason, so `upload` needs it read and mapped, not merely checked for
 * existence, mirroring how `render` already reads `RenderJob.status` instead
 * of asking "does a `RenderJob` exist". `PENDING` (the schema default) is
 * mapped to `pending`: `publish.service.ts` always writes `UPLOADING`
 * immediately on create and never leaves a row at the schema default, but
 * treating an unreached value as "not started" costs nothing and is safer
 * than assuming it can't happen.
 */
function uploadStageStatus(publication: { status: PublishStatus } | null): PipelineStageStatus {
  if (!publication) return "pending";
  if (publication.status === "PENDING") return "pending";
  if (publication.status === "UPLOADING") return "running";
  if (publication.status === "FAILED") return "failed";
  return "done"; // PUBLISHED or SCHEDULED
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
        attempts: true,
        // Read purely to detect `isFinalizing` (see that field's own doc
        // comment): a live lease on an otherwise-`READY` video is what tells
        // this apart from a video that has already had its one chance at
        // `metadata`/`thumbnail`. Never surfaced to the client directly —
        // `PipelineState` only ever exposes the derived boolean.
        leaseExpiresAt: true,
        // Narration's detail reports "characters sent" alongside its
        // duration — the same character count voiceover.service.ts actually
        // sent to ElevenLabs, already stored here rather than duplicated
        // onto VoiceOver as a new column.
        script: { select: { activeVersion: { select: { content: true } } } },
        voiceOver: { select: { audioUrl: true, durationSeconds: true } },
        // MetadataService.generate's one durable side effect worth reading
        // back here: a non-null generatedTitle is proof the stage actually
        // wrote something, the same way voiceOver.audioUrl proves narration
        // did. generatedDescription/tags are written alongside it in the same
        // call, so title alone is enough to tell "done" from "pending".
        generatedTitle: true,
        // Mirrors ThumbnailService.storeVersion: a Thumbnail row can exist
        // with no activeVersionId (created but never successfully composited
        // — see storeVersion's own comment on why version rows are never
        // overwritten), so the presence of the row alone isn't "done"; the
        // active pointer is.
        thumbnail: { select: { activeVersionId: true } },
        // `status` (not just `id`): see `uploadStageStatus`'s own comment on
        // why "a Publication row exists" is not the same question as
        // "upload succeeded".
        publication: { select: { id: true, status: true } },
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
    //
    // Deliberately no `deletedAt: null` filter. `Asset.deletedAt` has
    // exactly one writer in this codebase: publish.service.ts's
    // reclaimClipStorage, which soft-deletes a video's clip rows once it's
    // PUBLISHED (their bucket objects are gone by then, but the rows — and
    // their `provider`/`sizeBytes` — are left as-is). Excluding those rows
    // here would make a published video's footage stage regress from "done"
    // back to "pending" the moment its clips are reclaimed, reading as an
    // unfinished video that is, in fact, live on YouTube. This read model
    // never returns a storage path (see the class doc comment above), so
    // surfacing a reclaimed clip's kind/provider/sizeBytes here — the same
    // "N clips · Pexels 4 · 312MB" line it would have shown before
    // reclaim — leaks nothing; it's just history the row still remembers.
    const assets = await prisma.asset.findMany({
      where: {
        storagePath: { startsWith: `videos/${videoId}/` },
        kind: { in: ["VIDEO", "SUBTITLE"] },
      },
      select: { kind: true, provider: true, sizeBytes: true },
    });

    const clips = assets.filter((asset) => asset.kind === "VIDEO");
    const hasCaptions = assets.some((asset) => asset.kind === "SUBTITLE");
    const renderJob = video.renderJobs[0] ?? null;

    // See `isFinalizing`'s own doc comment on `PipelineState` for the full
    // reasoning: a lease that is still live proves the worker (or the CLI's
    // direct lease) has not yet called `release()`, which only happens after
    // `runPipeline` — metadata/thumbnail included — has fully resolved.
    const isFinalizing =
      video.status === "READY" &&
      video.leaseExpiresAt != null &&
      video.leaseExpiresAt.getTime() > Date.now();
    const isTerminal = TERMINAL_STATUSES.has(video.status) && !isFinalizing;

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
    // slowly rather than as if progress were imminent. `isFinalizing` is
    // also deliberately excluded — see its field comment on `PipelineState`
    // for why this stays the Cancel button's own signal rather than a
    // general "something is happening" flag.
    const isActive =
      !isTerminal &&
      !isFinalizing &&
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
      metadata: {
        status: video.generatedTitle ? "done" : "pending",
      },
      thumbnail: {
        status: video.thumbnail?.activeVersionId ? "done" : "pending",
      },
      upload: {
        status: uploadStageStatus(video.publication),
        detail: video.publication?.status === "FAILED" ? "publish failed" : undefined,
      },
    };

    const stages: PipelineStage[] = STAGE_ORDER.map((key) => ({
      key,
      label: STAGE_LABELS[key],
      ...stageResults[key],
    }));

    if (promoteNextPendingStage) {
      // While `isFinalizing`, `isTerminal` is already `false` (see its own
      // comment), so this block runs even though the video reads `READY` —
      // but only `metadata`/`thumbnail` may be promoted in that case.
      // `upload` moves solely on an operator's own manual publish click, and
      // without this restriction it would be the next "pending" stage the
      // instant both optional stages happen to already be done, reading as
      // an upload that is running when nothing is touching it.
      const isPromotable = (stage: PipelineStage): boolean =>
        stage.status === "pending" && (!isFinalizing || OPTIONAL_STAGE_KEYS.has(stage.key));
      const runningIndex = stages.findIndex(isPromotable);
      if (runningIndex !== -1) {
        stages[runningIndex] = { ...stages[runningIndex], status: "running" };
      }
    }

    // Render and Upload each carry their own definitive failure signal now —
    // RenderJob.status (renderStageStatus) and Publication.status
    // (uploadStageStatus) — so if either fired, the fallback below must not
    // also flag some other stage just because it happens to be the next
    // incomplete one in the list. This used to be render-only: `upload` was
    // derived from "does a Publication row exist", which reads a *failed*
    // publish (publish.service.ts creates the row before the upload as its
    // concurrency claim, and never deletes it, only flips its status to
    // FAILED — see uploadStageStatus's own comment) as done, silently
    // routing every publish failure into this fallback instead. With
    // `uploadStageStatus` reading the row's actual status, that
    // misattribution is now the same as render's: it can't happen, because
    // `hasRowLevelFailure` catches it first.
    const hasRowLevelFailure = stages.some((stage) => stage.status === "failed");

    if (video.status === "FAILED" && !hasRowLevelFailure) {
      // Neither stage with its own row-level signal fired, so this is some
      // other, less common way a video ended up FAILED — attribute it to the
      // first stage that never finished. `metadata` and `thumbnail` are
      // excluded from this scan (see `OPTIONAL_STAGE_KEYS`): either can
      // legitimately still be `pending` on a `FAILED` video for reasons that
      // have nothing to do with why it failed, and attributing the failure
      // to one of them would bury the real cause.
      const failedIndex = stages.findIndex(
        (stage) => stage.status !== "done" && !OPTIONAL_STAGE_KEYS.has(stage.key),
      );
      if (failedIndex !== -1) {
        stages[failedIndex] = { ...stages[failedIndex], status: "failed" };
      }
    }

    // A terminal video (per the original, status-only sense — `isTerminal`
    // itself is `false` while `isFinalizing`, so this deliberately re-checks
    // the status directly rather than reading `isTerminal`) has had its one
    // automatic chance at every optional stage. One still `pending` here
    // means either it ran and produced nothing (both services swallow their
    // own errors) or this video predates the feature — `skipped` covers both
    // without claiming to know which, and reads as "this isn't coming"
    // rather than "still waiting", which `pending` would otherwise imply
    // forever.
    if (TERMINAL_STATUSES.has(video.status) && !isFinalizing) {
      for (const key of OPTIONAL_STAGE_KEYS) {
        const index = stages.findIndex((stage) => stage.key === key);
        if (index !== -1 && stages[index].status === "pending") {
          stages[index] = {
            ...stages[index],
            status: "skipped",
            detail: key === "metadata" ? "no metadata was generated" : "no thumbnail was generated",
          };
        }
      }
    }

    return {
      videoId: video.id,
      stages,
      progress: renderJob?.progress ?? null,
      elapsedSeconds,
      isTerminal,
      isFinalizing,
      isActive,
      isFailed: video.status === "FAILED",
      attempts: video.attempts,
      maxAttempts: MAX_ATTEMPTS,
      attemptsExhausted: video.attempts >= MAX_ATTEMPTS,
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
