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
// produces. It is deleted, along with migrate-storage.ts and
// relink-renders.ts, once it has run for real — see Task 12. This script
// only reads from Postgres and Blob; it never writes RenderJob.outputUrl
// itself. That's `scripts/relink-renders.ts`'s job, run after this script
// and after the SQL migration (prisma/migrations/20260813120000_output_url_to_path)
// — it works entirely from what's on disk at RENDER_ROOT, so it doesn't need
// anything from this script beyond the files this script wrote. See that
// script's own comments and docs/vps-deployment.md's Step 6.4 for why the
// rewrite is split out that way. Never deletes or modifies anything in Blob.
//
// BLOB_READ_WRITE_TOKEN and RENDER_ROOT are read directly from process.env,
// not from `@/config/env` for the token (same treatment Task 6 gave the
// Supabase variables — removed from the schema once the app stopped needing
// it (Task 4), not resurrected here) — RENDER_ROOT *is* still in that schema
// for the app's own use, but this script checks it itself too, because the
// schema defaults it to a git-ignored relative path rather than failing, and
// a forgotten RENDER_ROOT here would otherwise silently copy renders into a
// throwaway directory and still report success. @vercel/blob is a
// devDependency for exactly this script; it is the same package (and the
// same `access: "private"` call shape) the app used before Task 4, so its
// `BlobStoreSuspendedError` is a documented, typed signal rather than
// something this script has to infer from a raw HTTP status — but only
// `head()` goes through the code path that produces it (`get()` does a raw
// fetch and throws a generic error for the same condition), which is why
// every row below calls `head()` first, unconditionally, even when a local
// copy already exists.
//
// This step requires the Blob store to be un-suspended (readable) to copy
// anything it hasn't already copied. If the operator chooses not to restore
// billing, this script is simply not run — the SQL migration nulls every
// row's outputUrl unconditionally, and relink-renders.ts simply finds
// nothing on disk to re-point.

const BLOB_URL_PATTERN = /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i;

/** Fails immediately, naming the missing variable, rather than proceeding
 * with `undefined` and failing later with a confusing error from deep inside
 * the Blob client — or, for RENDER_ROOT, silently succeeding against the
 * wrong directory (see the module doc comment above). */
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

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface CopyCounts {
  copied: number;
  skipped: number;
  blocked: number;
  failed: number;
}

async function main(): Promise<void> {
  const BLOB_READ_WRITE_TOKEN = requireEnv("BLOB_READ_WRITE_TOKEN");
  const RENDER_ROOT = requireEnv("RENDER_ROOT");

  const { resolve } = await import("node:path");
  const { prisma } = await import("@/lib/prisma");
  const { renderPath, statRenderFile, writeRenderFile } = await import("@/lib/render-storage");
  const { get, head, BlobNotFoundError, BlobStoreSuspendedError } = await import("@vercel/blob");
  const { Readable } = await import("node:stream");

  console.log(`Copying renders from Blob into ${resolve(RENDER_ROOT)} ...`);

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

  console.log(`Found ${targets.length} render(s) referencing Blob.`);

  const counts: CopyCounts = { copied: 0, skipped: 0, blocked: 0, failed: 0 };
  let sawSuspension = false;

  function processed(): number {
    return counts.copied + counts.skipped + counts.blocked + counts.failed;
  }

  for (const row of targets) {
    const location = renderPath(row.videoId);
    const existing = await statRenderFile(location);

    // `head()` is called unconditionally — even when `existing` already
    // looks complete — for two reasons: it's the only one of the two Blob
    // calls this script makes that routes through the SDK's error mapper,
    // so it's the only reliable way to detect a suspended store; and it
    // gives the remote size the resume check below needs. Calling it only
    // when `existing` is set (as an earlier version of this script did)
    // means a *fresh* run — no local files yet — never calls it at all,
    // so a suspended store would never be detected as such: every row
    // would instead fail with `get()`'s generic "Failed to fetch blob"
    // error, or worse, be misreported as missing entirely.
    let remote: Awaited<ReturnType<typeof head>> | undefined;
    try {
      remote = await head(row.outputUrl, { token: BLOB_READ_WRITE_TOKEN });
    } catch (error) {
      if (existing) {
        // Can't verify against Blob right now, but `writeRenderFile` only
        // ever leaves a *complete* file at `location` — it writes to a temp
        // path and atomically renames, never truncates in place — so a file
        // being there at all is good evidence a previous run already
        // finished it. Treat this as done, not failed: reporting a render
        // that's already safely on disk as a failure would tell the
        // operator to worry about something that isn't actually wrong.
        counts.skipped += 1;
        const reason =
          error instanceof BlobStoreSuspendedError
            ? "Blob store unreadable"
            : "could not verify against Blob";
        console.log(
          `[${processed()}/${targets.length}] skip (${reason}, local copy already present): ` +
            `video ${row.videoId}`,
        );
        if (error instanceof BlobStoreSuspendedError) {
          sawSuspension = true;
        }
        continue;
      }

      if (error instanceof BlobStoreSuspendedError) {
        // Store-wide, not per-row — every other row without a local copy
        // will fail the same way. Keep going anyway (rather than aborting
        // the whole script here) so rows that *do* have a local copy still
        // get counted as done above, instead of being left unexamined.
        sawSuspension = true;
        counts.blocked += 1;
        console.error(
          `[${processed()}/${targets.length}] BLOCKED (Blob store is suspended): video ${row.videoId}`,
        );
        continue;
      }

      counts.failed += 1;
      const message =
        error instanceof BlobNotFoundError
          ? "render is missing from Blob"
          : error instanceof Error
            ? error.message
            : String(error);
      console.error(`[${processed()}/${targets.length}] FAILED: video ${row.videoId} — ${message}`);
      continue;
    }

    // Resumable: an interrupted run can simply be re-run. A destination
    // that already exists at the same size Blob reports is assumed
    // already copied and is skipped without re-downloading it.
    if (existing && existing.sizeBytes === remote.size) {
      counts.skipped += 1;
      console.log(
        `[${processed()}/${targets.length}] skip (already present, ` +
          `${formatMegabytes(existing.sizeBytes)}): video ${row.videoId}`,
      );
      continue;
    }

    try {
      const result = await get(row.outputUrl, {
        access: "private",
        token: BLOB_READ_WRITE_TOKEN,
      });

      if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error(
          `unexpected empty response fetching video ${row.videoId}'s render from Blob`,
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
        sawSuspension = true;
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
    `\nDone. ${counts.copied} copied, ${counts.skipped} already present, ` +
      `${counts.blocked} blocked by a suspended store, ${counts.failed} failed. ` +
      `Total render(s) matched: ${targets.length}.`,
  );

  if (sawSuspension) {
    console.error(
      "\nThe Vercel Blob store is suspended (unreadable) for at least one render this run " +
        "touched. Restore billing and re-run this script to pick up whatever it didn't reach — " +
        "already-copied renders are skipped, so only what's still missing will be retried.",
    );
  }

  console.log(
    "\nNext: run scripts/relink-renders.ts (after the SQL migration has nulled outputUrl) to " +
      "point RenderJob rows at whatever this script copied — it works from what's on disk, so " +
      "nothing here needs to be passed to it.",
  );

  if (counts.failed > 0 || counts.blocked > 0) {
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nmigrate-renders failed: ${message}`);
  process.exitCode = 1;
});
