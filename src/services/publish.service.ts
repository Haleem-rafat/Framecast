import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { getRenderFile, RenderFileMissingError } from "@/lib/blob-render-storage";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { removeObjects } from "@/lib/storage";
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

export interface PublishResult {
  youtubeVideoId: string;
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

/** Sources normally run to the end of the script, so everything from the
 * heading on is taken rather than trying to detect where the section ends. */
export function extractSourcesSection(scriptContent: string): string {
  const match = SOURCES_HEADING.exec(scriptContent);
  return match ? scriptContent.slice(match.index).trim() : "";
}

export function buildDescription(
  scriptContent: string | null | undefined,
  /** Written by MusicService at collection time. Absent when the video
   *  rendered without music — see MusicService.collect. */
  musicCredit?: string | null,
): string {
  const sources = scriptContent ? extractSourcesSection(scriptContent) : "";
  return [sources, PIXABAY_CREDIT, musicCredit].filter(Boolean).join("\n\n");
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
 */
export class PublishService {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async publish(userId: string, videoId: string): Promise<PublishResult> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        project: { select: { channelId: true } },
        script: { select: { activeVersion: { select: { content: true } } } },
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

    const description = buildDescription(
      video.script?.activeVersion?.content,
      musicAsset?.prompt,
    );

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
          title: video.title,
          description,
          visibility: "UNLISTED",
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
    try {
      const accessToken = await channelService.resolveAccessToken(userId, channelId);
      // Reads from Vercel Blob, not local disk — see blob-render-storage.ts.
      // `getRenderFile` returns `null` rather than throwing for a missing
      // blob (see its doc comment); this is the one call site that turns
      // that `null` into the typed `RenderFileMissingError` the operator
      // sees, the same "recognisable, non-fatal" condition the local-disk
      // version of this code used to throw directly.
      const file = await getRenderFile(video.id, outputUrl);
      if (!file) {
        throw new RenderFileMissingError(video.id);
      }
      // YouTube's resumable upload needs the full byte length up front (see
      // uploadToYouTube's X-Upload-Content-Length below), so the stream is
      // buffered here rather than piped through — same memory tradeoff the
      // local-disk version made reading the whole file at once.
      const fileBuffer = Buffer.from(await new Response(file.stream).arrayBuffer());
      youtubeVideoId = await this.uploadToYouTube(accessToken, {
        title: video.title,
        description,
      }, fileBuffer);
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
          message: "Published to YouTube",
        },
      });

      await tx.publication.update({
        where: { id: publication.id },
        data: { status: "PUBLISHED", youtubeVideoId, publishedAt: new Date() },
      });
    });

    // Deliberately outside the transaction above and after it has already
    // committed. YouTube has accepted the upload and the video is genuinely
    // PUBLISHED at this point; a storage hiccup while reclaiming clips must
    // never unwind that. See reclaimClipStorage's own doc comment for what
    // happens if this fails.
    await this.reclaimClipStorage(videoId);

    return { youtubeVideoId };
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
   */
  private async reclaimClipStorage(videoId: string): Promise<void> {
    try {
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
    }
  }

  /**
   * Resumable upload: an init POST carrying the metadata, then a PUT of the
   * bytes to the `Location` it returns.
   *
   * `privacyStatus: "unlisted"` is not a default — it is the only value this
   * method will ever send, regardless of any caller input. The operator's
   * ElevenLabs narration is on a free tier with no commercial rights, and
   * this channel is scrutinised for automated content; a public upload of
   * that audio would be a licensing violation, not just an embarrassing
   * mistake. There is deliberately no parameter that can override it.
   */
  private async uploadToYouTube(
    accessToken: string,
    metadata: { title: string; description: string },
    fileBuffer: Buffer,
  ): Promise<string> {
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
          snippet: { title: metadata.title, description: metadata.description },
          status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
        }),
      },
    );

    if (!initResponse.ok) {
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
