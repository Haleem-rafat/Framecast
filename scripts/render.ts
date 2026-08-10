import { config } from "dotenv";

import { formatElapsed } from "@/utils/format";

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
// and every env var would read as unset. `@/services/pipeline-runner` pulls
// in the full service graph, so it must be imported dynamically here too, for
// the same reason.

/** Display names for `PipelineStageName`, kept in this file (not
 * pipeline-runner.ts) because they're purely a CLI presentation concern —
 * the worker has no reason to know them. */
const STAGE_LABELS: Record<string, string> = {
  bucket: "Storage bucket",
  narration: "Narration",
  footage: "Footage",
  render: "Render",
};

/** Every sub-step a stage reports gets its own indented, timed line — this is
 * what replaces "two minutes of silence, then failed" with a live trail of
 * what the pipeline is actually doing. `@/utils/format` has no env dependency
 * (unlike `@/config/env` and nearly everything downstream of it), so —
 * unlike every other import in this file — it's safe as a static import at
 * the top of this file.
 */
function printProgress(message: string): void {
  console.log(`    ${message}`);
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
  const { runPipeline } = await import("@/services/pipeline-runner");

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

  await runPipeline({
    userId: user.id,
    videoId,
    force: forceNarration,
    // No shouldCancel: the CLI runs to completion (or until the process is
    // killed outright) — cooperative cancellation is a worker concern, wired
    // up against its heartbeat.
    onProgress: (event) => {
      switch (event.type) {
        case "stage-start":
          console.log(`\n==> ${STAGE_LABELS[event.stage] ?? event.stage}`);
          break;
        case "message":
          printProgress(event.message);
          break;
        case "stage-done":
          console.log(`    done in ${formatElapsed(event.elapsedMs)} — ${event.detail}`);
          break;
        case "stage-failed":
          console.log(`    failed after ${formatElapsed(event.elapsedMs)}`);
          break;
      }
    },
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
