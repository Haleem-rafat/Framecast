import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { putObject, storagePath } from "@/lib/storage";
import { buildThumbnailArgs } from "@/lib/thumbnail-command";
import { brandService } from "@/services/brand.service";
import { gatewayImageProvider } from "@/services/providers/image.provider";
import type { ImageProvider } from "@/services/providers/types";
import { defaultSpawner, type ProcessSpawner } from "@/services/render.service";

/** How much of the script the prompt is built from. The hook is what the
 *  thumbnail has to illustrate; the rest of a 6,000-character script is
 *  detail the image cannot show and only dilutes the prompt. */
const HOOK_CHARACTERS = 400;

/** The headline drawn on the image. Shorter than the title deliberately: a
 *  thumbnail read at 1280x720 comfortably fits four or five words at
 *  `HEADLINE_MAX_FONT_SIZE` (see thumbnail-command.ts's own budget maths) —
 *  a full title routinely runs longer than that and would just trigger
 *  `fitHeadline`'s shrink-then-truncate path for no benefit, since nobody
 *  reads a full sentence off a thumbnail at browsing size anyway. */
const HEADLINE_WORDS = 5;

function buildPrompt(hook: string, tone: string, niche: string): string {
  return (
    `A YouTube thumbnail background for a ${niche} video. Tone: ${tone}. ` +
    `The video opens: "${hook}". Cinematic, high contrast, strong focal ` +
    `subject, empty space on one side for a headline. No text, no words, no ` +
    `letters anywhere in the image.`
  );
}

function buildHeadline(title: string): string {
  return title.split(/\s+/).slice(0, HEADLINE_WORDS).join(" ");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/**
 * The composited path always produces real JPEG — `buildThumbnailArgs`
 * encodes through FFmpeg's mjpeg encoder — so it never calls this. The
 * fallback path (composite failed) stores the image provider's raw bytes
 * as-is, and `GeneratedImage` (providers/types.ts) carries no format field
 * to say what they are: image models commonly return PNG, some return
 * JPEG. Assuming JPEG unconditionally, as the raw path used to, would store
 * PNG bytes under an `image/jpeg` content-type — harmless to Supabase,
 * which stores whatever it is given, but a landmine for whatever reads
 * `ThumbnailVersion.imageUrl` next (Task 8's YouTube upload) and trusts the
 * declared type instead of re-sniffing it. A four-byte signature check is
 * cheap insurance; anything that isn't recognisably PNG — real JPEG bytes,
 * or this file's own non-image test fixtures — keeps the original
 * jpg/`image/jpeg` default.
 */
function detectImageFormat(bytes: Buffer): { contentType: string; extension: string } {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { contentType: "image/png", extension: "png" };
  }
  return { contentType: "image/jpeg", extension: "jpg" };
}

/**
 * Turns a video into a thumbnail somebody might click.
 *
 * Both the image provider and the FFmpeg spawner are injected, so a test
 * never generates a real image or spawns a real process — the same shape
 * `RenderService` and `FootageService` already use.
 *
 * Never throws. A thumbnail is an enhancement: without one YouTube picks a
 * frame from the stock footage and the video still publishes. Nothing here
 * may turn a renderable video into a failed one.
 */
export class ThumbnailService {
  constructor(
    private readonly images: ImageProvider = gatewayImageProvider,
    private readonly spawnProcess: ProcessSpawner = defaultSpawner,
  ) {}

