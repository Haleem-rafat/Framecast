import { config } from "dotenv";

// .env.local holds locally-pulled values written by `vercel env pull`; it must
// load first so it overrides the local docker-compose defaults in .env.
// Mirrors src/lib/prisma.ts and prisma.config.ts exactly.
config({ path: ".env.local" });
config({ path: ".env" });

// Everything below is imported dynamically, inside main(), and never at module
// top level — `@/config/env` (and `@/lib/storage`, which imports it) reads
// `process.env` at import time, so a static import here would run before the
// dotenv calls above take effect and every env var would read as unset.
//
// One-shot migration script (see Task 10 of the OVH migration): copies every
// object out of Supabase Storage and into STORAGE_ROOT, byte for byte, at the
// identical relative path. It is deleted, along with migrate-renders.ts, once
// it has run for real — see Task 12. Never deletes or modifies anything in
// Supabase; this is a copy, not a move.
//
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET are read
// directly from process.env rather than from `@/config/env` — Task 6 removed
// them from that schema on purpose, once the app itself stopped needing them,
// and this script deliberately does not resurrect them there. This is the
// last thing in the repository that still needs the Supabase client; it is a
// devDependency for exactly that reason, not a runtime one.
//
// MIGRATE_ALLOW_OVERSIZE=true lifts `putObject`'s 50MB per-object cap for this
// script only (see `allowOversize` in src/lib/storage.ts). Default off, because
// copying an unexpectedly huge object onto a 40GB disk should be a decision,
// not a default — but there is a real one to make: the cap's own comment
// records a 70.9MB clip, and such an object fails identically on every re-run,
// so "investigate and re-run" never clears it. Leaving it uncopied is not
// neutral. `reclaimClipStorage` in publish.service.ts passes every clip path
// for a video to `removeObjects`, which throws if any one of them is missing,
// so a single uncopied clip blocks reclaim for that whole video forever and
// strands ~400MB. Re-run with the flag set; already-copied objects are skipped.
//
// STORAGE_ROOT *is* still in `@/config/env`'s schema, for the app's own use —
// but that schema defaults it to a git-ignored relative path rather than
// failing when it's unset, which is exactly wrong for this script: a
// forgotten STORAGE_ROOT here would silently copy the entire bucket into a
// throwaway directory and still print "Done, N copied" as if it worked. This
// script checks it itself, the same way it checks the Supabase variables.

