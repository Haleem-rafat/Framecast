import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { PublishStatus, PublishVisibility } from "@/generated/prisma/enums";
import { deleteRenderFile, getRenderFile, RenderFileMissingError } from "@/lib/render-storage";
import { ConflictError, InternalError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getShortFile } from "@/lib/shorts-storage";
import { getObject, objectContentType, removeObjects } from "@/lib/storage";
import { clampDescription, clampTitle } from "@/lib/youtube-limits";
import { brandService } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";

/** Injectable so tests never make a real call to YouTube. */
export type FetchLike = typeof fetch;

/** Postgres unique-violation code — `Publication.videoId` is `@unique`, so a
 * second concurrent claim's `create()` fails with this rather than data
 * corruption. Same constant/check `script.service.ts` uses for its own
 * unique-constraint race. */
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * YouTube's daily quota resets at midnight **Pacific Time**, not at midnight
 * wherever the operator or the server happens to be — see "Quota usage" in the
 * Data API's getting-started guide. Named here because the one thing an
 * operator needs when they hit the limit is when it lifts, and "tomorrow" is
 * the wrong answer for anyone east of California in the evening.
 */
const QUOTA_RESET_ZONE = "America/Los_Angeles";

/**
 * Whole hours until the next midnight Pacific, rounded up and never less than
 * one — "in about 0 hours" reads as "right now", which is exactly what a
 * quota-exceeded message must not imply.
 *
 * Exported for the test that pins the arithmetic; nothing else calls it.
 */
export function hoursUntilQuotaReset(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUOTA_RESET_ZONE,
    hour: "numeric",
    minute: "numeric",
    // h23, not the default h12: this is arithmetic, and "12 AM" parses to 12.
    hourCycle: "h23",
  }).formatToParts(now);

  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return Math.max(1, Math.ceil(24 - value("hour") - value("minute") / 60));
}

/**
 * The 403 that means "you are out of uploads for today", separated from every
 * other 403 because it is the only one where waiting is the fix.
 *
 * The numbers, verified against Google's own documentation rather than the
 * figure this codebase used to carry: a project gets **100 `videos.insert`
 * calls per day** in a bucket of their own (each call costs 1 unit of it),
 * alongside 100 `search.list` calls and 10,000 units per day shared by every
 * other endpoint — `thumbnails.set`, at 50 units, spends that second pool. The
 * often-quoted "1,600 units per upload, so six videos a day" was true until
 * **4 December 2025**, when the revision history records the cost of a video
 * upload dropping "from approximately 1600 units to approximately 100 units";
 * the quota tables now describe uploads as their own 100-a-day allocation. A
 * video plus three shorts is four of those hundred, not most of a day's budget.
 *
 * A `ProviderError` subclass rather than a new `AppErrorCode`, so it serialises
 * as PROVIDER_ERROR and reaches the dialog with its own sentence intact — the
 * button matches on that sentence, the same way it already distinguishes the
 * "assign a channel" conflict from every other conflict.
 *
 * Not retryable: `retryable` means "worth re-queueing now", and nothing about
 * this is worth re-queueing before the reset.
 */
export class YouTubeQuotaError extends ProviderError {
  constructor(what: string, now: Date = new Date()) {
    const hours = hoursUntilQuotaReset(now);
    super(
      "YOUTUBE",
      `YouTube's daily upload allowance for this project is used up, so ${what} ` +
        `could not be uploaded. The allowance is 100 uploads a day and it resets ` +
        `at midnight Pacific Time — about ${hours} hour${hours === 1 ? "" : "s"} ` +
        `from now. Nothing retries automatically.`,
      false,
    );
  }
}

/** What one short's upload did, recorded per short so the operator can see
 *  which of three succeeded rather than a single verdict for all of them. */
export interface ShortPublishOutcome {
  shortId: string;
  /** 0-based, the same number the panel lists them by — the UI shows
   *  `index + 1`. */
  index: number;
  /** What was actually sent to YouTube, so a success line names the clip the
   *  operator will find on the channel. */
  title: string;
  youtubeVideoId: string | null;
  /** Null on success. On failure, a complete sentence safe to show verbatim —
   *  including "this was never attempted", for the shorts after one that ran
   *  the daily allowance out. */
  error: string | null;
}

export interface PublishResult {
  youtubeVideoId: string;
  /**
   * One entry per short this publish tried, in play order. Empty when the
   * operator did not tick the box — which is the default — and empty when they
   * did but the video has no READY, unpublished shorts left.
   */
  shorts: ShortPublishOutcome[];
}

/**
 * Everything about a publish that is the caller's decision rather than a
 * fact derived from the video. `visibility` defaults to `"PRIVATE"` when
 * omitted — see the doc comment on `uploadToYouTube` for why the default
 * changed from an unconditional `"unlisted"` to something a caller actually
 * chooses.
 *
 * `scheduledFor` is only accepted together with `visibility: "PUBLIC"`, and
 * `publish()` refuses any other combination. YouTube's `status.publishAt` is
 * not a "become whatever was asked for, later" field: it is only valid
 * alongside `privacyStatus: private`, and when the timestamp arrives YouTube
 * makes the video **public**, unconditionally. Scheduling to unlisted is not
 * something the API can express at all. See `uploadToYouTube` for the full
 * account and `publish()` for why the refusal is a refusal.
 */
export interface PublishOptions {
  visibility?: PublishVisibility;
  playlistId?: string;
  scheduledFor?: Date;
  /**
   * Upload this video's READY shorts in the same call. Defaults to **false**,
   * and every caller has to say so explicitly.
   *
   * The default is the whole of the safety argument. Shorts used to be
   * unpublishable by construction (see the `ShortStatus` comment in
   * schema.prisma, which used to say so and now says what is true instead);
   * lifting that constraint keeps its intent only if nothing reaches YouTube
   * that the operator did not tick a box for. An option defaulting to `true`
   * would silently publish four videos for every caller written against the
   * old signature.
   */
  includeShorts?: boolean;
}

/**
 * Pixabay's terms require crediting them wherever their footage is used.
 * `footage.service.ts` never records that on the Asset itself, so this is
 * unconditional here rather than derived from which clips actually landed in
 * the render — "the operator will remember" is not a mitigation.
 */
const PIXABAY_CREDIT = "Video clips courtesy of Pixabay (https://pixabay.com).";

/** A line that is alone on it, optionally followed by a colon, starts the
 * script's sources section. Scripts are plain text with no other structural
 * markup to key off, so this heading is the one convention available. */
