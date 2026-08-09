import { config } from "dotenv";

import { formatBytes, formatElapsed } from "@/utils/format";

// .env.local holds the Supabase values written by `vercel env pull`; it must load
// first so it overrides the local docker-compose defaults in .env. Mirrors
// prisma.config.ts exactly.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically, inside main(), and never at module
// top level. `@/config/env` reads `process.env` at import time, so if it (or
// anything that imports it, which is nearly every service) were imported
// statically here, the dotenv calls above — which only run as ordinary
// statements, after ES module imports are resolved — would happen too late
// and every env var would read as unset.

/** Every sub-step a stage reports gets its own indented, timed line — this is
 * what replaces "two minutes of silence, then failed" with a live trail of
 * what the pipeline is actually doing. Passed into the services as their
 * `onProgress` callback; they format their own messages (with their own
 * elapsed times, via the same `formatElapsed` this file uses) and know
 * nothing about `console.log` beyond this function — see footage.service.ts's
 * `FootageProgress` for why. `@/utils/format` has no env dependency (unlike
 * `@/config/env` and nearly everything downstream of it), so — unlike every
 * service import below — it's safe as a static import at the top of this
 * file.
 */
function printProgress(message: string): void {
  console.log(`    ${message}`);
}

async function runStage(name: string, fn: () => Promise<string>): Promise<void> {
  console.log(`\n==> ${name}`);
  const startedAt = Date.now();
  try {
    const detail = await fn();
    console.log(`    done in ${formatElapsed(Date.now() - startedAt)} — ${detail}`);
  } catch (error) {
    console.log(`    failed after ${formatElapsed(Date.now() - startedAt)}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const overallStart = Date.now();

  const args = process.argv.slice(2);
  const forceNarration = args.includes("--force-narration");
  const videoId = args.find((arg) => !arg.startsWith("--"));

  if (!videoId) {
    console.error("Usage: pnpm render <videoId> [--force-narration]");
    process.exitCode = 1;
    return;
  }

  const { env } = await import("@/config/env");
  const { prisma } = await import("@/lib/prisma");
  const { ensureBucket } = await import("@/lib/storage");
  const { voiceOverService } = await import("@/services/voiceover.service");
  const { footageService } = await import("@/services/footage.service");
  const { renderService } = await import("@/services/render.service");

  if (!env.SEED_USER_EMAIL) {
    throw new Error(
      "SEED_USER_EMAIL is not set. It must resolve to the operator account this CLI acts as.",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: env.SEED_USER_EMAIL },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error(
      `No user found for SEED_USER_EMAIL (${env.SEED_USER_EMAIL}). Run \`pnpm db:seed\` first.`,
    );
  }

  console.log(`Operator: ${user.email}`);
  console.log(`Video:    ${videoId}`);

  const video = await prisma.video.findFirst({
    where: { id: videoId, userId: user.id, deletedAt: null },
    select: {
      id: true,
      status: true,
      script: { select: { activeVersion: { select: { content: true } } } },
      voiceOver: { select: { durationSeconds: true } },
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} was not found for operator ${user.email}.`);
  }

  await runStage("Storage bucket", async () => {
    await ensureBucket();
    return "bucket ready";
  });

  await runStage("Narration", async () => {
    if (video.voiceOver && !forceNarration) {
      return (
        `already exists (${video.voiceOver.durationSeconds}s) — skipped. ` +
        "Pass --force-narration to re-synthesise (this spends ElevenLabs quota again)."
      );
    }

    if (video.voiceOver && forceNarration) {
      const characters = video.script?.activeVersion?.content?.length ?? 0;
      console.log(
        `    --force-narration: about to spend ~${characters} characters of the ` +
          "operator's ElevenLabs monthly quota re-synthesising this narration.",
      );
    }

    const result = await voiceOverService.generate(
      user.id,
      videoId,
      { force: forceNarration },
      printProgress,
    );

    return `synthesised ${result.durationSeconds}s of narration (${result.characterCount} characters)`;
  });

  await runStage("Footage", async () => {
    const before = await prisma.asset.count({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
    });

    const result = await footageService.collect(user.id, videoId, printProgress);
    const downloaded = result.clipCount - before;

    if (downloaded <= 0) {
      return `already had ${result.clipCount} clips — nothing new downloaded`;
    }

    return (
      `collected ${downloaded} new clip(s), ${result.clipCount} total, ` +
      `${formatBytes(result.bytesDownloaded)} downloaded (${JSON.stringify(result.bySource)})`
    );
  });

  await runStage("Render", async () => {
    if (video.status === "READY") {
      return "video is already READY — skipped";
    }

    // No service owns the QUEUED -> GENERATING edge: narration requires QUEUED
    // and render.service requires GENERATING, so this CLI is what flips it,
    // right before handing off to render.service. Same atomic
    // conditional-update shape as the gates in video.service.ts /
    // render.service.ts, so a second concurrent CLI run can't double-transition.
    if (video.status === "QUEUED") {
      const { count } = await prisma.video.updateMany({
        where: { id: videoId, userId: user.id, deletedAt: null, status: "QUEUED" },
        data: { status: "GENERATING" },
      });

      if (count > 0) {
        await prisma.videoStatusEvent.create({
          data: {
            videoId,
            from: "QUEUED",
            to: "GENERATING",
            message: "Narration and footage ready; starting render",
          },
        });
      }
    }

    const result = await renderService.render(user.id, videoId, printProgress);
    return `rendered ${result.durationSeconds}s to ${result.outputPath}`;
  });

  console.log(
    `\nVideo ${videoId} is ready. Total time: ${formatElapsed(Date.now() - overallStart)}.`,
  );
  console.log(
    "Stopped before publishing — Gate 2 is a human decision made in the UI.",
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nrender failed: ${message}`);
  process.exitCode = 1;
});
