import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Animates the first few drawn beats of a finished video with Wan 2.2 and
 * re-renders it, so the hook moves and the rest stays drawn.
 *
 *   FAL_KEY=... pnpm tsx --conditions=react-server scripts/hook-motion.ts <videoId> [beats=3] [seconds=6]
 *
 * Image-to-video rather than text-to-video, because the point is that the hook
 * still looks like this channel: the model animates the picture collection
 * already drew instead of guessing at the style. Each clip replaces its still
 * by soft-deleting the still's Asset row — `beatAssetPath` prefers a still over
 * a clip, so leaving both would render exactly what was there before. The PNG
 * stays on disk, so restoring a beat is clearing `deletedAt`.
 *
 * Spends about $0.08 per clip second (billed at 16fps). Publishes nothing.
 */

const MODEL = "fal-ai/wan/v2.2-a14b/image-to-video";

const MOTION_DIRECTION =
  "The drawing comes alive with gentle, natural movement and a slow push in. " +
  "Keep the exact art style, line work and colours of the picture.";

const NEGATIVE =
  "photorealistic, style change, text, watermark, subtitles, distorted face, " +
  "extra limbs, flicker";

async function main(): Promise<void> {
  const [videoId, beatsArg = "3", secondsArg = "6"] = process.argv.slice(2);
  const apiKey = process.env.FAL_KEY;

  if (!videoId) throw new Error("usage: hook-motion.ts <videoId> [beats] [seconds]");
  if (!apiKey) throw new Error("FAL_KEY is not set.");

  const beatCount = Number.parseInt(beatsArg, 10);
  const seconds = Number.parseFloat(secondsArg);

  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { promisify } = await import("node:util");
  const { prisma } = await import("@/lib/prisma");
  const { beatClipPath, beatImagePath } = await import("@/lib/beat-storage");
  const { buildConformArgs } = await import("@/lib/ffmpeg-command");
  const { getObject, putObject } = await import("@/lib/storage");
  const { falVideoProvider } = await import("@/services/providers/fal-video.provider");
  const { renderService } = await import("@/services/render.service");

  const video = await prisma.video.findFirstOrThrow({
    where: { id: videoId, deletedAt: null },
    select: { id: true, userId: true, title: true, status: true, format: true },
  });

  if (video.status !== "READY") {
    throw new Error(`Video is ${video.status}; only a READY video's beats are swapped.`);
  }

  const aspectRatio = video.format === "VERTICAL" ? "9:16" : "16:9";
  const stills = await prisma.asset.findMany({
    where: {
      deletedAt: null,
      storagePath: {
        in: Array.from({ length: beatCount }, (_unused, index) => beatImagePath(videoId, index)),
      },
    },
    orderBy: { storagePath: "asc" },
    select: { id: true, storagePath: true, mimeType: true, prompt: true },
  });

  if (stills.length !== beatCount) {
    throw new Error(`Expected ${beatCount} drawn beats, found ${stills.length}.`);
  }

  console.log(`${video.title} — animating beats 1-${beatCount} at ${seconds}s each`);

  // Submitted together: fal runs them in parallel, and each one is a bill the
  // moment it is accepted, so nothing between submit and collect may throw
  // without the request id having been printed first.
  const jobs = await Promise.all(
    stills.map(async (still, index) => {
      const picture = await getObject(still.storagePath);
      const words = (still.prompt ?? "").split(/\s+/).slice(0, 60).join(" ");
      const prompt = `${words} ${MOTION_DIRECTION}`.trim();
      const requestId = await falVideoProvider.submit({
        apiKey,
        model: MODEL,
        prompt,
        negativePrompt: NEGATIVE,
        aspectRatio,
        durationSeconds: seconds,
        seed: 100001 + index,
        imageUrl: `data:${still.mimeType ?? "image/png"};base64,${picture.toString("base64")}`,
      });

      console.log(`  beat ${index + 1} submitted ${requestId}`);

      return { still, index, prompt, requestId };
    }),
  );

  const started = Date.now();

  for (const job of jobs) {
    for (;;) {
      const status = await falVideoProvider.checkStatus(MODEL, job.requestId, apiKey);

      if (status.state === "COMPLETED") break;
      if (status.state === "FAILED") {
        throw new Error(`beat ${job.index + 1} failed: ${status.detail ?? "no detail"}`);
      }
      if (Date.now() - started > 20 * 60_000) throw new Error("Gave up after 20 minutes.");

      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }

    const clip = await falVideoProvider.fetchResult(MODEL, job.requestId, apiKey);
    const directory = await mkdtemp(join(tmpdir(), "framecast-hook-"));

    try {
      const sourcePath = join(directory, "generated.mp4");
      const outputPath = join(directory, "conformed.mp4");

      await writeFile(sourcePath, clip.data);
      await promisify(execFile)(
        "ffmpeg",
        buildConformArgs({ sourcePath, outputPath, format: video.format }),
      );

      const conformed = await readFile(outputPath);
      const path = beatClipPath(videoId, job.index);

      await putObject(path, conformed, "video/mp4");
      await prisma.$transaction([
        prisma.asset.create({
          data: {
            kind: "VIDEO",
            storagePath: path,
            mimeType: "video/mp4",
            sizeBytes: BigInt(conformed.byteLength),
            provider: "FAL",
            model: MODEL,
            prompt: job.prompt,
            externalId: job.requestId,
          },
        }),
        prisma.asset.update({ where: { id: job.still.id }, data: { deletedAt: new Date() } }),
      ]);

      console.log(`  beat ${job.index + 1} stored ${path}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // READY -> GENERATING is the edge the pipeline runner owns; render.service
  // only starts from GENERATING. Same conditional update, same audit row.
  const { count } = await prisma.video.updateMany({
    where: { id: videoId, status: "READY" },
    data: { status: "GENERATING" },
  });

  if (count === 0) throw new Error("Video left READY while the clips were generating.");

  await prisma.videoStatusEvent.create({
    data: {
      videoId,
      from: "READY",
      to: "GENERATING",
      message: `Re-rendering with Wan 2.2 motion on beats 1-${beatCount}`,
    },
  });

  const result = await renderService.render(video.userId, videoId, (message) =>
    console.log(`    ${message}`),
  );

  console.log(`rendered ${result.durationSeconds}s to ${result.outputUrl}`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