const SOURCES_HEADING = /^[ \t]*SOURCES[ \t]*:?[ \t]*$/im;

/**
 * Sources normally run to the end of the script, so everything from the
 * heading on is taken rather than trying to detect where the section ends.
 *
 * This is the *legacy* path and stays that way. It only ever matches a script
 * whose content has line breaks, which a generated script no longer has:
 * gateway.provider.ts builds `content` by joining the model's sections with a
 * single space, so the heading can never be alone on a line. Hand-written and
 * pre-sections scripts still have their citations inline and nowhere else,
 * which is the only reason to keep looking here at all — see
 * `ScriptVersion.sources` for where a generated script's citations live now.
 */
export function extractSourcesSection(scriptContent: string): string {
  const match = SOURCES_HEADING.exec(scriptContent);
  return match ? scriptContent.slice(match.index).trim() : "";
}

/** The heading the stored-sources block is published under, so a description
 *  built from `ScriptVersion.sources` reads the same as one lifted out of an
 *  older script's inline section. */
function formatSources(sources: readonly string[]): string {
  return ["SOURCES", ...sources.map((source) => `- ${source}`)].join("\n");
}

/**
 * Citations come from one of two places, and stored sources win.
 *
 * A generated script's `content` is a single line of narration with the
 * citations deliberately kept out of it (they would otherwise be read aloud —
 * see gateway.provider.ts's schema), so `storedSources` is the only place they
 * exist for anything generated since that column landed. Falling back to
 * `extractSourcesSection` is what keeps an older, hand-written script's
 * inline SOURCES block publishable rather than quietly dropping it.
 */
export function buildDescription(
  scriptContent: string | null | undefined,
  /** `ScriptVersion.sources` — the citations the model returned, held apart
   *  from the narration. Null/absent for scripts written before the column
   *  existed. */
  storedSources?: readonly string[] | null,
  /** Written by MusicService at collection time. Absent when the video
   *  rendered without music — see MusicService.collect. */
  musicCredit?: string | null,
): string {
  const sources = storedSources?.length
    ? formatSources(storedSources)
    : scriptContent
      ? extractSourcesSection(scriptContent)
      : "";

  return [sources, PIXABAY_CREDIT, musicCredit].filter(Boolean).join("\n\n");
}

/** `ScriptVersion.sources` is a JSON column, so what comes back is
 *  `JsonValue`. Anything that is not an array of strings — a legacy row, a
 *  hand-edited one — is treated as "no stored sources" and leaves the
 *  inline-section fallback to run. */
function readStoredSources(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;
}

/**
 * Gate 2. This is the control that stops Framecast publishing on its own —
 * everything upstream only ever produces a video that is *eligible* to
 * upload; this is the one place the upload itself happens, and it refuses
 * unless a human has already moved the video to READY via a finished render.
 *
 * Retries after a failed upload: intentionally require clearing the row, not
 * automatic. A `FAILED` `Publication` is left in place rather than deleted
 * (see the failure branch of `publish()`), and `Publication.videoId` being
 * `@unique` means that row blocks a second `create()` regardless of its
 * status. Calling `publish()` again for the same video will therefore fail
 * with a unique-constraint violation even though the underlying issue may
 * have been fixed. That's deliberate: this method has no reclaim logic for
 * a `FAILED` row, so nothing here can silently re-fire an upload the moment
 * it's called twice — a real retry needs a separate, explicit action (not
 * built by this task) that resets or removes the failed row first. Trading
 * "no built-in retry yet" for "no accidental retry storm."
 *
 * Shorts ride along, but only when asked. `opts.includeShorts` — false unless a
 * caller sets it, and set only by the dialog's checkbox, which is itself
 * unticked by default — uploads this video's READY shorts in the same call, one
 * per YouTube video of their own. Everything above applies to each of them
 * separately: a claim row taken before any byte is sent (`ShortPublication`,
 * `shortId` `@unique`), a FAILED row kept rather than deleted, and no retry.
 * What does *not* cross between them is failure: the shorts are uploaded after
 * the video's own publish has committed, and `publishShorts` cannot throw, so
 * the video's outcome is decided before the first clip is read off disk. Gate 2
 * is unchanged by all of this — nothing publishes without a click.
 */
