import { config } from "dotenv";

import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// .env.local holds locally-pulled values written by `vercel env pull`; it must
// load first so it overrides the local docker-compose defaults in .env.
// Mirrors src/lib/prisma.ts and prisma.config.ts exactly.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically, inside main(), and never at module
// top level — `@/config/env`, `@/lib/prisma` and `@/lib/render-storage` all
// read `process.env` (directly or via `@/config/env`) at import time, so a
// static import here would run before the dotenv calls above take effect.
//
// One-shot migration script (see Task 10 of the OVH migration): reads every
// `RenderJob.outputUrl` that still holds a Vercel Blob URL, downloads that
// render, and writes it under RENDER_ROOT at the path `renderPath(videoId)`
// produces. It is deleted, along with migrate-storage.ts, once it has run for
// real — see Task 12. This script only reads from Postgres and Blob; it never
// writes RenderJob.outputUrl itself — that rewrite is the SQL migration
// (prisma/migrations/<timestamp>_output_url_to_path), run separately and
// strictly after this script, and never deletes or modifies anything in Blob.
//
// BLOB_READ_WRITE_TOKEN is read directly from process.env, not from
// `@/config/env` — the same treatment Task 6 gave the Supabase variables:
// removed from the schema once the app stopped needing it (Task 4), not
// resurrected here. @vercel/blob is a devDependency for exactly this script;
// it is the same package (and the same `access: "private"` call shape) the
// app used before Task 4, so its `BlobStoreSuspendedError` is a documented,
// typed signal rather than something this script has to infer from a raw
// HTTP status.
//
// This step requires the Blob store to be un-suspended (readable). If the
// operator chooses not to restore billing, this script is simply not run —
// the SQL migration's second UPDATE nulls the rows it would have filled in.

const BLOB_URL_PATTERN = /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i;

/** Fails immediately, naming the missing variable, rather than proceeding
 * with `undefined` and failing later with a confusing error from deep inside
 * the Blob client. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This script reads the Blob token straight from ` +
        "the environment — export it (or add it to .env.local) before running.",
    );
  }
  return value;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface CopyCounts {
  copied: number;
  skipped: number;
  failed: number;
}

async function main(): Promise<void> {
  const BLOB_READ_WRITE_TOKEN = requireEnv("BLOB_READ_WRITE_TOKEN");

  const { prisma } = await import("@/lib/prisma");
  const { renderPath, statRenderFile, writeRenderFile } = await import("@/lib/render-storage");
  const { get, head, BlobNotFoundError, BlobStoreSuspendedError } = await import("@vercel/blob");
  const { Readable } = await import("node:stream");

  const rows = await prisma.renderJob.findMany({
    where: { outputUrl: { not: null } },
    select: { id: true, videoId: true, outputUrl: true },
    orderBy: { createdAt: "asc" },
  });

  const targets = rows.filter(
    (row): row is typeof row & { outputUrl: string } =>
      row.outputUrl !== null && BLOB_URL_PATTERN.test(row.outputUrl),
  );

  if (targets.length === 0) {
    console.log("No RenderJob rows reference a Blob URL — nothing to migrate.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${targets.length} render(s) to copy from Blob into RENDER_ROOT...`);

  const counts: CopyCounts = { copied: 0, skipped: 0, failed: 0 };

  function processed(): number {
    return counts.copied + counts.skipped + counts.failed;
  }

  for (const row of targets) {
    const location = renderPath(row.videoId);

    try {
      // Resumable: an interrupted run can simply be re-run. A destination
      // that already exists at the same size Blob reports is assumed
      // already copied and is skipped without re-downloading it.
      const existing = await statRenderFile(location);
      if (existing) {
        const remote = await head(row.outputUrl, { token: BLOB_READ_WRITE_TOKEN });
        if (remote.size === existing.sizeBytes) {
          counts.skipped += 1;
          console.log(
            `[${processed()}/${targets.length}] skip (already present, ` +
              `${formatMegabytes(existing.sizeBytes)}): video ${row.videoId}`,
          );
          continue;
        }
      }

      const result = await get(row.outputUrl, {
        access: "private",
        token: BLOB_READ_WRITE_TOKEN,
      });

      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error(
          `render for video ${row.videoId} is no longer in Blob (outputUrl ${row.outputUrl})`,
        );
      }

      // `result.stream` types as the DOM `ReadableStream` (this file's
      // tsconfig pulls in `lib: ["dom", ...]` for the Next.js app it lives
      // beside), but `Readable.fromWeb` wants Node's `stream/web` version of
      // the same runtime object — hence the cast rather than a structural
      // mismatch in the actual data.
      await writeRenderFile(
        row.videoId,
        Readable.fromWeb(result.stream as unknown as NodeReadableStream<Uint8Array>),
      );

      counts.copied += 1;
      console.log(
        `[${processed()}/${targets.length}] copied (${formatMegabytes(result.blob.size)}): ` +
          `video ${row.videoId}`,
      );
    } catch (error) {
      if (error instanceof BlobStoreSuspendedError) {
        // Store-wide, not per-row: every remaining row will fail the exact
        // same way, so hammering through the rest would just repeat this
        // failure five more times for no new information. Stop here, loudly,
        // rather than reporting "0 files copied" as if nothing was wrong.
        console.error(
          "\nThe Vercel Blob store is suspended (unreadable). Restore billing and " +
            "re-run this script, or skip it entirely — the SQL migration's second " +
            "UPDATE nulls any RenderJob rows this script did not reach.",
        );
        console.error(
          `Stopped after ${processed()}/${targets.length} render(s): ` +
            `${counts.copied} copied, ${counts.skipped} already present.`,
        );
        process.exitCode = 1;
        await prisma.$disconnect();
        return;
      }

      counts.failed += 1;
      const message =
        error instanceof BlobNotFoundError
          ? "render is missing from Blob"
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(`[${processed()}/${targets.length}] FAILED: video ${row.videoId} — ${message}`);
    }
  }

  console.log(
    `\nDone. ${counts.copied} copied, ${counts.skipped} already present, ${counts.failed} failed. ` +
      `Total render(s) matched: ${targets.length}.`,
  );

  if (counts.failed > 0) {
    console.error(
      `${counts.failed} render(s) failed to copy. Re-run this script — renders already ` +
        "copied are skipped, so only the failures above will be retried.",
    );
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nmigrate-renders failed: ${message}`);
  process.exitCode = 1;
});
