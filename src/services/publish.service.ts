import "server-only";

import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/lib/storage";
import { channelService } from "@/services/channel.service";

/** Injectable so tests never make a real call to YouTube. */
export type FetchLike = typeof fetch;

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

function buildDescription(scriptContent: string | null | undefined): string {
  const sources = scriptContent ? extractSourcesSection(scriptContent) : "";
  return [sources, PIXABAY_CREDIT].filter(Boolean).join("\n\n");
}

/**
 * Gate 2. This is the control that stops Framecast publishing on its own —
 * everything upstream only ever produces a video that is *eligible* to
 * upload; this is the one place the upload itself happens, and it refuses
 * unless a human has already moved the video to READY via a finished render.
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

    const description = buildDescription(video.script?.activeVersion?.content);

    let youtubeVideoId: string;
    try {
      const accessToken = await channelService.resolveAccessToken(userId, channelId);
      const fileBuffer = await getObject(outputUrl);
      youtubeVideoId = await this.uploadToYouTube(accessToken, {
        title: video.title,
        description,
      }, fileBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Same atomic conditional update as the success path below, guarding
      // against the video having moved on for some other reason while the
      // upload was in flight. No Publication is ever created on this path —
      // an upload that never succeeded has nothing to record.
      await prisma.$transaction(async (tx) => {
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

    // The gate itself: two callers can both read READY and both run the
    // upload above, but the `status: "READY"` clause here means only one of
    // their updates can match the row, so only one goes on to create the
    // Publication and append the event below. Same shape as
    // VideoService.approveScript's Gate 1 and RenderService's render() gate.
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

      await tx.publication.create({
        data: {
          videoId,
          channelId,
          title: video.title,
          description,
          visibility: "UNLISTED",
          status: "PUBLISHED",
          youtubeVideoId,
          publishedAt: new Date(),
        },
      });
    });

    return { youtubeVideoId };
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