export class PublishService {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async publish(
    userId: string,
    videoId: string,
    opts: PublishOptions = {},
  ): Promise<PublishResult> {
    const visibility: PublishVisibility = opts.visibility ?? "PRIVATE";

    // Scheduling is only honest for PUBLIC, so anything else is refused
    // rather than accepted and quietly reinterpreted.
    //
    // YouTube's `status.publishAt` is valid only alongside `privacyStatus:
    // private`, and what it does at the timestamp is make the video public.
    // It carries no visibility of its own — there is no "schedule this to
    // become unlisted" in the Data API, and no combination of fields that
    // expresses one. So a caller asking to schedule an UNLISTED (or PRIVATE)
    // publish is asking for something the platform cannot do.
    //
    // The three available answers were: silently upgrade it to public,
    // silently ignore `scheduledFor` and publish immediately at the requested
    // visibility, or refuse. Refusing is the only one that doesn't lie.
    // Publishing public when unlisted was asked for is unrecoverable from
    // this app — there is no unpublish path (see this class's doc comment) —
    // and it is precisely the failure the `Publication.visibility` column
    // would go on recording as UNLISTED, so nothing downstream would ever
    // reveal the discrepancy either. Ignoring `scheduledFor` is milder but
    // still publishes a video *now* that the caller explicitly asked to hold
    // back until later. A ConflictError costs the caller one round trip and
    // tells them exactly which of the two things they asked for has to give.
    //
    // Nothing in the app reaches this yet: `publish.action.ts` passes no
    // `scheduledFor` at all. It is the CLI and whatever schedules publishes
    // later that this is waiting for.
    if (opts.scheduledFor && visibility !== "PUBLIC") {
      throw new ConflictError(
        `A scheduled publish always goes live as public — YouTube's publishAt ` +
          `field cannot schedule anything else, and there is no way to schedule ` +
          `a video to become ${visibility.toLowerCase()}. Ask for PUBLIC to ` +
          `schedule it, or drop the schedule to publish it ${visibility.toLowerCase()} now.`,
      );
    }

    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        title: true,
        generatedTitle: true,
        generatedDescription: true,
        tags: true,
        status: true,
        // Read purely to detect the finalizing window — see the refusal
        // below, and `PipelineState.isFinalizing` in pipeline.service.ts for
        // the same signal read for the same reason.
        leaseExpiresAt: true,
        project: { select: { channelId: true } },
        script: {
          select: { activeVersion: { select: { content: true, sources: true } } },
        },
        renderJobs: {
          where: { status: "SUCCEEDED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outputUrl: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "READY") {
      throw new ConflictError(
        `Only videos in READY can be published. This one is ${video.status.toLowerCase()}.`,
      );
    }

    // READY is necessary but not sufficient, and this is the gap between the
    // two. `render.service.ts` commits READY inside its own transaction the
    // moment the encode succeeds, but `runPipeline` (pipeline-runner.ts) then
    // goes on to run the `metadata` and `thumbnail` stages behind that status
    // — an Anthropic call, an image generation and an FFmpeg composite, 30-60
    // seconds during which `generatedTitle`, `tags` and the `Thumbnail` row
    // this method reads all still land. Publishing inside that window uploads
    // the operator's placeholder title with no tags and no thumbnail, and
    // because a `Publication` row permanently blocks a retry (see this
    // class's own doc comment) there is no second chance at it afterwards.
    //
    // The signal is `Video.leaseExpiresAt`, exactly as `isFinalizing` defines
    // it in pipeline.service.ts: the worker — or the CLI's direct lease —
    // holds and renews that lease for the whole of `runPipeline`, releasing it
    // only once every stage has resolved. So a live lease on a READY video is
    // proof those stages are still in flight, and a lapsed or absent one is
    // proof they have already had their single automatic chance.
    //
    // Enforced here rather than in `publish-video-button.tsx` on purpose. The
    // button is today's only way in, but it is not the only one this class is
    // built for — a CLI publish and a scheduled one are both anticipated by
    // `PublishOptions` — and a client-side gate would fail on its own terms
    // anyway: the client never sees `leaseExpiresAt`, and any check it could
    // make would be racing the same 30-60 second window it is supposed to
    // close. Nothing else re-derives this: the panel reads `isFinalizing` off
    // `PipelineState` for its own display purposes, and this is the
    // enforcement copy.
    if (video.leaseExpiresAt !== null && video.leaseExpiresAt.getTime() > Date.now()) {
      throw new ConflictError(
        "This video is still being finished off — its title, tags and thumbnail " +
          "are generated after the render completes, and publishing now would " +
          "upload it without them. Wait a moment and try again.",
      );
    }

    const outputUrl = video.renderJobs[0]?.outputUrl;
    if (!outputUrl) {
      throw new ConflictError(
        "This video has no completed render to publish.",
      );
    }

    const channelId = video.project?.channelId;
    if (!channelId) {
      throw new ConflictError(
        "Assign this video's project a channel before publishing.",
      );
    }

    // Unconditional, exactly like PIXABAY_CREDIT: the credit is derived from
    // what the render actually used, not from the operator remembering. Found
    // by storage prefix, the same scoping key render.service.ts queries by.
    const musicAsset = await prisma.asset.findFirst({
      where: {
        kind: "MUSIC",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { prompt: true },
    });

    // The sources/credits block is always computed — it's owed regardless of
    // whether MetadataService ever ran for this video — and then either
    // stands alone (today's behaviour, unchanged) or trails a generated
    // description. Prepending rather than replacing is what keeps a script's
    // citations and the Pixabay/music credits on every upload even after
    // Task 3 started writing `generatedDescription`.
    const sourcesAndCredits = buildDescription(
      video.script?.activeVersion?.content,
      readStoredSources(video.script?.activeVersion?.sources),
      musicAsset?.prompt,
    );
    // Clamped here rather than trusted from upstream, because only one of the
    // two branches has ever been clamped. `metadata.service.ts` runs
    // `clampTitle` over `generatedTitle` before storing it, but
    // `video.title` — the deliberate fallback for a video whose metadata
    // stage never ran or failed — comes straight from `createVideoSchema`,
    // which permits 120 characters against YouTube's cap of 100.
    //
    // An over-limit title is not a cosmetic problem on this path: `videos.insert`
    // answers with a 400 *after* the whole file has been sent, the failure
    // branch below marks the video FAILED, and the `Publication` row it
    // deliberately leaves behind then blocks every retry (see this class's own
    // doc comment on retries). So a title 101 characters long would cost the
    // operator the video permanently, over something a trim fixes. Clamping is
    // idempotent, so running it over an already-clamped `generatedTitle` costs
    // nothing and means this call site — the only one that knows what is about
    // to be sent — needs no branch.
    const title = clampTitle(video.generatedTitle ?? video.title);

    // sourcesAndCredits goes *first*, generatedDescription second — the
    // reverse of "natural" reading order — specifically so that when the
    // combined text is over DESCRIPTION_MAX and clampDescription has to cut
    // something, the cut lands in the narration summary's tail rather than
    // in the Pixabay/music credit lines. Losing the end of a generated
    // summary is a cosmetic loss; losing an attribution those licenses
    // require is not. clampDescription always runs, even when there is no
    // generatedDescription: buildDescription's own output is not otherwise
    // bounded (an unusually long SOURCES list is the only realistic way it
    // could exceed the limit), and this is the one call site that knows
    // what's about to be sent to YouTube. See youtube-limits.ts's doc
    // comment for why this is checked before the upload rather than
    // discovered from its 400 response after the bytes are already sent.
    const combinedDescription = video.generatedDescription
      ? [sourcesAndCredits, video.generatedDescription].filter(Boolean).join("\n\n")
      : sourcesAndCredits;
    const description = clampDescription(combinedDescription);

    // Language and category are the channel's, not this video's — a channel's
    // videos are written, narrated and categorised the same way every time —
    // and they are read here rather than at the upload call because
    // `brandService.resolve` is a database round trip and the claim below is
    // the point after which a failure costs the operator the video. Resolving
    // it before the claim keeps a brand lookup that hiccups from producing a
    // `FAILED` Publication row that then blocks every retry.
    //
    // `resolve()` cannot throw and cannot return null — a channel with no
    // brand row, a malformed one, or a failed lookup all come back as `en`
    // and `27` (see FALLBACK there, which mirrors the columns' own database
    // defaults), so an unbranded channel publishes exactly as it did before
    // these fields existed rather than not publishing at all.
    const brand = await brandService.resolve(channelId);

    // The gate itself, and it happens *before* the upload — not after, the
    // way the first draft of this method had it. `Publication.videoId` is
    // `@unique`, so this `create()` is the claim: two callers can both read
    // READY above, but only one's insert can land, so only one ever goes on
    // to call YouTube. The loser fails here with a unique-constraint
    // violation, never touches the network, and gets a ConflictError instead
    // of a data-corrupting double upload. Same claim-before-expensive-work
    // shape as RenderService.render()'s GENERATING -> RENDERING transition,
    // just claimed via the Publication row instead of the Video row because
    // VideoStatus has no intermediate value between READY and
    // PUBLISHED/FAILED to claim into.
    let publication;
    try {
      publication = await prisma.publication.create({
        data: {
          videoId,
          channelId,
          title,
          description,
          tags: video.tags,
          playlistId: opts.playlistId,
          visibility,
          scheduledFor: opts.scheduledFor,
          status: "UPLOADING",
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError("This video is already being published.");
      }
      throw error;
    }

    let youtubeVideoId: string;
    // Lifted out of the try block below (rather than declared with `const`
    // inside it) because `applyThumbnail` needs the same token afterwards,
    // once the video is already PUBLISHED — resolving a second token there
    // would be a second, redundant round trip for something already in hand.
    let accessToken: string;
    try {
      accessToken = await channelService.resolveAccessToken(userId, channelId);
      // Reads off local disk — see render-storage.ts. `getRenderFile`
      // returns `null` rather than throwing for a missing file (see its doc
      // comment); this is the one call site that turns that `null` into the
      // typed `RenderFileMissingError` the operator sees.
      const file = await getRenderFile(video.id, outputUrl);
      if (file === null) {
        throw new RenderFileMissingError(video.id);
      }
      // No Range header was sent above, so `parseRangeHeader` can never
      // return "unsatisfiable" here — this branch only exists to satisfy the
      // type checker that `file` below is genuinely `RenderFileContent`.
      if (file === "unsatisfiable") {
        throw new InternalError(
          `Unexpected unsatisfiable range reading the render for video ${video.id}.`,
        );
      }
      // YouTube's resumable upload needs the full byte length up front (see
      // uploadToYouTube's X-Upload-Content-Length below), so the stream is
      // buffered here rather than piped through — same memory tradeoff the
      // local-disk version made reading the whole file at once.
      //
      // THIS LINE IS WHY `app-prod` IS CAPPED AT 1024m AND NOT 512m.
      // publish() runs in the **app** process, not the worker —
      // `publishVideoAction` (src/actions/publish.action.ts) is a Server
      // Action — so this ~170MB allocation, whose transient peak is close to
      // double that while the chunks are concatenated, lands on top of the
      // 150-250MB a Next.js standalone server already holds. See
      // deploy/docker-compose.yml's `app-prod`/`app-staging` limits and
      // deploy/README.md's "Why `app-prod` gets 1024m" section before
      // trimming either number, and before assuming this buffer is free:
      // an OOM kill here is a SIGKILL, so the catch below never runs, the
      // `Publication` row created above stays `UPLOADING` forever, and every
      // retry gets ConflictError while YouTube may already hold the video.
      const fileBuffer = Buffer.from(await new Response(file.stream).arrayBuffer());
      youtubeVideoId = await this.uploadToYouTube(
        accessToken,
        {
          label: "this video",
          title,
          description,
          tags: video.tags,
          visibility,
          publishAt: opts.scheduledFor,
          language: brand.language,
          categoryId: brand.categoryId,
        },
        fileBuffer,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // The claim row is never deleted on failure — it's the record that an
      // attempt happened, and it's what stops a retry storm from firing
      // another upload immediately (see the module doc comment on retries).
      await prisma.$transaction(async (tx) => {
        await tx.publication.update({
          where: { id: publication.id },
          data: { status: "FAILED", error: message },
        });

        const { count } = await tx.video.updateMany({
          where: { id: videoId, userId, deletedAt: null, status: "READY" },
          data: { status: "FAILED", failureReason: message },
        });

        if (count > 0) {
          await tx.videoStatusEvent.create({
            data: { videoId, from: "READY", to: "FAILED", message },
          });
        }
      });

      throw error;
    }

    // The upload has landed on YouTube either way, but "landed" and "live"
    // are not the same thing for a scheduled publish: it went up `private`
    // with a future `publishAt` (see uploadToYouTube), so nobody can see it
    // yet. Recording Publication.status as PUBLISHED and stamping
    // `publishedAt: new Date()` here regardless would tell any dashboard or
    // analytics feature built on this table that a video scheduled for next
    // month already shipped today. `publishedAt` specifically means "when
    // this went live" — SCHEDULED with a null `publishedAt` is what keeps
    // that column honest until YouTube's own scheduler actually flips it.
    //
    // Video.status has no equivalent SCHEDULED value (see VideoStatus in
    // schema.prisma) and doesn't need one: from Framecast's side, the
    // video's lifecycle question is "has this been handed off to YouTube,"
    // which is unconditionally true the instant the upload succeeds — there
    // is no re-render or retry path for it either way (see this class's own
    // doc comment), scheduled or not. So Video.status still becomes
    // PUBLISHED here; only the Publication row — the one that actually
    // models a YouTube-side publish state — reflects the wait.
    const publicationStatus: PublishStatus = opts.scheduledFor ? "SCHEDULED" : "PUBLISHED";

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.video.updateMany({
        where: { id: videoId, userId, deletedAt: null, status: "READY" },
        data: { status: "PUBLISHED" },
      });

      if (count === 0) {
        throw new ConflictError(
          "The video's status changed unexpectedly while publishing completed.",
        );
      }

      await tx.videoStatusEvent.create({
        data: {
          videoId,
          from: "READY",
          to: "PUBLISHED",
          message: opts.scheduledFor
            ? `Uploaded to YouTube, scheduled to go live at ${opts.scheduledFor.toISOString()}`
            : "Published to YouTube",
        },
      });

      await tx.publication.update({
        where: { id: publication.id },
        data: {
          status: publicationStatus,
          youtubeVideoId,
          publishedAt: opts.scheduledFor ? null : new Date(),
        },
      });
    });

    // Deliberately outside the transaction above and after it has already
    // committed, for the same reason `reclaimClipStorage` below is: YouTube
    // has accepted the upload and the video is genuinely PUBLISHED at this
    // point, and `thumbnails.set` is a separate endpoint from `videos.insert`
    // — it can only be called once the video exists on YouTube to attach to,
    // which is precisely now. See `applyThumbnail`'s own doc comment for why
    // its failure can never unwind a publish that already succeeded.
    const thumbnailApplied = await this.applyThumbnail(accessToken, videoId, youtubeVideoId);
    // Best-effort, same shape as the failure-path writes above: a bookkeeping
    // column that fails to update must not throw past a publish that has
    // already succeeded, and the default (`false`) already describes the
    // operator-visible reality — "no thumbnail" — if this write is lost.
    await prisma.publication
      .update({ where: { id: publication.id }, data: { thumbnailApplied } })
      .catch(() => {});

    // The shorts, if the operator asked for them — after the video's own
    // publish has fully committed, and before either reclaim below.
    //
    // Order is deliberate on both sides. *After* the transaction, because the
    // video's publish either succeeded or it did not, and no number of failed
    // short uploads may turn a video that is live on YouTube into a FAILED row
    // (`publishShorts` cannot throw, for the same reason). *Before* the
    // reclaims, because those are the steps that start deleting things: a short
    // is cut from the render at *generate* time, not here — every READY short
    // already has its own independent file at `shorts/<shortId>.mp4` (see
    // shorts-storage.ts) and `reclaimRenderStorage` only removes
    // `renders/<videoId>.mp4`, so no short's bytes are at risk either way — but
    // sequencing the uploads ahead of the tidy-up keeps that true by
    // construction rather than by a reader checking two path prefixes.
    const shorts = opts.includeShorts
      ? await this.publishShorts({
          userId,
          videoId,
          channelId,
          accessToken,
          visibility,
          scheduledFor: opts.scheduledFor,
          tags: video.tags,
          language: brand.language,
          categoryId: brand.categoryId,
          sourcesAndCredits,
          videoTitle: title,
        })
      : [];

    // Deliberately outside the transaction above and after it has already
    // committed. YouTube has accepted the upload and the video is genuinely
    // PUBLISHED at this point; a storage hiccup while reclaiming clips must
    // never unwind that. See reclaimClipStorage's own doc comment for what
    // happens if this fails.
    await this.reclaimClipStorage(userId, videoId);

    // Same placement and the same reasoning as reclaimClipStorage above: the
    // transaction has committed, the video is genuinely PUBLISHED, and a
    // failure here must never unwind that. See reclaimRenderStorage's own
    // doc comment for why this runs here and nowhere else.
    await this.reclaimRenderStorage(userId, videoId, outputUrl);

    return { youtubeVideoId, shorts };
  }

  /**
   * How many of this video's shorts a publish would actually upload right now.
   *
   * READY only (a queued or failed short has no file), and only shorts with no
   * `ShortPublication` row — publishing a short is one-shot, so one that has
   * been uploaded is not offered again. Read by the video page to decide
   * whether the dialog shows the "also publish N shorts" control at all: zero
   * means the control is not rendered, rather than rendered disabled.
   *
   * The same `where` the upload loop uses, deliberately, so the number in the
   * dialog and the number that goes up cannot describe different sets. They can
   * still differ by *time* — a fourth short may finish encoding between the
   * page load and the click — and the outcome list is what reports what
   * actually happened.
   */
  async countPublishableShorts(userId: string, videoId: string): Promise<number> {
    return prisma.short.count({
      where: this.publishableShortsWhere(userId, videoId),
    });
  }

  private publishableShortsWhere(userId: string, videoId: string) {
    return {
      videoId,
      status: "READY",
      // Belt and braces: `renderShort` writes READY and `outputPath` in one
      // update precisely so the two cannot disagree, but this is the query
      // that decides whether bytes get read off disk.
      outputPath: { not: null },
      // One-shot: any row at all blocks a second attempt, FAILED included —
      // the same rule `Publication.videoId` enforces for the video.
      publication: { is: null },
      video: { userId, deletedAt: null },
    } satisfies Prisma.ShortWhereInput;
  }

  /**
   * Attaches the video's thumbnail on YouTube.
   *
   * Never throws, and deliberately runs outside the try/catch that marks a
   * video FAILED. By the time this is called the video is already on
   * YouTube: rolling that back is impossible, and failing a publish that
   * already succeeded over a thumbnail would be the wrong trade — the same
   * reasoning `reclaimClipStorage` below is built on.
   *
   * The most likely failure is not a bug. `thumbnails.set` returns 403 for a
   * channel that has not been verified, which is a property of the
   * operator's YouTube account that no amount of code here can satisfy — so
   * it is reported (via `Publication.thumbnailApplied`, updated by the
   * caller), not retried.
   *
   * `Content-Type` is read back from what `putObject` actually stored rather
   * than assumed: `ThumbnailVersion.imageUrl` is usually a composited JPEG,
   * but `ThumbnailService`'s fallback path (composite failed) stores the
   * image provider's raw bytes as-is, which may be PNG — see
   * `detectImageFormat` in thumbnail.service.ts. Sending `image/jpeg` for a
   * PNG body would not necessarily fail outright (YouTube may still decode
   * it), but there is no reason to rely on that when the true type is one
   * cheap `list()` call away. `objectContentType` returning `null` (it never
   * should for something `putObject` wrote, but the call is a network round
   * trip with its own failure modes) falls back to sniffing the object key's
   * extension, which `storeVersion` in thumbnail.service.ts always sets
   * correctly for exactly this reason.
   */
  private async applyThumbnail(
    accessToken: string,
    videoId: string,
    youtubeVideoId: string,
  ): Promise<boolean> {
    try {
      const thumbnail = await prisma.thumbnail.findUnique({
        where: { videoId },
        select: { activeVersion: { select: { imageUrl: true } } },
      });

      const objectPath = thumbnail?.activeVersion?.imageUrl;
      if (!objectPath) {
        // No thumbnail to apply — 50 units against the 10,000-a-day pool every
        // endpoint except uploads and search shares (uploads have their own
        // 100-a-day bucket; see `YouTubeQuotaError`), not worth spending on
        // nothing.
        return false;
      }

      const bytes = await getObject(objectPath);
      const contentType =
        (await objectContentType(objectPath)) ??
        (objectPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

      const response = await this.fetchImpl(
        `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${youtubeVideoId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": contentType,
          },
          body: bytes as unknown as BodyInit,
        },
      );

      if (!response.ok) {
        console.error(
          `Could not set the thumbnail for video ${videoId} ` +
            `(${response.status})` +
            (response.status === 403
              ? ": the YouTube channel is not verified, which custom thumbnails require."
              : "."),
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error(
        `Could not set the thumbnail for video ${videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  /**
   * Uploads this video's READY shorts, one at a time, and records what each one
   * did.
   *
   * Never throws. Every call site consequence of that is deliberate: this runs
   * after the video is already live on YouTube, so the *only* honest report is
   * "the video published, and here is what happened to each clip". A throw here
   * would surface to the operator as a failed publish for a video that plainly
   * succeeded, and — worse — the caller's `catch` is long gone by this point, so
   * there is nothing left that could mark anything FAILED coherently anyway.
   *
   * Sequential, not `Promise.all`. Each short is buffered whole into memory to
   * be sent (the same `X-Upload-Content-Length` constraint the video's own
   * upload has — see `publish()`), and tens of megabytes at a time is the
   * difference between one clip's buffer and three of them landing on top of a
   * 170MB one that has only just been released. Three uploads take seconds each;
   * there is nothing to win by overlapping them.
   */
  private async publishShorts(args: {
    userId: string;
    videoId: string;
    channelId: string;
    accessToken: string;
    visibility: PublishVisibility;
    scheduledFor?: Date;
    tags: string[];
    language: string;
    categoryId: string;
    /** The video's own credits block, reused verbatim — see
     *  `buildShortMetadata` for why a clip owes the same attribution. */
    sourcesAndCredits: string;
    /** Already clamped: the fallback title for a short the model never named. */
    videoTitle: string;
  }): Promise<ShortPublishOutcome[]> {
    const outcomes: ShortPublishOutcome[] = [];

    let shorts;
    try {
      shorts = await prisma.short.findMany({
        where: this.publishableShortsWhere(args.userId, args.videoId),
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          title: true,
          description: true,
          outputPath: true,
        },
      });
    } catch (error) {
      // The list itself failing is the one case with nothing per-short to
      // report, so it is logged and reported as an empty result rather than
      // thrown past a video that is already published.
      console.error(
        `Could not list the shorts to publish for video ${args.videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return outcomes;
    }

    /** Set once the daily allowance runs out: every short after that one is
     *  reported as not attempted rather than sent to be refused. Crucially it
     *  also leaves them with **no** `ShortPublication` row, so the one-shot
     *  claim is not spent on an upload that never happened — only the short
     *  that actually met the 403 loses its one attempt. */
    let quotaExhausted: string | null = null;

    for (const short of shorts) {
      const { title, description } = this.buildShortMetadata(
        short,
        args.videoTitle,
        args.sourcesAndCredits,
      );

      if (quotaExhausted) {
        outcomes.push({
          shortId: short.id,
          index: short.index,
          title,
          youtubeVideoId: null,
          error: `Not attempted — ${quotaExhausted}`,
        });
        continue;
      }

      // The claim, taken before a byte is sent, exactly as `publish()` takes
      // the video's: `ShortPublication.shortId` is `@unique`, so a second
      // concurrent publish loses here and never reaches YouTube.
      let publicationId: string;
      try {
        const created = await prisma.shortPublication.create({
          data: {
            shortId: short.id,
            channelId: args.channelId,
            title,
            description,
            visibility: args.visibility,
            status: "UPLOADING",
          },
          select: { id: true },
        });
        publicationId = created.id;
      } catch (error) {
        outcomes.push({
          shortId: short.id,
          index: short.index,
          title,
          youtubeVideoId: null,
          error: isUniqueConstraintViolation(error)
            ? "This short has already been published, or is being published right now."
            : `Could not record this short's upload, so it was not sent: ` +
              `${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      try {
        // `outputPath` is non-null by the query above; the check is what turns
        // the type into one, and a file the disk no longer has is a real state
        // (a hand-deleted clip) with its own sentence.
        const file = short.outputPath
          ? await getShortFile(short.outputPath)
          : null;

        if (file === null || file === "unsatisfiable") {
          throw new ConflictError(
            "This short's file is no longer on disk, so there was nothing to upload.",
          );
        }

        const youtubeVideoId = await this.uploadToYouTube(
          args.accessToken,
          {
            label: `short ${short.index + 1}`,
            title,
            description,
            tags: args.tags,
            // Inherited from the video's own publish, never chosen separately.
            // A clip of a private video that is itself public is a leak with
            // extra steps, and a public video whose clips are private is a
            // promotion that reaches nobody — and the dialog asks the
            // visibility question once, about this release, not once per file.
            visibility: args.visibility,
            // Same reasoning: if the video is held back until a timestamp, its
            // clips must not go live before it.
            publishAt: args.scheduledFor,
            language: args.language,
            categoryId: args.categoryId,
          },
          Buffer.from(await new Response(file.stream).arrayBuffer()),
        );

        await prisma.shortPublication.update({
          where: { id: publicationId },
          data: {
            status: args.scheduledFor ? "SCHEDULED" : "PUBLISHED",
            youtubeVideoId,
            publishedAt: args.scheduledFor ? null : new Date(),
          },
        });

        outcomes.push({
          shortId: short.id,
          index: short.index,
          title,
          youtubeVideoId,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof YouTubeQuotaError) {
          // Stop, rather than firing the remaining uploads at a quota that has
          // already said no: each one would spend its own one-shot claim on a
          // 403.
          quotaExhausted = message;
        }

        // The claim row is kept and marked FAILED, never deleted — the same
        // rule the video's Publication follows, and for the same reason: it is
        // the record that an attempt happened, and it is what stops a second
        // click re-uploading a clip YouTube may already hold.
        await prisma.shortPublication
          .update({
            where: { id: publicationId },
            data: { status: "FAILED", error: message },
          })
          .catch(() => {
            // Best-effort: the outcome below is what the operator reads, and a
            // bookkeeping write that fails must not take the loop down with it.
          });

        console.error(
          `Could not publish short ${short.id} of video ${args.videoId}: ${message}`,
        );

        outcomes.push({
          shortId: short.id,
          index: short.index,
          title,
          youtubeVideoId: null,
          error: message,
        });
      }
    }

    return outcomes;
  }

  /**
   * What one short is uploaded as.
   *
   * The title is the model's own (it was asked for a standalone Shorts title
   * that makes sense to someone who never saw the video — see
   * `momentSchema` in shorts.service.ts), clamped for the same reason the
   * video's is: a title one character over YouTube's limit costs a 400 *after*
   * the bytes are sent, and the claim row that failure leaves behind blocks
   * every retry. A short generated before those columns existed, or by a run
   * that stored nulls, falls back to the video's own title with its position
   * appended, so an unnamed clip still uploads rather than not uploading.
   *
   * The description leads with the video's `sourcesAndCredits` block for a
   * reason that is not cosmetic: the footage in the clip is the same Pixabay
   * footage the video was rendered from, so the same attribution is owed, and
   * the same music credit applies to whatever music is audible in the window.
   * Credits go first so that when `clampDescription` has to cut, it cuts the
   * tail of the clip's own summary rather than a licence requirement.
   */
  private buildShortMetadata(
    short: { index: number; title: string | null; description: string | null },
    videoTitle: string,
    sourcesAndCredits: string,
  ): { title: string; description: string } {
    return {
      title: clampTitle(short.title ?? `${videoTitle} — Short ${short.index + 1}`),
      description: clampDescription(
        [sourcesAndCredits, short.description].filter(Boolean).join("\n\n"),
      ),
    };
  }

  /**
   * Section clips (`videos/{videoId}/clips/section-NNN.mp4`, one per script
   * section — see `FootageService.collectPerCue`) exist only to feed a
   * render. Once a video is `PUBLISHED` nothing ever re-renders it — there is
   * no unpublish path (see this class's own doc comment) — so the clips have
   * done their only job and are pure carrying cost from here on: a real
   * ~7-minute video's clip set alone runs to roughly 400MB (see
   * `MAX_UNIQUE_SECTION_CLIPS`'s comment in footage.service.ts for the
   * incident that number comes from), which would make storage the binding
   * constraint at only a couple hundred published videos.
   *
   * Deliberately narrower than a video-wide prefix: only the `clips/`
   * sub-prefix is touched, so narration, alignment data, music and the
   * finished render — every one of which shares the same `videos/{videoId}/`
   * prefix — are left exactly alone.
   *
   * READY and FAILED are excluded on purpose. Both are still "this video may
   * render again" states — a FAILED publish can be retried once the operator
   * clears the stale Publication row, and a READY video may simply not have
   * been published yet — and a re-render needs its clips still present
   * rather than re-fetching them from Pexels/Pixabay from scratch.
   *
   * Failure here is logged and swallowed, never rethrown: this runs after
   * the publish transaction has already committed, so by the time this
   * method is called the operator's video is already sitting safely on
   * YouTube. Leftover clips cost storage; propagating this failure would
   * cost the *publish itself* looking like it failed when it plainly did
   * not — a strictly worse outcome for a step whose only job is tidying up.
   *
   * A `console.error` alone would be invisible to the operator — nothing in
   * this app surfaces server logs to them. `ActivityLog` is this codebase's
   * existing channel for exactly that (see `ScriptService.generate` and
   * `VoiceOverService`'s own writes to it), so a failed reclaim also gets a
   * `WARN` row there: several hundred MB left behind is worth a visible
   * signal somewhere the operator actually looks, even though — unlike a
   * failed publish — it's not worth blocking or retrying automatically over.
   * That write is itself best-effort: this method's only hard promise is
   * that it never throws back into `publish()`.
   */
  private async reclaimClipStorage(userId: string, videoId: string): Promise<void> {
    try {
      // kind: "VIDEO" *and* the `clips/` sub-prefix, not just one or the
      // other — narrower than either alone is what keeps this from ever
      // reaching narration (AUDIO), music (MUSIC) or alignment (SUBTITLE)
      // data that happens to share the same `videos/{videoId}/` prefix.
      // Losing any of those to a widened query here would be unrecoverable,
      // which is exactly what the "clips only" test in
      // publish.service.test.ts exists to catch.
      const clips = await prisma.asset.findMany({
        where: {
          kind: "VIDEO",
          deletedAt: null,
          storagePath: { startsWith: `videos/${videoId}/clips/` },
        },
        select: { id: true, storagePath: true },
      });

      if (clips.length === 0) {
        return;
      }

      // Storage first, DB second: if the process dies or this throws between
      // the two calls, the worst case is a Postgres row that still thinks
      // its clip is live while the underlying object is already gone (a
      // no-op the next `.remove()` call would silently tolerate) — not a row
      // that claims to be deleted while ~400MB of orphaned bytes sit in the
      // bucket forever with nothing left pointing at them to clean up.
      // `removeObjects` itself throws if it can only account for *some* of
      // the requested paths (see its own doc comment), so a partial storage
      // failure lands in the catch below with every row still `deletedAt:
      // null` — never the "some objects gone, all rows marked deleted"
      // combination that ordering exists to prevent.
      await removeObjects(clips.map((clip) => clip.storagePath));

      await prisma.asset.updateMany({
        where: { id: { in: clips.map((clip) => clip.id) } },
        data: { deletedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Could not reclaim clip storage for video ${videoId} after publish: ${message}`,
      );

      try {
        await prisma.activityLog.create({
          data: {
            userId,
            level: "WARN",
            action: "publish.reclaimClipStorage",
            entityType: "Video",
            entityId: videoId,
            message: `Could not reclaim clip storage after publish: ${message}`,
          },
        });
      } catch {
        // The console.error above already recorded this run's failure;
        // losing the operator-visible copy too isn't worth a second
        // failure path here.
      }
    }
  }

  /**
   * Deletes the local render once YouTube has confirmed the upload.
   *
   * The video is on YouTube; the copy on disk is redundant, and at ~170MB
   * each on a 40GB machine, keeping every published one is the difference
   * between a disk that stabilises and one that fills at roughly 140 videos.
   *
   * Best-effort, and mirrors `reclaimClipStorage` above in full — not just
   * its placement, but its failure handling too: this runs after the publish
   * has already succeeded, so nothing here is permitted to turn a live video
   * into a failed one. A render that is already gone — what a retried
   * publish meets — is not an error. But a *persistent* failure here (a
   * permissions problem on the render volume, say) is worse for this method
   * than for `reclaimClipStorage`: this is the one path that exists
   * specifically to keep the 40GB disk from filling, one 170MB render at a
   * time, and a `console.error` nobody reads until the disk is already full
   * is not a signal the operator will ever see in time. So this also writes
   * a `WARN` `ActivityLog` row, same as `reclaimClipStorage` does — best
   * effort itself, per that method's own doc comment on why a failed log
   * write isn't worth a second failure path here.
   */
  private async reclaimRenderStorage(
    userId: string,
    videoId: string,
    location: string,
  ): Promise<void> {
    try {
      await deleteRenderFile(location);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Could not reclaim the render for video ${videoId} at ${location}: ${message}`,
      );

      try {
        await prisma.activityLog.create({
          data: {
            userId,
            level: "WARN",
            action: "publish.reclaimRenderStorage",
            entityType: "Video",
            entityId: videoId,
            message: `Could not reclaim the render after publish: ${message}`,
          },
        });
      } catch {
        // The console.error above already recorded this run's failure;
        // losing the operator-visible copy too isn't worth a second
        // failure path here.
      }
    }
  }

  /**
   * Resumable upload: an init POST carrying the metadata, then a PUT of the
   * bytes to the `Location` it returns.
   *
   * Visibility is the caller's decision, not this method's — `publish()`
   * defaults it to `"PRIVATE"` when nobody asks for anything else, which is
   * the safe failure mode (nothing leaks to the public by omission) rather
   * than the permissive one.
   *
   * Scheduling piggybacks on privacy rather than being a separate YouTube
   * concept: the API has no "scheduled" `privacyStatus`, so a scheduled
   * upload always goes up `private` with `status.publishAt` set, which is why
   * `scheduledFor` overrides whatever `visibility` was asked for here,
   * unconditionally. Sending `publishAt` alongside `public` or `unlisted`
   * does not schedule anything — YouTube publishes immediately and ignores
   * the timestamp.
   *
   * What YouTube does *when the timestamp arrives* is the part an earlier
   * version of this comment got wrong. `publishAt` does not restore "the
   * requested visibility": it makes the video **public**, full stop. The
   * field carries no visibility of its own, and `privacyStatus: private` is
   * the only value it is valid with, so there is nothing for YouTube to
   * remember and nothing to flip back to. Scheduling a video to become
   * *unlisted* is not expressible in this API. `publish()` refuses any
   * scheduled publish that asks for a visibility other than PUBLIC rather
   * than accepting it and quietly going public later — see its own comment.
   *
   * `language` and `categoryId` come from the channel's brand (see
   * `BrandService.resolve`) and are sent unconditionally. Both are things
   * YouTube otherwise guesses: with no `defaultLanguage`/`defaultAudioLanguage`
   * it infers the language from the text, and with no `categoryId` it files
   * the video wherever its own default puts it. Those two guesses decide who
   * the video is shown to in search, browse and recommendations, so leaving
   * them out is not neutral — it is delegating the audience question to a
   * heuristic.
   */
  /**
   * Turns a 403 that means "out of quota" into `YouTubeQuotaError`, and leaves
   * every other failed response for the caller to describe.
   *
   * The status alone is not enough to tell them apart: `videos.insert` answers
   * 403 for a channel that cannot upload, for a suspended account, and for a
   * spent allowance, and only the last of those is fixed by waiting. Google
   * puts the distinguishing token in the body — `error.errors[].reason`, which
   * is `quotaExceeded` for the daily unit pool, `uploadLimitExceeded` for the
   * per-day upload count, and `dailyLimitExceeded` for the older wording.
   *
   * Reading the body is best-effort by construction. A non-JSON error page
   * (Google's edge returns HTML for some 5xx) must not replace a real failure
   * with a parse error, so anything unreadable simply means "not a quota
   * failure" and the caller's own message stands.
   */
  private async throwIfQuotaExceeded(
    response: Response,
    label = "this video",
  ): Promise<void> {
    if (response.status !== 403) {
      return;
    }

    const reasons = await response
      .json()
      .then((body: unknown) => {
        const errors = (body as { error?: { errors?: Array<{ reason?: string }> } })
          ?.error?.errors;
        return Array.isArray(errors)
          ? errors.map((entry) => entry?.reason ?? "")
          : [];
      })
      .catch(() => [] as string[]);

    const isQuota = reasons.some((reason) =>
      ["quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded"].includes(reason),
    );

    if (isQuota) {
      throw new YouTubeQuotaError(label);
    }
  }

  private async uploadToYouTube(
    accessToken: string,
    metadata: {
      /** Names this upload in a quota-exceeded message ("this video", "short
       *  2"). Never sent to YouTube — it is the one thing the operator needs
       *  when four files go up in one click and one of them is refused. */
      label?: string;
      title: string;
      description: string;
      tags: string[];
      visibility: PublishVisibility;
      publishAt?: Date;
      /** BCP-47, e.g. `en`. One value for both snippet language fields — see
       *  the `language` column's comment in schema.prisma. */
      language: string;
      /** YouTube's numeric category id as a string, e.g. `"27"`. */
      categoryId: string;
    },
    fileBuffer: Buffer,
  ): Promise<string> {
    const privacyStatus = metadata.publishAt
      ? "private"
      : metadata.visibility.toLowerCase();

    const initResponse = await this.fetchImpl(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(fileBuffer.byteLength),
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            // The metadata's language (what `title` and `description` are
            // written in) and the audio's (what the narration is spoken in)
            // are the same value here by construction: the description is
            // built from the same script the voice reads.
            defaultLanguage: metadata.language,
            defaultAudioLanguage: metadata.language,
            categoryId: metadata.categoryId,
          },
          status: {
            privacyStatus,
            selfDeclaredMadeForKids: false,
            ...(metadata.publishAt && { publishAt: metadata.publishAt.toISOString() }),
          },
        }),
      },
    );

    if (!initResponse.ok) {
      // Quota first: "403" alone would send the operator looking for a
      // permissions problem that isn't there, and this is the one failure whose
      // fix is a clock rather than an action.
      await this.throwIfQuotaExceeded(initResponse, metadata.label);
      throw new ProviderError(
        "YOUTUBE",
        `Could not start the YouTube upload (${initResponse.status}).`,
        initResponse.status >= 500,
      );
    }

    const location = initResponse.headers.get("location");
    if (!location) {
      throw new ProviderError(
        "YOUTUBE",
        "YouTube accepted the upload request but returned no upload URL.",
        false,
      );
    }

    const uploadResponse = await this.fetchImpl(location, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(fileBuffer.byteLength),
      },
      body: fileBuffer as unknown as BodyInit,
    });

    if (!uploadResponse.ok) {
      // Checked on this leg too: the resumable init can succeed and the PUT
      // still come back 403 `uploadLimitExceeded` when the allowance runs out
      // between the two calls — which is exactly what publishing four files in
      // one click makes possible.
      await this.throwIfQuotaExceeded(uploadResponse, metadata.label);
      throw new ProviderError(
        "YOUTUBE",
        `The YouTube upload failed (${uploadResponse.status}).`,
        uploadResponse.status >= 500,
      );
    }

    const body = (await uploadResponse.json()) as { id?: string };
    if (!body.id) {
      throw new ProviderError(
        "YOUTUBE",
        "YouTube accepted the upload but returned no video id.",
        false,
      );
    }

    return body.id;
  }
}

export const publishService = new PublishService();
