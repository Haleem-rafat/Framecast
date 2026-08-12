import "server-only";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { getObject, putObject, removeObjects, storagePath } from "@/lib/storage";
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

/**
 * YouTube's hard cap on a custom thumbnail's file size. `thumbnails.set`
 * rejects anything larger outright, so bytes over this line are not a
 * thumbnail — they are a `Publication.thumbnailApplied: false` and a
 * console line nobody reads.
 *
 * Only the fallback path can realistically reach it. The composited path
 * encodes through FFmpeg's mjpeg encoder at 1280x720 (see
 * `JPEG_QUALITY`/`THUMBNAIL_WIDTH` in thumbnail-command.ts), which lands in
 * the low hundreds of KB. The fallback stores the image provider's own bytes
 * untouched, and `AI_IMAGE_MODEL` defaults to `openai/gpt-image-1`, whose
 * 16:9 output is a 1536x1024 PNG that routinely runs 1.5-3MB.
 *
 * Dimensions are deliberately not checked alongside this. YouTube accepts a
 * thumbnail wider than 640px at whatever aspect ratio it is given — 1280x720
 * is the recommendation, not the requirement, and a 1536x1024 image uploads
 * and displays letterboxed rather than being refused. The file size is the
 * only limit that turns into a rejection, so it is the only one worth
 * refusing to store over.
 */
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How long the composite may run before the child is killed.
 *
 * Generous for the work — a single-frame filter graph over one image is a
 * second or two — because the cost of being wrong is asymmetric. Too short
 * only loses a headline on a slow machine; too long, or absent, wedges the
 * caller forever: this runs inside `runPipeline`, whose worker keeps renewing
 * `Video.leaseExpiresAt` on its own timer, so a `ffmpeg` that never exits
 * leaves a live lease on a video no worker is making progress on and
 * `JobService.claimNext` — which skips any video whose lease is still live —
 * can never reclaim it. Nothing else in this path has a deadline.
 */
const COMPOSITE_TIMEOUT_MS = 120_000;

/** How much of FFmpeg's stderr to carry into the thrown error. Enough for the
 *  filter-graph diagnostics that actually explain a failure, bounded so a
 *  pathological run can't build an unbounded string in memory. The *tail* is
 *  kept rather than the head: FFmpeg prints its banner and input analysis
 *  first and the reason it gave up last. */
const STDERR_CAPTURE_LIMIT = 4000;

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

