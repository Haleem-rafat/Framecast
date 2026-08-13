import { config } from "dotenv";

// .env.local holds local overrides; it must
// load first so it overrides the local docker-compose defaults in .env.
// Mirrors src/lib/prisma.ts and prisma.config.ts exactly.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically, inside main(), and never at module
// top level — `@/config/env`, `@/lib/prisma` and `@/lib/render-storage` all
// read `process.env` (directly or via `@/config/env`) at import time, so a
// static import here would run before the dotenv calls above take effect.
//
// One-shot migration script (see Task 10 of the OVH migration, fix round 2):
// the third of three, run after scripts/migrate-renders.ts and after
// prisma/migrations/20260813120000_output_url_to_path has unconditionally
// nulled every RenderJob.outputUrl that held a Blob URL. This script
// re-points outputUrl back to a path — but only for a row whose render is
// actually present at RENDER_ROOT on this machine right now, checked against
// the filesystem directly. It is deleted, along with the other two scripts,
// once this migration has run for real — see Task 12.
//
// This exists instead of having the SQL migration (or migrate-renders.ts
// itself) write the real path directly because nothing on the Mac that runs
// migrate-renders.ts has a route to the production database (no port is
// published, and the Mac isn't on the Docker network) — the SQL migration and
// this script both have to run from wherever the database actually is,
// against whatever the filesystem actually holds *there*, not against
// whatever migrate-renders.ts happened to see on a different machine at a
// different time. Scanning the filesystem also means this script needs no
// list of video ids handed to it from anywhere, is safe to commit exactly as
// written, and self-corrects if the operator restores Blob billing later and
// re-runs migrate-renders.ts: re-running this script afterward just picks up
// whatever's newly on disk. A row points at a file exactly when the file
// exists — nothing else has to agree with anything else.
//
// Scoped to RenderJob rows with status "SUCCEEDED" and outputUrl null, not
// every row with a null outputUrl. render.service.ts sets `status` and
// `outputUrl` together, atomically, only on a successful render — never
// separately — so a SUCCEEDED row with a null outputUrl exists only because
// the migration above just cleared it, never as a legitimate state on its
// own. This distinction matters because `renderPath(videoId)` is
// deterministic on the *video*, not the render job: a video can have more
// than one RenderJob row (an earlier SUCCEEDED attempt, a later FAILED
// retry), and both would share the same file path on disk. Without the
// status filter, a stray file left by an old successful attempt could get
// attributed to a later FAILED row too, making a failed render look
// finished. RENDER_ROOT is required, not defaulted, for the same reason the
// other two scripts require their destination roots: a forgotten variable
// must fail loudly, not silently compare against the wrong directory and
// report nothing to fix.
//
// This is the one script in this migration that writes to the database —
// deliberately: only a row-by-row disk check run from wherever RENDER_ROOT
// actually is can tell which rows are safe to re-point, and that can't be
// known in advance from a static SQL file or from migrate-renders.ts running
// somewhere else entirely.

/** Fails immediately, naming the missing variable, rather than proceeding
 * with `undefined` and silently comparing against the wrong directory. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This script reads it straight from the ` +
        "environment — export it (or add it to .env.local) before running.",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const RENDER_ROOT = requireEnv("RENDER_ROOT");

  const { resolve } = await import("node:path");
  const { prisma } = await import("@/lib/prisma");
  const { renderPath, statRenderFile } = await import("@/lib/render-storage");

  console.log(`Re-pointing outputUrl for renders present at ${resolve(RENDER_ROOT)} ...`);

  // Every SUCCEEDED row the migration just nulled — see the module comment
  // for why this exact filter (status + null outputUrl) is the safe scope.
  const candidates = await prisma.renderJob.findMany({
    where: { status: "SUCCEEDED", outputUrl: null },
    select: { id: true, videoId: true },
    orderBy: { createdAt: "asc" },
  });

  if (candidates.length === 0) {
    console.log(
      "No SUCCEEDED RenderJob row has a null outputUrl — nothing to re-point " +
        "(either the migration hasn't run yet, or this script already has).",
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${candidates.length} row(s) the migration nulled. Checking disk...`);

  let relinked = 0;
  let stillMissing = 0;

  for (const job of candidates) {
    const location = renderPath(job.videoId);
    const stat = await statRenderFile(location);
    const processed = relinked + stillMissing + 1;

    if (!stat) {
      stillMissing += 1;
      console.log(
        `[${processed}/${candidates.length}] no file at ${location} — leaving null: ` +
          `video ${job.videoId}`,
      );
      continue;
    }

    await prisma.renderJob.update({
      where: { id: job.id },
      data: { outputUrl: location },
    });

    relinked += 1;
    console.log(`[${processed}/${candidates.length}] re-pointed to ${location}: video ${job.videoId}`);
  }

  console.log(
    `\nDone. ${relinked} row(s) re-pointed to a real path, ${stillMissing} left null ` +
      `(no file present). Total candidates: ${candidates.length}.`,
  );
  console.log(
    `Verify: SELECT count(*) FROM "render_job" WHERE "outputUrl" LIKE 'renders/%'; should be ` +
      `${relinked} more than it was before this script ran (see docs/vps-deployment.md's Step 6.5).`,
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nrelink-renders failed: ${message}`);
  process.exitCode = 1;
});