/** Fails immediately, naming the missing variable, rather than proceeding
 * with `undefined` and failing later with a confusing error from deep inside
 * the Supabase client. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This script reads Supabase credentials straight ` +
        "from the environment — export it (or add it to .env.local) before running.",
    );
  }
  return value;
}

/** One decimal place, matching src/lib/storage.ts's own formatMegabytes, so
 * a log line reads the same way an app-side error would. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface CopyCounts {
  copied: number;
  skipped: number;
  failed: number;
}

async function main(): Promise<void> {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const SUPABASE_STORAGE_BUCKET = requireEnv("SUPABASE_STORAGE_BUCKET");
  const STORAGE_ROOT = requireEnv("STORAGE_ROOT");
  // Opt-in, exactly "true" — see this file's header for when to set it and
  // what leaving an object uncopied actually costs.
  const ALLOW_OVERSIZE = process.env.MIGRATE_ALLOW_OVERSIZE === "true";

  const { resolve } = await import("node:path");
  const { createClient } = await import("@supabase/supabase-js");
  const { ensureBucket, objectContentType, objectSizeBytes, putObject } = await import(
    "@/lib/storage"
  );

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const bucket = supabase.storage.from(SUPABASE_STORAGE_BUCKET);

  // Derived from `list()`'s own return type rather than imported by name, so
  // this can't drift from whichever storage-js version supabase-js pulls in.
  type ListResult = Awaited<ReturnType<typeof bucket.list>>["data"];
  type FileEntry = NonNullable<ListResult>[number];

  await ensureBucket();

  const counts: CopyCounts = { copied: 0, skipped: 0, failed: 0 };
  const PAGE_SIZE = 100;

  function processed(): number {
    return counts.copied + counts.skipped + counts.failed;
  }

  /** Supabase's `list()` returns one directory level at a time, paginated —
   * this drains every page at `prefix` before returning. A folder entry is
   * one whose `id` is null; that's the documented, standard way this API
   * distinguishes a folder from a file (files always carry a real id and
   * `metadata`, folders never do). */
  async function listLevel(prefix: string): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    let offset = 0;

    for (;;) {
      const { data, error } = await bucket.list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

      if (error) {
        throw new Error(`Listing "${prefix || "/"}" failed: ${error.message}`);
      }
      if (!data || data.length === 0) {
        break;
      }

      entries.push(...data);
      if (data.length < PAGE_SIZE) {
        break;
      }
      offset += PAGE_SIZE;
    }

    return entries;
  }

  async function copyObject(path: string, entry: FileEntry): Promise<void> {
    const expectedSize = entry.metadata?.size;

    // Resumable: an interrupted run can simply be re-run. A destination that
    // already exists at the same size Supabase reports is assumed already
    // copied and is skipped without re-downloading it — but only if its
    // `.type` sidecar is there too. `putObject` writes the object and its
    // sidecar as two separate calls; a process killed between them leaves a
    // full-size object with no sidecar, and a size-only check would skip it
    // forever, leaving `objectContentType()` returning null for that object
    // permanently (see this script's own module comment on why that matters
    // for thumbnails).
    if (typeof expectedSize === "number") {
      const [existingSize, existingContentType] = await Promise.all([
        objectSizeBytes(path),
        objectContentType(path),
      ]);
      if (existingSize === expectedSize && existingContentType !== null) {
        counts.skipped += 1;
        console.log(`[${processed()}] skip (already present, ${formatMegabytes(expectedSize)}): ${path}`);
        return;
      }
    }

    try {
      const { data, error } = await bucket.download(path);

      if (error || !data) {
        throw new Error(error?.message ?? "download returned no data");
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      // `||`, not `??`: Supabase records `mimetype: ""` for an object
      // uploaded without a declared content type, and a downloaded blob's
      // own `.type` is `""` in the same situation — both are falsy, not
      // null/undefined, so `??` would let an empty string through and write
      // an empty sidecar, which is exactly the case this fallback exists for.
      const contentType = entry.metadata?.mimetype || data.type || "application/octet-stream";

      await putObject(path, buffer, contentType, { allowOversize: ALLOW_OVERSIZE });

      counts.copied += 1;
      console.log(
        `[${processed()}] copied (${formatMegabytes(buffer.byteLength)}, ${contentType}): ${path}`,
      );
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${processed()}] FAILED: ${path} — ${message}`);
      // A size refusal is the one failure that is guaranteed to repeat
      // identically on every re-run, so "re-run this script" is useless advice
      // for it. Say so at the point it happens rather than only in the summary.
      if (message.includes("per-object limit")) {
        console.error(
          "         This will fail the same way every re-run. Set " +
            "MIGRATE_ALLOW_OVERSIZE=true to copy it anyway — see this " +
            "script's header, and Step 6.1 of docs/vps-deployment.md.",
        );
      }
    }
  }

  async function walk(prefix: string): Promise<void> {
    const entries = await listLevel(prefix);

    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const isFolder = entry.id === null;

      if (isFolder) {
        await walk(path);
      } else {
        await copyObject(path, entry);
      }
    }
  }

  console.log(
    `Copying from Supabase bucket "${SUPABASE_STORAGE_BUCKET}" into ${resolve(STORAGE_ROOT)} ...`,
  );
  await walk("");

  console.log(
    `\nDone. ${counts.copied} copied, ${counts.skipped} already present, ${counts.failed} failed. ` +
      `Total objects seen: ${processed()}.`,
  );

  if (counts.failed > 0) {
    console.error(
      `${counts.failed} object(s) failed to copy. Re-run this script — objects already ` +
        "copied are skipped, so only the failures above will be retried.",
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nmigrate-storage failed: ${message}`);
  process.exitCode = 1;
});
