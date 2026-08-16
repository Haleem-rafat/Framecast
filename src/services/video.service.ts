import "server-only";

import type { VideoFormat, VideoStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { deleteShortFile } from "@/lib/shorts-storage";
import type { CreateVideoInput, RenarrateVideoInput } from "@/schemas/video.schema";

/** Shown whenever a delete is refused because the render worker holds the
 * video's lease right now — both the single- and bulk-delete paths report the
 * same reason, so an operator sees one consistent explanation everywhere. */
const ACTIVE_LEASE_MESSAGE =
  "This video is actively being processed by the render worker. Cancel it " +
  "first from the pipeline panel, then delete it once it's stopped.";

/**
 * True exactly when a worker holds this video's lease right now.
 * `GENERATING`/`RENDERING` alone isn't enough — a lapsed `leaseExpiresAt` on
 * either status means the worker that claimed it died (see
 * `job.service.ts`'s own doc comments on leases), and that video is
 * deletable like any other. Only a lease still in the future means a worker
 * process may be mid-write to this video's rows right now.
 */
function isActivelyLeased(
  video: { status: string; leaseExpiresAt: Date | null },
  now: Date,
): boolean {
  return (
    (video.status === "GENERATING" || video.status === "RENDERING") &&
    video.leaseExpiresAt !== null &&
    video.leaseExpiresAt > now
  );
}

export class VideoService {
  /**
   * The video list, optionally narrowed to one status.
   *
   * `status` is applied here rather than by the caller filtering the returned
   * array: `@@index([userId, status, deletedAt])` already exists and matches
   * this predicate exactly, so the filtered read is an index scan that returns
   * only the rows the page will render, instead of every video the operator
   * has ever made followed by a discard in JavaScript.
   */
  async list(userId: string, status?: VideoStatus) {
    return prisma.video.findMany({
      where: { userId, deletedAt: null, ...(status ? { status } : {}) },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        topic: true,
        status: true,
        // The list has a Format column now. One more scalar off a row the
        // query already reads — a video's shape is not something an operator
        // should have to open a video to find out, and a list of twenty where
        // three are vertical is exactly where it matters.
        format: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        // `channel` here is Gate 2's "which channel does this publish to"
        // answer — the publish confirmation dialog names it rather than
        // making the operator guess. Only `id`/`title` selected: never the
        // token columns (see channel.service.ts's SUMMARY_SELECT for the
        // same discipline).
        //
        // `brand.madeForKids` joins them because the same dialog states the
        // audience declaration this publish is about to send. Read here, on a
        // query the page already makes, rather than as a second
        // `brandService` round trip: the brand row is optional, so a channel
        // that has never been branded arrives as `brand: null` and the page
        // falls back to `PUBLISHING_DEFAULTS` — the same answer
        // `brandService.resolve` gives the upload itself.
        project: {
          select: {
            id: true,
            name: true,
            channel: {
              select: {
                id: true,
                title: true,
                brand: { select: { madeForKids: true, footageStyle: true } },
              },
            },
          },
        },
        // `select`, not `include`. An `include` here pulled every column of
        // every `ScriptVersion` — `content`, `prompt`, `cues` and `sources`
        // are all large, and the history list renders none of them. On a
        // video regenerated eight times that was 65kB fetched to draw eight
        // one-line rows totalling 376 bytes, and because `VersionHistory` is
        // a client component the whole 65kB was serialised into the RSC
        // payload and shipped to the browser as well.
        //
        // The two consumers want different shapes, so they get different
        // selects: `ScriptPanel` loads `activeVersion.content` into its
        // editor and genuinely needs it; `VersionHistory` renders only the
        // five fields below.
        script: {
          select: {
            activeVersionId: true,
            versions: {
              orderBy: { version: "desc" },
              select: {
                id: true,
                version: true,
                wordCount: true,
                createdAt: true,
                model: true,
              },
            },
            activeVersion: {
              select: {
                id: true,
                content: true,
                version: true,
                wordCount: true,
              },
            },
          },
        },
        statusEvents: { orderBy: { createdAt: "desc" }, take: 10 },
        // Most recent attempt only — a retried render leaves earlier FAILED
        // rows behind (see RenderService.render), and only the latest one
        // can have the outputUrl the preview cares about.
        renderJobs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outputUrl: true },
        },
        // `voiceId`/`voiceName` join the two the preview already needed, for
        // the control that offers to change them: the picker on the video page
        // preselects the voice this narration was actually made in, which is a
        // fact about the recorded narration rather than about the channel —
        // the channel's voice may well have been changed since.
        voiceOver: {
          select: {
            audioUrl: true,
            durationSeconds: true,
            voiceId: true,
            voiceName: true,
          },
        },
        // How many shorts a re-narration would discard, stated in its dialog
        // before the click. A count rather than the rows: the shorts panel
        // below loads the real list inside its own Suspense boundary, and this
        // is one aggregate on a query the page already makes.
        _count: { select: { shorts: true } },
        // `Publication` is `@unique` on `videoId` (Gate 2's claim row, see
        // publish.service.ts) — at most one, so a direct `include` here is
        // enough to show the operator the real result once PUBLISHED.
        publication: {
          select: { youtubeVideoId: true, status: true, error: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    return video;
  }

  /**
   * `options.seriesId` records which show commissioned this video, and is
   * deliberately not part of `CreateVideoInput`.
   *
   * That type is parsed from a server action's payload, so a field on it is a
   * field a hand-crafted POST can set — and this one names a `Series` row whose
   * ownership the caller has already proven. It arrives as a second argument
   * instead, which no request can reach. Absent means what it has always meant:
   * a video that belongs to no series, which is every video the create dialog
   * and the guided flow make.
   */
  async create(
    userId: string,
    input: CreateVideoInput,
    options: { seriesId?: string } = {},
  ) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    return prisma.$transaction(async (tx) => {
      const video = await tx.video.create({
        data: {
          userId,
          projectId: project.id,
          title: input.title,
          topic: input.topic,
          seriesId: options.seriesId ?? null,
        },
      });

      await tx.videoStatusEvent.create({
        data: { videoId: video.id, to: "DRAFT", message: "Video created" },
      });

      return video;
    });
  }

  /**
   * Gate 1. Approving costs nothing yet — it only makes the video eligible for
   * the expensive stages, which is precisely why the gate sits here.
   *
   * `format` is written here and nowhere else, and this is the only moment it
   * can be chosen. Every stage after this reads it: the narration is the same
   * either way, but the footage is framed for it, the captions are sized for
   * it, and the frame FFmpeg composes into is it. A video whose format changed
   * halfway would have clips normalised into one shape sitting in a concat list
   * the assemble pass is joining at another, which FFmpeg would refuse — and
   * changing it after a render would mean paying for the whole pipeline again,
   * which is a new video, not an edit. It defaults to LANDSCAPE so a caller
   * that does not care (the tests that approve a fixture, `script.service`'s
   * own) gets exactly the behaviour that existed before formats did.
   */
  async approveScript(
    userId: string,
    id: string,
    format: VideoFormat = "LANDSCAPE",
  ) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        script: { select: { activeVersion: { select: { content: true } } } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "DRAFT") {
      throw new ConflictError(
        `Only draft videos can be approved. This one is ${video.status.toLowerCase()}.`,
      );
    }

    if (!video.script?.activeVersion?.content.trim()) {
      throw new ConflictError("Generate a script before approving.");
    }

    await prisma.$transaction(async (tx) => {
      // The reads above exist only to produce a precise error message. The
      // actual guard against a concurrent double-approval is this conditional
      // update: two callers can both read DRAFT, but the `status: "DRAFT"`
      // clause means only one of their updates can match the row, so only one
      // can go on to append the QUEUED event below.
      const { count } = await tx.video.updateMany({
        where: { id, userId, deletedAt: null, status: "DRAFT" },
        data: { status: "QUEUED", format },
      });

      if (count === 0) {
        throw new ConflictError("Only draft videos can be approved.");
      }

      await tx.videoStatusEvent.create({
        data: {
          videoId: id,
          from: "DRAFT",
          to: "QUEUED",
          // The format is named in the event, not only in the column. This is
          // the append-only record of what the operator asked for, and "which
          // shape did I approve this as" is exactly the question asked later of
          // a video whose render nobody is happy with.
          message:
            format === "VERTICAL"
              ? "Script approved by operator — vertical short (1080×1920)"
              : "Script approved by operator — full video (1920×1080)",
        },
      });
    });
  }

  /**
   * Throws this video's narration away and queues it to be synthesised again
   * in a different voice.
   *
   * ## Why this is a re-run and not a setting
   *
   * Narration is generated once and everything downstream is derived from it.
   * ElevenLabs returns a character-level alignment alongside the audio; that
   * alignment is what places every caption (`buildSrt`), what converts each
   * script cue's character offset into a second (`cueWindows`), and therefore
   * what decides how long each section's clip holds the screen
   * (`sectionDurations` in render.service.ts). A different voice speaks at a
   * different rate, so a new narration means a new alignment, new caption
   * timings, new clip slots and a new render. Writing a voice id onto a row
   * and leaving it there would produce a video whose audio is one voice and
   * whose captions are timed to another — which looks entirely healthy in a
   * status column.
   *
   * So this method does not narrate anything. It records the choice
   * (`renarrateVoiceId`) and puts the video back in the queue; the worker
   * runs the same `runPipeline` it always runs, and the stages rebuild
   * themselves in order. What each one does with a changed narration is
   * documented on `runPipeline` — in short: narration and its alignment are
   * regenerated, the footage this video already collected is *re-timed* by the
   * render rather than re-collected (clips are chosen by script cue text,
   * which has not changed), and the render is redone because the video is no
   * longer `READY` and cannot skip.
   *
   * ## What it refuses, and why each one is its own sentence
   *
   * - **Published.** The file on YouTube cannot be replaced by re-rendering
   *   locally — there is no re-upload path (see publish.service.ts) — and
   *   publishing already reclaimed the render and the clips this would need.
   * - **Held by a worker.** A live lease means a process is mid-write to this
   *   video's rows right now. Requeuing it would be fighting the worker for a
   *   row it is holding, so the operator is asked to cancel first, exactly as
   *   `remove` asks.
   * - **No narration yet.** Nothing to replace. This is not a failure state,
   *   it is a video that simply has not run, and the answer is to run it.
   *
   * ## Its shorts
   *
   * Deleted, files included, in the same transaction. A `Short` stores its
   * window in *seconds of this video's timeline* and its captions are sliced
   * out of the alignment at render time (`sliceAlignment`), so both of its
   * two defining properties are measured against the narration that is about
   * to be replaced. Left alone, they would keep a READY status and a playable
   * file whose voice is not the video's any more — the same silent-wrongness
   * this whole method exists to avoid, one level down. Marking them stale
   * instead was considered and rejected: `ShortsService.generate` already
   * hard-deletes and replaces the set for exactly this reason (see the `Short`
   * model's own comment on why it has no `deletedAt`), and a second, weaker
   * notion of "stale" would be a state every reader would have to learn.
   * The dialog states the count before the click, so it is never a surprise.
   *
   * A short with a `ShortPublication` cannot be reached here: shorts are only
   * ever uploaded in the same click as their parent video, which leaves that
   * video `PUBLISHED`, and a published video is refused above.
   *
   * ## Twice
   *
   * The read below only produces a precise error message. The guard is the
   * conditional update — `status` repeated from the read, plus the same lease
   * predicate `JobService.requeue` uses for a stranded video — so of two
   * clicks arriving together on a `READY` video only one can match the row,
   * and the other gets a clean conflict rather than a second queued run. The
   * claim discipline continues past this point without a gap: `claimNext`
   * lets exactly one worker take the queued video, and
   * `voiceOverService.generate` clears the request inside the transaction
   * that fulfils it, so it cannot be honoured twice even across a retry.
   */
  async requestRenarration(
    userId: string,
    id: string,
    input: RenarrateVideoInput,
  ): Promise<{ shortsRemoved: number }> {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        leaseExpiresAt: true,
        voiceOver: { select: { voiceId: true } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const now = new Date();

    if (video.status === "PUBLISHED") {
      throw new ConflictError(
        "This video is already on YouTube, and nothing here can replace the file " +
          "that is up there — publishing is one-shot, and it reclaimed this " +
          "video's render and footage to free the disk. Re-narrating it would " +
          "produce a second, different video: make one and upload it as its own " +
          "video if that is what you want.",
      );
    }

    // Lease-based rather than status-based, and wider than `GENERATING`/
    // `RENDERING` on purpose: `render.service.ts` commits `READY` the moment
    // the encode succeeds while `runPipeline` is still running metadata and
    // thumbnail behind it, holding the lease throughout (see
    // `PipelineState.isFinalizing`). A `READY` video with a live lease is
    // therefore still a video a worker is inside, and requeuing it would have
    // that worker's own `release` overwrite the status this write just set.
    if (video.leaseExpiresAt !== null && video.leaseExpiresAt > now) {
      throw new ConflictError(
        "The render worker is holding this video right now, and re-narrating it " +
          "would pull it out from under a run that is already in progress. " +
          "Cancel it from the pipeline panel, wait for it to stop, then change " +
          "the voice.",
      );
    }

    if (!video.voiceOver?.voiceId) {
      throw new ConflictError(
        "This video has no narration yet, so there is nothing to replace. Run " +
          "the pipeline — it narrates in this channel's voice, which you can " +
          "change on the channel's branding screen first if you want a " +
          "different one from the start.",
      );
    }

    // `DRAFT` has no narration and is already refused above. Everything else
    // that survives to here — `QUEUED`, `FAILED`, and an unleased `READY` —
    // is a video nothing is touching, whose narration exists, and which the
    // worker can pick up again.
    if (
      video.status !== "QUEUED" &&
      video.status !== "READY" &&
      video.status !== "FAILED" &&
      video.status !== "GENERATING" &&
      video.status !== "RENDERING"
    ) {
      throw new ConflictError(
        `Only a finished or stopped video can be re-narrated. This one is ${video.status.toLowerCase()}.`,
      );
    }

    // The name is not independently settable: it describes the id, and a
    // request carrying somebody else's name would have the narration library
    // print the wrong one against the new audio. Normalised here, at the
    // write, exactly as `BrandService.updateBranding` normalises the same
    // pair — the schema can bound both strings but cannot know one is
    // meaningless without the other.
    const voiceId = input.voiceId;
    const voiceName = input.voiceName ?? null;

    const shorts = await prisma.short.findMany({
      where: { videoId: id },
      select: { outputPath: true },
    });

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.video.updateMany({
        where: {
          id,
          userId,
          deletedAt: null,
          status: video.status,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "QUEUED",
          renarrateVoiceId: voiceId,
          renarrateVoiceName: voiceName,
          leaseExpiresAt: null,
          // Requeuing is the operator asking for this video to run, which is
          // by definition a withdrawal of any earlier cancel — the same
          // reasoning, and the same write, as `JobService.requeue`.
          cancelRequestedAt: null,
          // Reset, like `JobService.retry` and not like `start`: this is a
          // deliberate operator action on a video that may have exhausted its
          // three automatic attempts, and refusing to run it because of
          // failures that happened before the voice changed would leave a
          // Change-voice button that queues a video nothing will ever claim.
          attempts: 0,
          // Deliberately NOT cleared: `generatedTitle`, `generatedDescription`,
          // `tags` and the thumbnail. All four are derived from the script,
          // not from the narration, and `runPipeline` re-runs both optional
          // stages unconditionally anyway — so clearing them would only widen
          // the window where a video that is already publishable has no title.
        },
      });

      if (count === 0) {
        throw new ConflictError("The video's status changed unexpectedly.");
      }

      // Hard delete, per the `Short` model's own comment: a soft-deleted row
      // would keep occupying its `(videoId, index)` slot and block the next
      // generation while being filtered out of every read.
      await tx.short.deleteMany({ where: { videoId: id } });

      await tx.videoStatusEvent.create({
        data: {
          videoId: id,
          from: video.status,
          to: "QUEUED",
          message: `Re-narrating in ${voiceName ?? voiceId}`,
        },
      });

      await tx.activityLog.create({
        data: {
          userId,
          action: "video.renarrate",
          entityType: "Video",
          entityId: id,
          message:
            `Queued a re-narration in ${voiceName ?? voiceId}` +
            (shorts.length > 0
              ? `, discarding ${shorts.length} short${shorts.length === 1 ? "" : "s"} cut from the old narration`
              : ""),
        },
      });
    });

    // After the transaction commits, not inside it: a rolled-back transaction
    // must not leave the operator's shorts playable-in-name-only with their
    // files already deleted. Best-effort — an orphaned file costs disk, a
    // throw here would cost a re-narration that has already been queued. Same
    // arrangement, for the same reasons, as `ShortsService.generate`.
    for (const short of shorts) {
      if (short.outputPath) {
        await deleteShortFile(short.outputPath).catch(() => {});
      }
    }

    return { shortsRemoved: shorts.length };
  }

  /**
   * Soft delete: sets `deletedAt`, matching every other domain entity (see
   * schema.prisma's top comment). The row — and everything Cascade-deletes
   * off it transitively (script, voice-over, scenes, render jobs,
   * publication, status events) — stays in Postgres, just excluded from
   * every `deletedAt: null` query from here on. The render under
   * `RENDER_ROOT` and any stored scene assets are deliberately left in
   * place: destroying the underlying files here would make this exactly as
   * unrecoverable as a hard delete, which defeats the point of soft
   * deleting at all. Deleting Framecast's record of a video never touches
   * YouTube either — there is no unpublish path (see
   * `publish.service.ts`'s own doc comment) — so a published video's
   * upload stays live at its original link after this.
   *
   * Refused while the render worker actively holds the video: a
   * `leaseExpiresAt` still in the future on a `GENERATING`/`RENDERING`
   * video means a worker process has it claimed right now and may be
   * mid-write to its rows. Deleting out from under that is a
   * use-after-free on the DB row, not a UI nicety to skip — the operator
   * needs to cancel it first (`JobService.requestCancel`) and let the
   * worker's next heartbeat actually stop it.
   */
  async remove(userId: string, id: string): Promise<void> {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, status: true, leaseExpiresAt: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const now = new Date();

    if (isActivelyLeased(video, now)) {
      throw new ConflictError(ACTIVE_LEASE_MESSAGE);
    }

    // Same shape as every other conditional-update guard in this codebase
    // (see `approveScript` above, or `JobService.requeue`): the read above
    // only produces a precise error message, this `NOT` clause is what
    // actually stops a worker that claims the video in the instant between
    // that read and this write from having its row deleted under it.
    const { count } = await prisma.video.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
        NOT: {
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      },
      data: { deletedAt: now },
    });

    if (count === 0) {
      throw new ConflictError(ACTIVE_LEASE_MESSAGE);
    }
  }

  /**
   * Bulk cleanup for the video list's multi-select — see `remove` for what a
   * delete actually does. A single conditional `updateMany` rather than a
   * loop of `remove` calls: `ids` comes straight off the operator's own
   * checked rows, already scoped to their own visible list, so there is no
   * per-row message worth computing — only how many landed. Any id that
   * doesn't match (someone else's, already deleted, or actively leased —
   * see `remove`'s own doc comment) is silently skipped rather than failing
   * the whole batch, and reported back only as a count.
   */
  async removeMany(
    userId: string,
    ids: string[],
  ): Promise<{ deletedCount: number; skippedCount: number }> {
    if (ids.length === 0) {
      return { deletedCount: 0, skippedCount: 0 };
    }

    const now = new Date();
    const { count } = await prisma.video.updateMany({
      where: {
        id: { in: ids },
        userId,
        deletedAt: null,
        NOT: {
          status: { in: ["GENERATING", "RENDERING"] },
          leaseExpiresAt: { gt: now },
        },
      },
      data: { deletedAt: now },
    });

    return { deletedCount: count, skippedCount: ids.length - count };
  }
}

export const videoService = new VideoService();