// The full 8-byte PNG signature (the first 4 bytes alone — 0x89 'P' 'N' 'G' —
// are already enough to identify PNG in practice, but the format's own spec
// defines all 8 as the magic number, and checking only half of it for no
// benefit was an easy thing to tighten once it was pointed out).
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
 * declared type instead of re-sniffing it. A signature check is cheap
 * insurance; anything that isn't recognisably PNG — real JPEG bytes, or
 * this file's own non-image test fixtures — keeps the original
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
    /** Injected for the same reason the spawner is: a test proving the
     *  timeout fires cannot wait two real minutes to do it. */
    private readonly compositeTimeoutMs: number = COMPOSITE_TIMEOUT_MS,
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
            // The *downloaded* logo, never `brand.logoPath` itself — see
            // `downloadLogo` for what that string actually is.
            logoPath: await this.downloadLogo(brand.logoPath, tempDir),
          }),
        );
        bytes = await readFile(compositePath);
        format = { contentType: "image/jpeg", extension: "jpg" };
      } catch (error) {
        // Logged, not swallowed. The fallback is deliberate, but it is also
        // the only symptom a broken filter graph ever produces — a thumbnail
        // that quietly has no headline — and without the reason here the
        // stderr `runFfmpeg` went to the trouble of capturing dies at this
        // `catch` and the failure is undiagnosable from production.
        console.error(
          `Could not composite the thumbnail for video ${videoId}, storing the ` +
            `raw image instead: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        bytes = image.data;
        format = detectImageFormat(image.data);
      }

      // Checked after both paths converge, because either could in principle
      // produce it, though only the fallback realistically does — see
      // THUMBNAIL_MAX_BYTES. Storing bytes YouTube will refuse is worse than
      // storing nothing: `publish.service.ts` would download them, spend
      // quota on a `thumbnails.set` that fails, and record
      // `thumbnailApplied: false` — the same operator-visible outcome as no
      // thumbnail at all, reached expensively and via a `ThumbnailVersion`
      // row that claims a thumbnail exists. Returning null instead leaves the
      // video publishable with YouTube picking a frame, which is exactly what
      // this service's own doc comment says a missing thumbnail costs.
      if (bytes.byteLength > THUMBNAIL_MAX_BYTES) {
        console.error(
          `Not storing a thumbnail for video ${videoId}: ${bytes.byteLength} bytes ` +
            `exceeds YouTube's ${THUMBNAIL_MAX_BYTES}-byte limit, so it could never ` +
            `be uploaded.`,
        );
        return null;
      }

      return await this.storeVersion(videoId, bytes, format, prompt, image.model);
    } finally {
      // Caught, not awaited bare: a `finally` block's own throw replaces
      // whatever the `try` block returned, so a temp-dir cleanup failure —
      // `force: true` only swallows ENOENT, not e.g. a transient EBUSY —
      // would turn an already-committed `ThumbnailVersion` and already
      // uploaded bytes into a `null` return, telling the caller generation
      // failed when it had, in fact, already succeeded. Best-effort cleanup
      // logged for whoever is debugging a filling disk, never allowed to
      // override a result that already happened.
      await rm(tempDir, { recursive: true, force: true }).catch((error) => {
        console.error(
          `Could not remove temp dir ${tempDir}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      });
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
   * The object key includes a random token precisely because that ordering
   * is not atomic with the version-number read above it: two concurrent
   * regenerations for the same video can both read "latest version 0"
   * before either writes. A key built from the version number alone
   * (`thumbnail-001.jpg`) would then have both calls uploading to the
   * *same* path — `putObject` uploads with `upsert: true`, so the second
   * write silently overwrites the first, including after the first call's
   * transaction already committed a `ThumbnailVersion` row whose `prompt`
   * and `model` describe the bytes it uploaded, not the bytes now sitting
   * at that path. That breaks the exact guarantee `ThumbnailVersion.prompt`
   * exists for — that a version is reproducible — and no unique constraint
   * catches it, because the constraint is on `[thumbnailId, version]`, a
   * property of the row, not of the object it points at. Randomising the
   * key removes the collision at the root: every generation now owns a
   * path nothing else will ever write to, so whichever `ThumbnailVersion`
   * row commits is guaranteed to describe the bytes actually at its
   * `imageUrl`. The two calls can still collide on inserting the same
   * `version` number — one throws on the unique constraint, is caught by
   * `generate()`'s outer try/catch, and returns `null`, same as
   * `script.service.ts` accepts for `ScriptVersion` — but that race is now
   * confined to "did this regeneration count as version 3 or 4", never to
   * "which regeneration's bytes does version 3 actually contain".
   *
   * A losing call's upload is not wasted for nothing, though: unlike
   * `voiceover.service.ts`'s fixed key, which self-heals because the next
   * successful write reuses the same path, a randomised key is never
   * reused, so a losing call — or any call whose transaction fails for an
   * unrelated reason after the upload succeeds — leaves that object
   * permanently orphaned unless something deletes it. The `catch` below
   * does exactly that: best-effort, and swallowed on its own failure,
   * because losing the cleanup must never turn into losing the original
   * error the caller (`generate()`) needs to log and turn into `null`.
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
      `thumbnail-${String(version).padStart(3, "0")}-${randomUUID()}.${format.extension}`,
    );

    await putObject(objectPath, bytes, format.contentType);

    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.thumbnailVersion.create({
          data: { thumbnailId: thumbnail.id, version, imageUrl: objectPath, prompt, model },
        });

        await tx.thumbnail.update({
          where: { id: thumbnail.id },
          data: { activeVersionId: created.id },
        });

        return objectPath;
      });
    } catch (error) {
      await removeObjects([objectPath]).catch(() => {
        // Best-effort: an orphaned object is a storage-cleanup problem, not
        // a reason to hide the transaction failure below from the caller.
      });
      throw error;
    }
  }

  /**
   * Copies the channel's logo out of Supabase Storage and into `tempDir`,
   * returning the local path FFmpeg can actually open.
   *
   * `ChannelBrand.logoPath` is a Supabase *object key* — `logo.service.ts`
   * writes it via `storagePath(channelId, "logos", ...)` and stores exactly
   * what `putObject` returns. It is not a filesystem path and nothing on the
   * machine running FFmpeg has ever had a file at it. Handing it straight to
   * `buildThumbnailArgs` (as this did) put it inside a `movie=` source
   * filter, which fails to open it, which fails the *whole* filter graph —
   * so choosing a logo did not just lose the watermark, it silently lost the
   * headline too and dropped every branded channel onto the raw-image
   * fallback.
   *
   * A failure here returns `null` and composites without the logo rather
   * than propagating. The trade is the same one the fallback path makes one
   * level up, only finer-grained: a headline with no watermark is a small
   * loss, and losing the headline as well — which is what letting this throw
   * would cost — is a much larger one for a channel that has done nothing
   * wrong except have a storage hiccup.
   */
  private async downloadLogo(
    logoPath: string | null,
    tempDir: string,
  ): Promise<string | null> {
    if (!logoPath) {
      return null;
    }

    try {
      const bytes = await getObject(logoPath);
      // The extension is carried over so `movie=` gets the filename shape it
      // would have had on disk. FFmpeg probes content rather than trusting
      // the suffix, so this is tidiness, not correctness — hence the plain
      // default for a key that somehow has none.
      const localPath = path.join(tempDir, `logo${path.extname(logoPath) || ".png"}`);
      await writeFile(localPath, bytes);
      return localPath;
    } catch (error) {
      console.error(
        `Could not download the channel logo at ${logoPath}; compositing the ` +
          `thumbnail without it: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  /**
   * Runs the composite and turns its outcome into a resolved promise or an
   * error that says what went wrong.
   *
   * Three things this deliberately does that the first version did not, all
   * of them the same lesson `render.service.ts` already learned:
   *
   * Stderr is captured and carried into the error. FFmpeg says why it failed
   * on stderr and nowhere else — a filter graph that cannot open its `movie=`
   * source, a font that does not exist, an unwritable output path all exit
   * with the same bare code 1. Reporting only that code is what made the
   * logo-path bug above invisible in production for as long as it was.
   *
   * Both pipes are drained. An unread pipe fills its OS buffer and blocks the
   * writer, at which point FFmpeg stops making progress and never reaches the
   * `close` this promise is waiting on. Unlikely for a single-frame composite
   * that prints little, but it is a deadlock rather than a slowdown, and
   * `stdout` costs one no-op listener to remove entirely.
   *
   * The child gets a deadline. See `COMPOSITE_TIMEOUT_MS` for why a hang here
   * does not merely lose one thumbnail but strands the video permanently.
   * SIGKILL rather than SIGTERM: this fires only after the process has
   * already failed to finish work that takes seconds, so it is past the point
   * where asking politely is worth another wait.
   */
  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);

      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.compositeTimeoutMs);

      /** Appended to the message so the reason travels with the error rather
       *  than needing a second log line to correlate against. */
      const reason = () => (stderr.trim() ? `: ${stderr.trim()}` : "");

      // `settled` guards the pair rather than trusting Node to emit only one
      // of them: `error` and `close` can both fire (a spawn that fails still
      // closes), and a second reject on an already-rejected promise is a
      // silent no-op that hides which of the two actually described the
      // failure.
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      // Drained, not parsed: this invocation passes no `-progress`, so there
      // is nothing on stdout worth reading — only a pipe worth emptying.
      child.stdout.on("data", () => {});

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_CAPTURE_LIMIT) {
          stderr = stderr.slice(-STDERR_CAPTURE_LIMIT);
        }
      });

      child.on("error", (error: Error) => {
        finish(new Error(`ffmpeg could not be started: ${error.message}${reason()}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          finish(
            new Error(
              `ffmpeg did not finish compositing within ${this.compositeTimeoutMs}ms ` +
                `and was killed${reason()}`,
            ),
          );
        } else if (code === 0) {
          finish();
        } else if (signal) {
          // No exit code exists for a process killed by a signal — naming the
          // signal is the only clue an OOM kill (SIGKILL) leaves behind.
          finish(new Error(`ffmpeg was killed by signal ${signal}${reason()}`));
        } else {
          finish(new Error(`ffmpeg exited with code ${code}${reason()}`));
        }
      });
    });
  }
}

export const thumbnailService = new ThumbnailService();