  async generate(userId: string, videoId: string): Promise<string | null> {
    try {
      return await this.generateThumbnail(userId, videoId);
    } catch (error) {
      console.error(
        `Could not generate a thumbnail for video ${videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  private async generateThumbnail(userId: string, videoId: string): Promise<string | null> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        title: true,
        generatedTitle: true,
        script: { select: { activeVersion: { select: { content: true } } } },
        project: { select: { channelId: true } },
      },
    });

    // Checked as one guard, not `!video` then a separate `!script`: `video`
    // itself never gets used below unless a script does too, so there is no
    // reason to distinguish "no video" from "video has no approved script"
    // here — both mean the same thing to this method, and to a bare
    // `await ... ?? null` chain TypeScript can't carry non-null-ness for
    // `video` out of a nested optional-chain check on a different variable.
    if (!video?.script?.activeVersion?.content) {
      return null;
    }

    const script = video.script.activeVersion.content;
    const brand = await brandService.resolve(video.project?.channelId ?? null);
    const prompt = buildPrompt(script.slice(0, HOOK_CHARACTERS), brand.tone, brand.niche);

    const image = await this.images.generate({ prompt, aspectRatio: "16:9" });

    const tempDir = await mkdtemp(path.join(tmpdir(), "framecast-thumb-"));

    try {
      const rawPath = path.join(tempDir, "image.png");
      const compositePath = path.join(tempDir, "thumbnail.jpg");
      await writeFile(rawPath, image.data);

      // A failed composite is not a failed thumbnail: the generated image on
      // its own still beats a random frame of stock footage, so the headline
      // is the part that degrades, not the whole feature.
      let bytes: Buffer;
      let format: { contentType: string; extension: string };
      try {
        await this.runFfmpeg(
          buildThumbnailArgs({
            imagePath: rawPath,
            outputPath: compositePath,
            headline: buildHeadline(video.generatedTitle ?? video.title),
            brand,
            logoPath: brand.logoPath,
          }),
        );
        bytes = await readFile(compositePath);
        format = { contentType: "image/jpeg", extension: "jpg" };
      } catch {
        bytes = image.data;
        format = detectImageFormat(image.data);
      }

      return await this.storeVersion(videoId, bytes, format, prompt, image.model);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Appends a version and moves the active pointer. Nothing is ever
   * overwritten — regenerating is the expected workflow, and comparing
   * attempts is what `ThumbnailVersion` exists for.
   *
   * The upload happens before the transaction opens, same as
   * `VoiceOverService`'s own storage write and for the same reason: a
   * network call to Supabase Storage inside a Postgres transaction would
   * hold that transaction's connection (and any row locks it has taken)
   * open for the length of the upload, and `voiceover.service.ts` already
   * documents where that leads against a remote database.
   *
   * That ordering leaves a real, accepted race: two concurrent
   * regenerations for the same video can both read the same "latest
   * version" before either writes, upload to two different objects, and
   * then collide on `ThumbnailVersion`'s `[thumbnailId, version]` unique
   * constraint when both try to insert the same next version number. One
   * insert wins; the other throws, is caught by `generate()`'s outer
   * try/catch, and returns `null` — which is the correct outcome for an
   * enhancement that must never fail the video, not a bug to design away
   * with heavier locking. `script.service.ts` accepts the identical race on
   * `ScriptVersion` for the identical reason.
   */
  private async storeVersion(
    videoId: string,
    bytes: Buffer,
    format: { contentType: string; extension: string },
    prompt: string,
    model: string,
  ): Promise<string> {
    const thumbnail = await prisma.thumbnail.upsert({
      where: { videoId },
      create: { videoId },
      update: {},
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });

    const version = (thumbnail.versions[0]?.version ?? 0) + 1;
    const objectPath = storagePath(
      videoId,
      "thumbnails",
      `thumbnail-${String(version).padStart(3, "0")}.${format.extension}`,
    );

    await putObject(objectPath, bytes, format.contentType);

    return prisma.$transaction(async (tx) => {
      const created = await tx.thumbnailVersion.create({
        data: { thumbnailId: thumbnail.id, version, imageUrl: objectPath, prompt, model },
      });

      await tx.thumbnail.update({
        where: { id: thumbnail.id },
        data: { activeVersionId: created.id },
      });

      return objectPath;
    });
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });
  }
}

export const thumbnailService = new ThumbnailService();
