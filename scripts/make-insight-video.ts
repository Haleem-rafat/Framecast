import { config } from "dotenv";

// .env.local first, exactly as scripts/render.ts and prisma.config.ts do.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically inside main(), never at module top
// level — `@/config/env` reads process.env at import time and would run before
// the dotenv calls above. Same reason scripts/render.ts does it.

/**
 * Makes one single-insight short, end to end, and says what it is doing.
 *
 * A throwaway for the first render of this format: the UI has no way to ask
 * for it yet, so this drives the services directly. It is deliberately NOT a
 * general-purpose tool — it takes a project and a topic and does exactly the
 * one flow, so that when the result is wrong there is no question about which
 * path produced it.
 *
 * It stops at a finished file. Nothing here publishes.
 *
 *   pnpm tsx scripts/make-insight-video.ts <projectId> "<topic>"
 */
async function main(): Promise<void> {
  const [projectId, topic] = process.argv.slice(2);

  if (!projectId || !topic) {
    console.error(
      'usage: make-insight-video.ts <projectId> "<topic>"',
    );
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");
  const { videoService } = await import("@/services/video.service");
  const { scriptService } = await import("@/services/script.service");
  const { runPipeline } = await import("@/services/pipeline-runner");

  const project = await prisma.project.findFirstOrThrow({
    where: { id: projectId, deletedAt: null },
    select: { id: true, name: true, userId: true, channelId: true },
  });

  console.log(`project  ${project.name}`);
  console.log(`topic    ${topic}`);

  // Vertical, because the format is 9:16 and that is decided once, at approval,
  // and cannot be changed afterwards without paying for the pipeline again.
  const video = await videoService.create(
    project.userId,
    { projectId: project.id, title: topic, topic },
    {},
  );

  console.log(`video    ${video.id}`);

  console.log("\n— script —");
  const version = await scriptService.generate(project.userId, video.id, {
    format: "insight",
  });

  const cues = Array.isArray(version.cues) ? version.cues : [];
  console.log(`  ${version.wordCount} words, ${cues.length} scenes`);

  for (const cue of cues as { beat?: string; cue: string }[]) {
    console.log(`  ${(cue.beat ?? "—").padEnd(10)} ${cue.cue.slice(0, 62)}`);
  }

  // The gate has already run inside `generate` — a script that failed it never
  // reaches here. Printing the beats above is so a human can see the shape
  // before the expensive half starts.
  await videoService.approveScript(project.userId, video.id, "VERTICAL");

  console.log("\n— pipeline —");
  await runPipeline({
    userId: project.userId,
    videoId: video.id,
    // A stage-level trail rather than every sub-step: this run is watched for
    // whether it finishes and where it fails, not for progress percentages.
    onProgress: (event) => {
      if (event.type === "stage-start") {
        console.log(`  ${event.stage} …`);
      } else if (event.type === "stage-done") {
        console.log(`  ${event.stage} done — ${event.detail}`);
      } else if (event.type === "stage-failed") {
        console.log(`  ${event.stage} FAILED`);
      } else {
        console.log(`    ${event.message}`);
      }
    },
  });

  const finished = await prisma.video.findUniqueOrThrow({
    where: { id: video.id },
    select: { status: true, durationSeconds: true, renderJobs: { select: { outputUrl: true } } },
  });

  console.log(`\nstatus   ${finished.status}`);
  console.log(`duration ${finished.durationSeconds}s`);
  console.log(`file     ${finished.renderJobs.at(-1)?.outputUrl ?? "(none)"}`);

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
