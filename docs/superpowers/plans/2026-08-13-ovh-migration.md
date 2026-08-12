# OVH Self-Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Framecast's app, render worker, Postgres and every stored file onto one OVH VPS in two environments, then cancel Vercel and Supabase.

**Architecture:** Two storage modules are rewritten against the local filesystem behind their existing interfaces. A Docker Compose stack runs Caddy, one Postgres with two databases, two Next.js apps and two workers. Images are built by GitHub Actions and pulled by the server. Data is migrated with scripts, cut over by DNS, and backed up nightly to Cloudflare R2.

**Tech Stack:** Next.js 15, Prisma 7, PostgreSQL 17, Docker Compose, Caddy 2, GitHub Actions, Cloudflare R2, Ubuntu 26.04.

## Global Constraints

- The repository is **PUBLIC**. No secrets in code, tests, commit messages or committed config. Every credential lives in a server-side `.env` file that is never committed.
- `CREDENTIAL_ENCRYPTION_KEY` must reach the new server **unchanged**, or every stored provider API key becomes undecryptable with no recovery.
- **Nothing merges to `main` until cutover is verified.** All work lands on the branch. The filesystem storage rewrite would break the current Vercel deployment, whose filesystem is ephemeral and not shared with the worker.
- `pnpm typecheck` and `pnpm lint` must pass before every commit.
- Tests never call YouTube, ElevenLabs, or an image model. `fetch`, providers and process spawners are injected.
- Tests create their own throwaway user via `src/test/fixtures.ts` and **never** call `prisma.user.findFirstOrThrow()`.
- Tests run against a remote database shared with the operator's real data. Clean up everything a test writes, even when an assertion fails partway.
- The server is `vps-940eaa43.vps.ovh.net` / `51.38.80.36`, London, Ubuntu 26.04, 2 vCPU, 4 GB RAM, 40 GB disk.
- Commit messages: lowercase after the type prefix, explain the reasoning, no bullet-point diff summaries. End each body with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

**Created:**
- `src/lib/http-range.ts` — RFC 7233 `Range` header parsing. Pure, no I/O.
- `src/lib/http-range.test.ts`
- `src/lib/render-storage.ts` — finished renders on local disk. Replaces `blob-render-storage.ts`.
- `src/lib/render-storage.test.ts`
- `src/app/api/videos/[id]/narration/route.ts` — streams narration audio.
- `scripts/migrate-storage.ts` — copies Supabase Storage objects to disk.
- `scripts/migrate-renders.ts` — copies Vercel Blob renders to disk.
- `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/backup.sh`, `deploy/framecast-backup.service`, `deploy/framecast-backup.timer`
- `.github/workflows/build-images.yml`
- `docs/vps-deployment.md` — provisioning, deploy and cutover runbook.

**Modified:**
- `src/lib/storage.ts` — Supabase client replaced with filesystem I/O; `signedUrl` deleted.
- `src/lib/storage.test.ts` — rewritten against the filesystem.
- `src/config/env.ts` — `STORAGE_ROOT` and `RENDER_ROOT` added; Supabase and Blob variables removed.
- `src/app/(dashboard)/videos/[id]/page.tsx` — `resolvePreviewAsset` points at the narration route.
- `src/app/api/videos/[id]/file/route.ts` — imports `render-storage`; parses ranges itself.
- `src/services/publish.service.ts` — deletes the local render after a successful publish.
- `.env.example`, `docker-compose.yml`, `Dockerfile`, `worker/Dockerfile`

**Deleted:**
- `src/lib/blob-render-storage.ts` and its test — replaced by `render-storage.ts`.

---

### Task 1: RFC 7233 range parsing

Vercel Blob implemented HTTP range semantics server-side; a filesystem does not. This is the pure function that replaces it, isolated so it can be tested exhaustively without touching disk.

**Files:**
- Create: `src/lib/http-range.ts`
- Test: `src/lib/http-range.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRangeHeader(header: string | null | undefined, sizeBytes: number): ByteRange | null | "unsatisfiable"` and `interface ByteRange { start: number; end: number }`. Task 4 uses both.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/http-range.test.ts
import { describe, expect, it } from "vitest";

import { parseRangeHeader } from "@/lib/http-range";

describe("parseRangeHeader", () => {
  it("returns null when no Range header was sent", () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range as running to the last byte", () => {
    expect(parseRangeHeader("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("parses a suffix range as the final N bytes", () => {
    expect(parseRangeHeader("bytes=-500", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("clamps an end past the last byte, which browsers send routinely", () => {
    expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("reports a start at or past the end of the file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toBe("unsatisfiable");
  });

  it("treats a suffix longer than the file as the whole file", () => {
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  // A multi-range request is legal HTTP and would need a multipart/byteranges
  // response. Serving the whole file instead is a permitted, and far simpler,
  // answer than implementing multipart for a video player that never asks.
  it("serves the whole file for a multi-range request", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", 1000)).toBeNull();
  });

  it("ignores a malformed or non-bytes range", () => {
    expect(parseRangeHeader("items=0-99", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=abc-def", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=-", 1000)).toBeNull();
    expect(parseRangeHeader("", 1000)).toBeNull();
  });

  it("reports any range against an empty file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toBe("unsatisfiable");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/http-range.test.ts`
Expected: FAIL — cannot resolve `@/lib/http-range`.

- [ ] **Step 3: Implement the parser**

```typescript
// src/lib/http-range.ts
/**
 * Parses a single-range HTTP `Range` header against a known file size.
 *
 * This exists because finished renders moved from Vercel Blob to local disk.
 * Blob implemented RFC 7233 server-side and `/api/videos/[id]/file` merely
 * forwarded the header to it; a filesystem answers no such thing, so the
 * parsing that route deleted when it adopted Blob has to come back — this
 * time isolated from any I/O so every edge can be tested cheaply.
 *
 * Returns `null` to mean "serve the whole file": no header, a malformed one,
 * or a multi-range request, which is legal but would require a
 * `multipart/byteranges` body no video player in this app ever asks for.
 * Returns `"unsatisfiable"` for a range that starts at or past the end, which
 * the caller must answer with 416 rather than silently serving something else.
 */
export interface ByteRange {
  start: number;
  end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(
  header: string | null | undefined,
  sizeBytes: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) {
    return null;
  }

  const match = RANGE_PATTERN.exec(header.trim());

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;

  // `bytes=-` matches the pattern but names neither bound.
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  // An empty file can satisfy no range at all, including `bytes=0-`.
  if (sizeBytes === 0) {
    return "unsatisfiable";
  }

  const lastByte = sizeBytes - 1;

  // Suffix form: `bytes=-500` means the final 500 bytes, not "up to byte 500".
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, sizeBytes - suffixLength), end: lastByte };
  }

  const start = Number(rawStart);

  if (start > lastByte) {
    return "unsatisfiable";
  }

  // An absent or over-long end is clamped rather than rejected: browsers
  // routinely ask for more than exists at the tail of a file.
  const end = rawEnd === "" ? lastByte : Math.min(Number(rawEnd), lastByte);

  if (end < start) {
    return null;
  }

  return { start, end };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/http-range.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/http-range.ts src/lib/http-range.test.ts
git commit -m "feat: parse byte ranges now that renders live on a disk

Vercel Blob implemented RFC 7233 for us and the streaming route just
forwarded the browser's Range header to it. A filesystem answers no such
thing, so the parsing that route deleted when it adopted Blob has to come
back. Isolated from I/O so the suffix, clamping and unsatisfiable cases are
cheap to test exhaustively rather than discovered from a seek that lands
past the end of a file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Object storage on local disk

`src/lib/storage.ts` holds clips, narration, captions, music, thumbnails and logos. Its nine exports become filesystem operations behind the same signatures, with one deletion covered in Task 3.

**Files:**
- Modify: `src/lib/storage.ts` (whole file)
- Modify: `src/lib/storage.test.ts` (whole file)
- Modify: `src/config/env.ts` — add `STORAGE_ROOT`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: unchanged signatures for `storagePath`, `ensureBucket`, `putObject`, `getObject`, `removeObjects`, `objectSizeBytes`, `objectContentType`. **`signedUrl` is removed** — Task 3 replaces its only caller.

**Why a content-type sidecar rather than inferring from the extension:** `objectContentType()` is load-bearing. `publish.service.ts` reads it to set the `Content-Type` on YouTube's `thumbnails.set`, and `thumbnail.service.ts`'s composite-failure path can legitimately store PNG bytes under a name chosen before the format was known. Inference would work today and fail silently the first time it did not.

- [ ] **Step 1: Add `STORAGE_ROOT` to the environment schema**

In `src/config/env.ts`, inside `serverEnvSchema`, replace the three `SUPABASE_*` entries with:

```typescript
  /**
   * Where objects live on disk. Absolute in every deployed environment
   * (`/srv/framecast/<env>/storage`); defaults to a git-ignored directory so
   * `pnpm dev` and the test suite work with no configuration.
   */
  STORAGE_ROOT: z.string().min(1).default(".framecast/storage"),
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/lib/storage.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let root: string;

// The module reads STORAGE_ROOT at import time, so the temp directory has to
// exist and be in the environment before the first import.
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "framecast-storage-"));
  vi.stubEnv("STORAGE_ROOT", root);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function storage() {
  return import("@/lib/storage");
}

describe("storagePath", () => {
  it("files an object under its owner and kind", async () => {
    const { storagePath } = await storage();
    expect(storagePath("abc", "clips", "clip-0.mp4")).toBe("videos/abc/clips/clip-0.mp4");
  });

  it("refuses a filename that would escape the prefix", async () => {
    const { storagePath } = await storage();
    expect(() => storagePath("abc", "clips", "../escape.mp4")).toThrow();
    expect(() => storagePath("abc", "clips", "nested/clip.mp4")).toThrow();
  });
});

describe("putObject / getObject", () => {
  it("round-trips binary bytes unchanged", async () => {
    const { putObject, getObject, storagePath } = await storage();
    const path = storagePath("round-trip", "clips", "a.mp4");
    // Includes bytes above 0x7f: a UTF-8 round trip would corrupt these.
    const body = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);

    await putObject(path, body, "video/mp4");

    expect(await getObject(path)).toEqual(body);
  });

  it("creates the directory tree on the way", async () => {
    const { putObject, getObject, storagePath } = await storage();
    const path = storagePath("deep-tree", "thumbnails", "thumb.jpg");

    await putObject(path, Buffer.from("x"), "image/jpeg");

    expect(await getObject(path)).toEqual(Buffer.from("x"));
  });

  it("overwrites an existing object rather than appending", async () => {
    const { putObject, getObject, storagePath } = await storage();
    const path = storagePath("overwrite", "audio", "narration.mp3");

    await putObject(path, Buffer.from("first"), "audio/mpeg");
    await putObject(path, Buffer.from("second"), "audio/mpeg");

    expect(await getObject(path)).toEqual(Buffer.from("second"));
  });

  it("refuses an object over the per-object limit", async () => {
    const { putObject, storagePath } = await storage();
    const path = storagePath("too-big", "clips", "huge.mp4");

    await expect(
      putObject(path, Buffer.alloc(51 * 1024 * 1024), "video/mp4"),
    ).rejects.toThrow(/exceeds/);
  });

  it("throws for an object that is not there", async () => {
    const { getObject, storagePath } = await storage();
    await expect(getObject(storagePath("absent", "clips", "nope.mp4"))).rejects.toThrow();
  });
});

describe("objectContentType", () => {
  it("returns exactly what putObject was told, not a guess from the extension", async () => {
    const { putObject, objectContentType, storagePath } = await storage();
    // A .jpg holding PNG bytes: precisely what thumbnail.service.ts's
    // composite-failure path can produce, and what the YouTube thumbnail
    // upload reads to set its Content-Type.
    const path = storagePath("mislabelled", "thumbnails", "thumb.jpg");

    await putObject(path, Buffer.from("x"), "image/png");

    expect(await objectContentType(path)).toBe("image/png");
  });

  it("returns null for an object that is not there", async () => {
    const { objectContentType, storagePath } = await storage();
    expect(await objectContentType(storagePath("absent", "thumbnails", "x.jpg"))).toBeNull();
  });
});

describe("objectSizeBytes", () => {
  it("reports the stored size", async () => {
    const { putObject, objectSizeBytes, storagePath } = await storage();
    const path = storagePath("sized", "clips", "b.mp4");

    await putObject(path, Buffer.alloc(2048), "video/mp4");

    expect(await objectSizeBytes(path)).toBe(2048);
  });

  it("returns null rather than throwing for a missing object", async () => {
    const { objectSizeBytes, storagePath } = await storage();
    expect(await objectSizeBytes(storagePath("absent", "clips", "x.mp4"))).toBeNull();
  });
});

describe("removeObjects", () => {
  it("deletes the object and its content-type sidecar", async () => {
    const { putObject, removeObjects, objectSizeBytes, objectContentType, storagePath } =
      await storage();
    const path = storagePath("removable", "clips", "c.mp4");
    await putObject(path, Buffer.from("x"), "video/mp4");

    await removeObjects([path]);

    expect(await objectSizeBytes(path)).toBeNull();
    expect(await objectContentType(path)).toBeNull();
  });

  it("is a no-op on an empty list", async () => {
    const { removeObjects } = await storage();
    await expect(removeObjects([])).resolves.toBeUndefined();
  });

  // publish.service.ts's clip reclaim deletes the objects *before* soft-
  // deleting their rows, specifically so a failure here leaves the rows live
  // rather than orphaning bytes. That ordering only protects anything if a
  // partial delete is reported as a failure.
  it("throws when an object it was asked to delete was not there", async () => {
    const { putObject, removeObjects, storagePath } = await storage();
    const present = storagePath("partial", "clips", "here.mp4");
    const absent = storagePath("partial", "clips", "gone.mp4");
    await putObject(present, Buffer.from("x"), "video/mp4");

    await expect(removeObjects([present, absent])).rejects.toThrow(/gone\.mp4/);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — the module still calls Supabase.

- [ ] **Step 4: Rewrite `src/lib/storage.ts`**

Keep `storagePath`, its doc comment, and `StorageKind` exactly as they are. Replace everything else:

```typescript
import "server-only";

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";

// ... StorageKind and storagePath unchanged ...

/**
 * The per-object cap this codebase holds itself to. Discovered live: a 70.9MB
 * clip failed upload before any limit was set anywhere here.
 *
 * The original reason for this number — Supabase's per-object ceiling — is
 * gone now that objects live on a local disk. The number stays because the
 * disk is 40GB and finite, and because stock footage is filtered well under it
 * upstream (see stock-footage.provider.ts's MAX_CLIP_SIZE_BYTES); this is the
 * backstop, not the primary defence. Finished renders do not pass through
 * here at all — they are ~170MB and go to render-storage.ts.
 */
const OBJECT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

/** One decimal place, so a refusal reads "51.2MB exceeds the 50.0MB limit"
 * rather than two numbers that both round to 50 and look like a bug. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const ROOT = resolve(env.STORAGE_ROOT);

/**
 * Resolves a storage path to an absolute file path, refusing anything that
 * escapes the root. `storagePath` already validates filenames, but this is
 * the boundary where a bad path becomes a write to someone else's disk, and
 * every caller of `putObject` does not necessarily come through
 * `storagePath` — a path read back out of the database does not.
 */
function resolveObject(path: string): string {
  const absolute = resolve(join(ROOT, path));

  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) {
    throw new ValidationError(`Unsafe storage path: "${path}"`);
  }

  return absolute;
}

/** Content types are stored beside the object rather than inferred from the
 * extension. `objectContentType` is load-bearing — publish.service.ts reads it
 * to set the Content-Type on YouTube's thumbnails.set, and a thumbnail whose
 * composite failed can hold PNG bytes under a .jpg name. Inference would work
 * today and be wrong silently the first time it was not. */
function typeSidecar(absolute: string): string {
  return `${absolute}.type`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Idempotent. Named for its Supabase ancestor so every caller keeps working;
 * on a filesystem it is a directory creation. */
export async function ensureBucket(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
}

export async function putObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  if (body.byteLength > OBJECT_SIZE_LIMIT_BYTES) {
    throw new InternalError(
      `Refusing to store ${path}: ${formatMegabytes(body.byteLength)} exceeds ` +
        `the ${formatMegabytes(OBJECT_SIZE_LIMIT_BYTES)} per-object limit.`,
    );
  }

  const absolute = resolveObject(path);

  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
    await writeFile(typeSidecar(absolute), contentType, "utf8");
  } catch (error) {
    throw new InternalError(
      `Write failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return path;
}

export async function getObject(path: string): Promise<Buffer> {
  try {
    return await readFile(resolveObject(path));
  } catch (error) {
    throw new InternalError(
      `Read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Permanently deletes objects. Every other storage-owning row in this codebase
 * is soft-deleted while its object is left in place on purpose; this is the one
 * escape hatch, used by publish.service.ts to reclaim section clips once a
 * video is PUBLISHED.
 *
 * That caller deletes the objects *before* soft-deleting the matching rows,
 * specifically so a failure here leaves the rows live rather than orphaning
 * bytes. The ordering only protects anything if a partial delete is reported
 * as a failure, so a path that was not there is an error rather than a
 * silently acceptable no-op — the same contract the Supabase implementation
 * enforced by counting what came back.
 */
export async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const missing: string[] = [];

  for (const path of paths) {
    const absolute = resolveObject(path);

    try {
      await rm(absolute);
    } catch (error) {
      if (isMissing(error)) {
        missing.push(path);
        continue;
      }
      throw new InternalError(
        `Delete failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The sidecar may legitimately be absent for an object written before
    // content types were recorded, so its removal is best-effort.
    await rm(typeSidecar(absolute), { force: true });
  }

  if (missing.length > 0) {
    throw new InternalError(
      `Delete removed ${paths.length - missing.length}/${paths.length} object(s) — ` +
        `missing e.g. ${missing[0]}.`,
    );
  }
}

export async function objectSizeBytes(path: string): Promise<number | null> {
  try {
    return (await stat(resolveObject(path))).size;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new InternalError(
      `Could not stat ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The content type recorded when the object was written — as opposed to
 * whatever a caller believes it uploaded. Read from the sidecar, so a
 * thumbnail stored as PNG through the composite-failure path reports
 * image/png even though its name ends in .jpg.
 */
export async function objectContentType(path: string): Promise<string | null> {
  try {
    return (await readFile(typeSidecar(resolveObject(path)), "utf8")).trim() || null;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new InternalError(
      `Could not read the content type for ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the storage directory to `.gitignore`**

```bash
echo ".framecast/" >> .gitignore
```

Skip if `.framecast/` is already ignored.

- [ ] **Step 7: Commit**

`pnpm typecheck` will still fail on `signedUrl`'s caller — that is Task 3's job. Commit only if typecheck's sole remaining errors are that caller; otherwise fix what else broke first.

```bash
git add src/lib/storage.ts src/lib/storage.test.ts src/config/env.ts .gitignore
git commit -m "feat: store objects on disk instead of in supabase

Clips, narration, captions, thumbnails and logos move to the local
filesystem behind the same interface, which is what lets the app and the
worker share one machine instead of a hosted bucket.

Content types are written to a sidecar rather than inferred from the file
extension. objectContentType is load-bearing — publish.service.ts reads it to
set the Content-Type on YouTube's thumbnails.set, and a thumbnail whose
composite failed can hold PNG bytes under a .jpg name. Inference would work
today and be wrong silently the first time it was not.

A partial delete stays an error rather than becoming a tolerated no-op: the
clip reclaim deletes objects before soft-deleting their rows precisely so a
failure leaves the rows live, and that ordering protects nothing if a missing
path passes quietly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Serve narration through a route, delete `signedUrl`

`signedUrl` returned a Supabase URL whose signature carried the authorisation. It has one non-test caller. Rather than invent a token scheme for a single user, the narration follows the route the render already takes.

**Files:**
- Create: `src/app/api/videos/[id]/narration/route.ts`
- Modify: `src/app/(dashboard)/videos/[id]/page.tsx` — `resolvePreviewAsset` and its imports
- Modify: `src/lib/storage.ts` — remove `signedUrl` if Task 2 left it

**Interfaces:**
- Consumes: `getObject`, `objectSizeBytes`, `storagePath` from Task 2.
- Produces: `GET /api/videos/:id/narration`, returning the narration audio for a video the session owns.

- [ ] **Step 1: Read the route this one mirrors**

Read `src/app/api/videos/[id]/file/route.ts` in full. The new route copies its shape exactly: session first, ownership second, bytes last. Its doc comment already argues why a route resolving the object server-side from a video id beats handing the client a URL — that argument is the reason `signedUrl` is going.

- [ ] **Step 2: Write the route**

```typescript
// src/app/api/videos/[id]/narration/route.ts
import { NextResponse, type NextRequest } from "next/server";

import { isAppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getObject, objectContentType } from "@/lib/storage";
import { getSession } from "@/server/session";

/**
 * Streams a video's narration audio so the detail page can play it.
 *
 * This replaces a Supabase signed URL. That URL carried its own
 * authorisation, which meant anyone who obtained one — a leaked link, a peek
 * in devtools — could read the object for an hour with no session at all.
 * Resolving the object here from the video id, behind the same ownership
 * check every service in this codebase performs, is strictly stronger, and it
 * removes the expiry the page's own comments apologised for.
 *
 * Narration is a few megabytes, so it is read whole rather than streamed with
 * range support. The render, which is ~170MB, gets that treatment in
 * `/api/videos/[id]/file`.
 *
 * Node runtime, not Edge: Prisma's query engine requires it.
 */
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session) {
      throw new UnauthorizedError();
    }

    const { id: videoId } = await params;

    // A video that belongs to someone else must look exactly like one that
    // does not exist.
    const asset = await prisma.videoAsset.findFirst({
      where: {
        video: { id: videoId, userId: session.user.id, deletedAt: null },
        kind: "NARRATION",
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    if (!asset) {
      throw new NotFoundError("This video has no narration.");
    }

    const [body, contentType] = await Promise.all([
      getObject(asset.storagePath),
      objectContentType(asset.storagePath),
    ]);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType ?? "audio/mpeg",
        "Content-Length": String(body.byteLength),
        // The operator's unpublished work: never cached by a shared proxy.
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json(error.serialize(), { status: error.httpStatus });
    }
    throw error;
  }
}
```

**Before writing this, confirm the asset model.** Read `prisma/schema.prisma` for the model holding narration and the exact enum member — the query above assumes `VideoAsset` with `kind: "NARRATION"` and a `storagePath` column. If the names differ, use the real ones; do not adapt the schema to the plan.

- [ ] **Step 3: Point the page at the route**

In `src/app/(dashboard)/videos/[id]/page.tsx`, replace `resolvePreviewAsset` and delete the now-unused `signedUrl` import and `SIGNED_URL_TTL_SECONDS`:

```typescript
/**
 * The narration's counterpart to `resolveRenderAsset` below: a URL the browser
 * can play, plus (best-effort) its size. No signed URL to mint — the browser
 * is pointed at this app's own route, which resolves the object from the video
 * id behind a session check. Never throws: this page's narration is worth
 * showing even if the size lookup fails.
 */
async function resolvePreviewAsset(
  videoId: string,
  storagePath: string,
): Promise<{ url: string; sizeBytes: number | null }> {
  const sizeBytes = await objectSizeBytes(storagePath).catch(() => null);
  return { url: `/api/videos/${videoId}/narration`, sizeBytes };
}
```

Update its call site to pass the video id. The return type is no longer nullable — a URL that is a constant string cannot fail to be produced — so remove any `null` handling that only existed for the signing failure, and leave the "couldn't load" state reachable through the player's own error handling.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint
npx vitest run src/lib/storage.test.ts
```
Expected: typecheck clean — this is the task that makes it clean again — and storage tests still passing.

Then start the app (`pnpm dev`), open a video with narration, and confirm the player plays it. This route is the one piece of the storage rewrite that no unit test covers end to end.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/videos/\[id\]/narration/route.ts "src/app/(dashboard)/videos/[id]/page.tsx" src/lib/storage.ts
git commit -m "feat: serve narration from a route instead of a signed url

A Supabase signed URL carried its own authorisation, so anyone holding one
could read the object for an hour with no session. It had exactly one caller.
Rather than invent a token scheme for a single user, narration now takes the
same route the render already takes: resolved server-side from the video id,
behind the ownership check every service here performs.

Stronger than what it replaces, and it deletes the one-hour expiry the page's
own comments apologised for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Finished renders on local disk

`blob-render-storage.ts` becomes `render-storage.ts`, backed by the filesystem, using Task 1's range parser. The module keeps its name-honesty: nothing here is a blob any more.

**Files:**
- Create: `src/lib/render-storage.ts`
- Create: `src/lib/render-storage.test.ts`
- Delete: `src/lib/blob-render-storage.ts` and `src/lib/blob-render-storage.test.ts`
- Modify: `src/app/api/videos/[id]/file/route.ts` — import path
- Modify: `src/services/render.service.ts`, `src/services/publish.service.ts`, `src/app/(dashboard)/videos/[id]/page.tsx` — import paths
- Modify: `src/config/env.ts` — add `RENDER_ROOT`, remove `BLOB_READ_WRITE_TOKEN`

**Interfaces:**
- Consumes: `parseRangeHeader`, `ByteRange` from Task 1.
- Produces: `renderPath(videoId)`, `writeRenderFile(videoId, source)`, `statRenderFile(location)`, `getRenderFile(videoId, location, rangeHeader?)`, `deleteRenderFile(location)`, `RenderFileMissingError`, `RenderFileStat`, `RenderFileContent`. Task 5 uses `deleteRenderFile`.

**The stored value changes meaning.** `writeRenderFile` returned an absolute Blob URL; it now returns a path relative to the render root, e.g. `renders/<uuid>.mp4`. Existing `outputUrl` values are rewritten in Task 10. Every parameter named `url` is renamed `location` so no reader assumes it is fetchable.

- [ ] **Step 1: Add `RENDER_ROOT` to the environment schema**

In `src/config/env.ts`, replace the `BLOB_READ_WRITE_TOKEN` entry with:

```typescript
  /**
   * Where finished renders live. Separate from STORAGE_ROOT because renders
   * are ~170MB each and are deleted once YouTube confirms the upload, while
   * objects under STORAGE_ROOT have their own lifecycles. Keeping them apart
   * makes "how much disk are renders using" answerable with `du` on one
   * directory.
   */
  RENDER_ROOT: z.string().min(1).default(".framecast/renders"),
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/lib/render-storage.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "11111111-2222-3333-4444-555555555555";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "framecast-renders-"));
  vi.stubEnv("RENDER_ROOT", root);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function renderStorage() {
  return import("@/lib/render-storage");
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("renderPath", () => {
  it("is deterministic on the video id so a re-render overwrites", async () => {
    const { renderPath } = await renderStorage();
    expect(renderPath(VIDEO_ID)).toBe(`renders/${VIDEO_ID}.mp4`);
  });

  it("refuses anything that is not a bare uuid", async () => {
    const { renderPath } = await renderStorage();
    expect(() => renderPath("../escape")).toThrow();
    expect(() => renderPath("not-a-uuid")).toThrow();
  });
});

describe("writeRenderFile / getRenderFile", () => {
  it("round-trips bytes and reports where it put them", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const body = Buffer.from("abcdefghijklmnopqrstuvwxyz");

    const location = await writeRenderFile(VIDEO_ID, body);
    expect(location).toBe(`renders/${VIDEO_ID}.mp4`);

    const content = await getRenderFile(VIDEO_ID, location);
    expect(content).not.toBeNull();
    expect(await readAll(content!.stream)).toEqual(body);
    expect(content!.sizeBytes).toBe(26);
    expect(content!.contentLength).toBe(26);
    expect(content!.contentRange).toBeNull();
    expect(content!.contentType).toBe("video/mp4");
  });

  it("serves a byte range and describes it the way the route expects", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("abcdefghijklmnopqrstuvwxyz"));

    const content = await getRenderFile(VIDEO_ID, location, "bytes=5-9");

    expect(await readAll(content!.stream)).toEqual(Buffer.from("fghij"));
    expect(content!.contentLength).toBe(5);
    expect(content!.sizeBytes).toBe(26);
    expect(content!.contentRange).toBe("bytes 5-9/26");
  });

  it("serves an open-ended range to the last byte", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("abcdefghijklmnopqrstuvwxyz"));

    const content = await getRenderFile(VIDEO_ID, location, "bytes=20-");

    expect(await readAll(content!.stream)).toEqual(Buffer.from("uvwxyz"));
    expect(content!.contentRange).toBe("bytes 20-25/26");
  });

  it("reports an unsatisfiable range distinctly from a missing file", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("short"));

    expect(await getRenderFile(VIDEO_ID, location, "bytes=500-")).toBe("unsatisfiable");
  });

  it("returns null for a render that is not there", async () => {
    const { getRenderFile } = await renderStorage();
    expect(await getRenderFile(VIDEO_ID, "renders/does-not-exist.mp4")).toBeNull();
  });
});

describe("statRenderFile", () => {
  it("reports the size", async () => {
    const { writeRenderFile, statRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.alloc(4096));

    expect(await statRenderFile(location)).toEqual({ sizeBytes: 4096 });
  });

  it("returns null rather than throwing for a missing render", async () => {
    const { statRenderFile } = await renderStorage();
    expect(await statRenderFile("renders/absent.mp4")).toBeNull();
  });
});

describe("deleteRenderFile", () => {
  it("removes the file and tolerates a second call", async () => {
    const { writeRenderFile, deleteRenderFile, statRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("x"));

    await deleteRenderFile(location);
    expect(await statRenderFile(location)).toBeNull();

    // Deleting an already-deleted render is what a retried publish does.
    await expect(deleteRenderFile(location)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run src/lib/render-storage.test.ts`
Expected: FAIL — cannot resolve `@/lib/render-storage`.

- [ ] **Step 4: Write the module**

```typescript
// src/lib/render-storage.ts
import "server-only";

import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { env } from "@/config/env";
import { ConflictError, InternalError, ValidationError } from "@/lib/errors";
import { parseRangeHeader } from "@/lib/http-range";

/**
 * Finished renders live on the local disk of the machine that produced them.
 *
 * They previously lived in Vercel Blob, because the worker ran on Railway and
 * the app on Vercel and neither could read the other's disk. Both now run on
 * one VPS, which removes the reason — and removes the metered transfer that
 * suspended the Blob store mid-render on 2026-08-12, destroying eleven minutes
 * of encoding at the moment it tried to save itself.
 *
 * `RenderJob.outputUrl` no longer holds a URL. It holds a path relative to
 * RENDER_ROOT, e.g. `renders/<uuid>.mp4`. Parameters are named `location`
 * rather than `url` so no reader assumes it can be fetched.
 */
const RENDER_PREFIX = "renders";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOT = resolve(env.RENDER_ROOT);

/** Deterministic on `videoId` alone, so a second render for the same video
 * overwrites the first rather than accumulating orphans on a 40GB disk. */
export function renderPath(videoId: string): string {
  if (!UUID_PATTERN.test(videoId)) {
    throw new ValidationError(`Unsafe render video id: "${videoId}"`);
  }

  return `${RENDER_PREFIX}/${videoId}.mp4`;
}

function resolveRender(location: string): string {
  const absolute = resolve(join(ROOT, location));

  if (!absolute.startsWith(ROOT + sep)) {
    throw new ValidationError(`Unsafe render location: "${location}"`);
  }

  return absolute;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Thrown by callers — not by this module, whose reads return `null` — when a
 * `RenderJob.outputUrl` points at a file that is not there: a render made on
 * a machine that no longer exists, a manual deletion, or a render reclaimed
 * after publish. A named business condition ("this needs re-rendering"), not
 * an unexpected failure.
 */
export class RenderFileMissingError extends ConflictError {
  constructor(readonly videoId: string) {
    super("This video's render is no longer available and needs to be re-rendered.");
  }
}

export async function writeRenderFile(
  videoId: string,
  source: Buffer,
): Promise<string> {
  const location = renderPath(videoId);
  const absolute = resolveRender(location);

  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, source);
  } catch (error) {
    throw new InternalError(
      `Could not write the render for video ${videoId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return location;
}

export interface RenderFileStat {
  sizeBytes: number;
}

export async function statRenderFile(location: string): Promise<RenderFileStat | null> {
  try {
    return { sizeBytes: (await stat(resolveRender(location))).size };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export interface RenderFileContent {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  /** The whole file's size, not the size of a partial range. */
  sizeBytes: number;
  /** Bytes actually in `stream`: the range's length when `contentRange` is
   * set, the whole file's size otherwise. */
  contentLength: number;
  /** The `Content-Range` value to send back, e.g. `"bytes 5-9/26"`, or null
   * for a full response. Detect a partial response by this, not by size. */
  contentRange: string | null;
}

/**
 * Opens the render at `location`, honouring `rangeHeader` if present.
 *
 * Three outcomes the caller must distinguish: `null` when the file is not
 * there (a 404 or a `RenderFileMissingError`), the string `"unsatisfiable"`
 * when a range starts past the end (a 416, which browsers do provoke by
 * seeking a video that was re-rendered shorter), and content otherwise.
 */
export async function getRenderFile(
  videoId: string,
  location: string,
  rangeHeader?: string | null,
): Promise<RenderFileContent | null | "unsatisfiable"> {
  const absolute = resolveRender(location);

  let sizeBytes: number;
  try {
    sizeBytes = (await stat(absolute)).size;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new InternalError(
      `Could not stat the render for video ${videoId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const range = parseRangeHeader(rangeHeader, sizeBytes);

  if (range === "unsatisfiable") {
    return "unsatisfiable";
  }

  const nodeStream = range
    ? createReadStream(absolute, { start: range.start, end: range.end })
    : createReadStream(absolute);

  return {
    stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
    contentType: "video/mp4",
    sizeBytes,
    contentLength: range ? range.end - range.start + 1 : sizeBytes,
    contentRange: range ? `bytes ${range.start}-${range.end}/${sizeBytes}` : null,
  };
}

/** Deletes the render. A no-op when it is already gone, because a retried
 * publish reclaims a render that the first attempt already deleted. */
export async function deleteRenderFile(location: string): Promise<void> {
  await rm(resolveRender(location), { force: true });
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run src/lib/render-storage.test.ts`
Expected: PASS.

- [ ] **Step 6: Update the streaming route and every import**

```bash
grep -rn 'blob-render-storage' src worker scripts --include='*.ts' --include='*.tsx'
```

Change each import to `@/lib/render-storage`. In `src/app/api/videos/[id]/file/route.ts`, handle the new third outcome — the route previously had only "content or null":

```typescript
    const content = await getRenderFile(videoId, outputUrl, request.headers.get("range"));

    if (content === null) {
      throw new RenderFileMissingError(videoId);
    }

    // A seek past the end of a file that was re-rendered shorter. RFC 7233
    // requires 416 with the real size so the player can recover, rather than
    // a 200 carrying bytes nobody asked for.
    if (content === "unsatisfiable") {
      const stat = await statRenderFile(outputUrl);
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat?.sizeBytes ?? 0}` },
      });
    }
```

Also update the route's doc comment: range handling is this route's again, via `render-storage`, not Blob's.

- [ ] **Step 7: Delete the old module**

```bash
git rm src/lib/blob-render-storage.ts src/lib/blob-render-storage.test.ts
pnpm typecheck && pnpm lint
```

- [ ] **Step 8: Run every test that touches renders**

Run: `npx vitest run src/lib/render-storage.test.ts src/lib/http-range.test.ts`
Expected: PASS.

`render.service.test.ts` and `publish.service.test.ts` also exercise this path. Run them; they previously failed on the suspended Blob store and should now pass without it. If any still fail, they are this task's to fix.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: keep finished renders on the disk that made them

Renders lived in Vercel Blob because the worker ran on Railway and the app on
Vercel, and neither could read the other's disk. Both now run on one machine,
which removes the reason — and removes the metered transfer that suspended
the store mid-render, destroying eleven minutes of encoding at the moment it
tried to save itself.

outputUrl stops being a URL and becomes a path, so every parameter that named
one is renamed `location`; a reader who assumes it is fetchable is now
contradicted by the type's own name.

getRenderFile gains a third outcome. Blob answered an unsatisfiable range
itself; a filesystem cannot, and a player seeking into a video that was
re-rendered shorter must get a 416 carrying the real size rather than a 200
carrying bytes it did not ask for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Reclaim a render once YouTube has it

At ~170 MB each on a 40 GB disk, renders are the one artefact that fills the machine. `publish.service.ts` already reclaims stock clips after a publish; the render joins them.

**Files:**
- Modify: `src/services/publish.service.ts` — `reclaimClipStorage` or the equivalent post-publish block
- Modify: `src/services/publish.service.test.ts`

**Interfaces:**
- Consumes: `deleteRenderFile` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Read the existing reclaim**

Read `reclaimClipStorage` in `src/services/publish.service.ts` and the code that calls it. It runs after the success transaction and swallows its own errors — the shape this must copy. Note exactly where it is invoked; the render reclaim goes beside it, not inside it.

- [ ] **Step 2: Write the failing tests**

Add to `src/services/publish.service.test.ts`, inside the block covering a successful publish:

```typescript
  it("deletes the local render once YouTube has the video", async () => {
    const { videoId, outputUrl } = await makePublishableVideo(userId);

    await publishService.publish(userId, videoId, {});

    expect(await statRenderFile(outputUrl)).toBeNull();
  });

  it("still reports the publish as successful when the render cannot be deleted", async () => {
    const { videoId, outputUrl } = await makePublishableVideo(userId);
    // Delete it first: the reclaim then runs against a file that is not there,
    // which is exactly what a retried publish does.
    await deleteRenderFile(outputUrl);

    const publication = await publishService.publish(userId, videoId, {});

    expect(publication.status).toBe("PUBLISHED");
  });

  it("keeps the render when the publish failed", async () => {
    const { videoId, outputUrl } = await makePublishableVideo(userId, {
      fetchImpl: createUploadFetch({ failUpload: 500 }),
    });

    await expect(publishService.publish(userId, videoId, {})).rejects.toThrow();

    // A failed publish must leave the render in place, or a retry has nothing
    // to upload and the video is unrecoverable.
    expect(await statRenderFile(outputUrl)).not.toBeNull();
  });
```

Adapt `makePublishableVideo`'s call shape and the failure-injection helper to whatever the file already uses — read it first rather than assuming these names.

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run src/services/publish.service.test.ts -t "render"`
Expected: FAIL — the render is still on disk after a successful publish.

- [ ] **Step 4: Implement the reclaim**

Beside the existing clip reclaim, after the success transaction commits:

```typescript
/**
 * Deletes the local render once YouTube has confirmed the upload.
 *
 * The video is on YouTube; the copy on disk is redundant, and at ~170MB each
 * on a 40GB machine, keeping them is the difference between a disk that
 * stabilises and one that fills at roughly 140 videos.
 *
 * Best-effort, exactly like the clip reclaim above: this runs after the
 * publish has already succeeded and is not permitted to turn a live video
 * into a failed one. A render that is already gone — a retried publish — is
 * not an error.
 */
async function reclaimRenderStorage(videoId: string, location: string): Promise<void> {
  try {
    await deleteRenderFile(location);
  } catch (error) {
    console.error(
      `Could not reclaim the render for video ${videoId} at ${location}:`,
      error,
    );
  }
}
```

Call it only on the success path, after the transaction — never in a `finally`, which would delete the render of a failed publish and leave the video unrecoverable.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run src/services/publish.service.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/publish.service.ts src/services/publish.service.test.ts
git commit -m "feat: reclaim a render once youtube has confirmed it

Renders are ~170MB and the machine has 40GB, so keeping every published one
fills the disk at about 140 videos. Once YouTube returns a video id the local
copy is redundant — the video is on YouTube, and a re-render can produce it
again.

Best-effort and only on the success path, mirroring the clip reclaim beside
it. Never in a finally: deleting the render of a *failed* publish would leave
the video with nothing to retry against.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Finish the environment contract

The Supabase and Blob variables are now unused. Removing them makes a misconfigured deployment fail at boot with a named variable rather than at the first upload.

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `package.json` — drop `@supabase/supabase-js` and `@vercel/blob`

**Interfaces:**
- Consumes: `STORAGE_ROOT` (Task 2) and `RENDER_ROOT` (Task 4), both already added.
- Produces: an environment schema with no hosted-storage variables.

- [ ] **Step 1: Confirm nothing still reads them**

```bash
grep -rn 'SUPABASE_\|BLOB_READ_WRITE_TOKEN\|@supabase/supabase-js\|@vercel/blob' src worker scripts prisma --include='*.ts' --include='*.tsx'
```

Expected: no hits outside `src/config/env.ts` and `.env.example`. Any other hit is a caller Tasks 2–4 missed — fix it here.

- [ ] **Step 2: Remove the variables**

Delete `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` and `BLOB_READ_WRITE_TOKEN` from `serverEnvSchema`, and the matching entries and comments from `.env.example`. Add to `.env.example`:

```bash
# --- Storage (local disk) -------------------------------------------------
# Objects (clips, narration, captions, thumbnails, logos) and finished
# renders. Absolute paths in a deployed environment; the defaults below are
# git-ignored and need no configuration for `pnpm dev` or the test suite.
STORAGE_ROOT=.framecast/storage
RENDER_ROOT=.framecast/renders
```

- [ ] **Step 3: Drop the dependencies**

```bash
pnpm remove @supabase/supabase-js @vercel/blob
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && npx vitest run src/lib/
```
Expected: all clean. A failure here means something still imports a removed package.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: drop the hosted-storage configuration and clients

Nothing reads Supabase Storage or Vercel Blob any more, and leaving their
variables in the schema would let a misconfigured deployment boot happily and
fail at the first upload instead of at startup with a named variable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The server stack

One Compose file describing every service the VPS runs, with staging's worker behind a profile so two renders cannot fight over two cores.

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `deploy/README.md`
- Modify: `Dockerfile` — ensure it builds a standalone Next.js server

**Interfaces:**
- Consumes: `STORAGE_ROOT`, `RENDER_ROOT`, `DATABASE_URL` from Task 6.
- Produces: a stack startable with `docker compose -f deploy/docker-compose.yml up -d`, and image names `ghcr.io/<owner>/framecast-app` and `ghcr.io/<owner>/framecast-worker` that Task 8 publishes.

- [ ] **Step 1: Write the Caddyfile**

```
# deploy/Caddyfile
#
# Caddy obtains and renews certificates for both hostnames automatically. It
# is the only service bound to the host's ports; everything else talks over
# the Compose network.

framecasts.com, www.framecasts.com {
	encode zstd gzip
	# Renders are ~170MB and stream with byte ranges. Never buffer them.
	reverse_proxy app-prod:3000 {
		flush_interval -1
	}
}

staging.framecasts.com {
	# Staging holds the same unpublished work as production and must not be
	# indexed if it is ever discovered.
	header X-Robots-Tag "noindex, nofollow"
	encode zstd gzip
	reverse_proxy app-staging:3000 {
		flush_interval -1
	}
}
```

- [ ] **Step 2: Write the Compose file**

```yaml
# deploy/docker-compose.yml
#
# The whole of Framecast on one VPS: 2 vCPU, 4GB RAM, 40GB disk.
#
# Two environments share one Postgres instance holding two databases. A second
# Postgres would cost ~400MB of 4GB for isolation the databases already give.
#
# Files live on the host under /srv/framecast so a container rebuild cannot
# destroy them.

name: framecast

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [app-prod, app-staging]

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: framecast
    volumes:
      - /srv/framecast/postgres:/var/lib/postgresql/data
      - ./init-staging-db.sh:/docker-entrypoint-initdb.d/init-staging-db.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 10
    # Postgres defaults assume far more memory than this box has.
    command: >
      postgres -c shared_buffers=256MB -c effective_cache_size=768MB
               -c max_connections=50 -c work_mem=4MB

  app-prod:
    image: ghcr.io/${GITHUB_OWNER}/framecast-app:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: /srv/framecast/env/prod.env
    volumes:
      - /srv/framecast/prod/storage:/data/storage
      - /srv/framecast/prod/renders:/data/renders
    depends_on:
      postgres: { condition: service_healthy }

  worker-prod:
    image: ghcr.io/${GITHUB_OWNER}/framecast-worker:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: /srv/framecast/env/prod.env
    volumes:
      - /srv/framecast/prod/storage:/data/storage
      - /srv/framecast/prod/renders:/data/renders
    depends_on:
      postgres: { condition: service_healthy }
    # ffmpeg will take every core it is given. Interactive work — the site,
    # Postgres — must win contention, or the app is unusable for the eleven
    # minutes a render takes on two cores.
    cpu_shares: 512

  app-staging:
    image: ghcr.io/${GITHUB_OWNER}/framecast-app:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: /srv/framecast/env/staging.env
    volumes:
      - /srv/framecast/staging/storage:/data/storage
      - /srv/framecast/staging/renders:/data/renders
    depends_on:
      postgres: { condition: service_healthy }

  # Started deliberately, never automatically: two renders on two cores would
  # make both slow and the site unusable.
  #   docker compose --profile staging-worker up -d worker-staging
  #   docker compose stop worker-staging
  worker-staging:
    image: ghcr.io/${GITHUB_OWNER}/framecast-worker:${IMAGE_TAG:-latest}
    restart: unless-stopped
    profiles: [staging-worker]
    env_file: /srv/framecast/env/staging.env
    volumes:
      - /srv/framecast/staging/storage:/data/storage
      - /srv/framecast/staging/renders:/data/renders
    depends_on:
      postgres: { condition: service_healthy }
    cpu_shares: 256

volumes:
  caddy-data:
  caddy-config:
```

- [ ] **Step 3: Write the staging database initialiser**

```bash
# deploy/init-staging-db.sh
#!/bin/sh
# Runs once, on an empty data directory. The `framecast` database is created
# by POSTGRES_DB; staging's is created here so both live in one instance.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
	CREATE DATABASE framecast_staging;
EOSQL
```

Make it executable: `chmod +x deploy/init-staging-db.sh`

- [ ] **Step 4: Confirm the app image builds a standalone server**

Read the root `Dockerfile`. Next.js needs `output: "standalone"` in `next.config.ts` for a small runtime image. If it is not set, add it and rebuild. If the Dockerfile already produces a working server image, change nothing.

- [ ] **Step 5: Validate the Compose file**

```bash
cd deploy
GITHUB_OWNER=placeholder POSTGRES_USER=x POSTGRES_PASSWORD=y docker compose config >/dev/null && echo "compose valid"
```
Expected: `compose valid`. This checks syntax and interpolation without starting anything.

- [ ] **Step 6: Write `deploy/README.md`**

A short operator note covering: what each service is, that `worker-staging` is deliberately not started, the two commands to start and stop it, and where the env files live. No secrets.

- [ ] **Step 7: Commit**

```bash
git add deploy Dockerfile next.config.ts
git commit -m "feat: describe the whole stack in one compose file

Two environments on one 4GB box share a single Postgres holding two
databases; a second instance would cost ~400MB for isolation the databases
already provide. Postgres is given explicit memory settings because its
defaults assume a much larger machine.

Staging's worker sits behind a profile so it is never started by accident.
Two renders competing for two cores would make both slow and the site
unusable, and the operator starting it deliberately is a cheaper answer than
a cross-environment lock.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Build images on GitHub, not on the box

`next build` wants 2–4 GB. The box has 4 GB with Postgres already in it, and a build competing with a render is the worst possible time to run out of memory.

**Files:**
- Create: `.github/workflows/build-images.yml`

**Interfaces:**
- Consumes: the two Dockerfiles.
- Produces: `ghcr.io/<owner>/framecast-app:<sha>` and `:latest`, plus the same for `framecast-worker`. Task 12's deploy step pulls these.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/build-images.yml
name: Build images

# The server pulls what this publishes; nothing heavy ever runs on a box that
# has 4GB and a database in it.
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        include:
          - image: framecast-app
            dockerfile: Dockerfile
          - image: framecast-worker
            dockerfile: worker/Dockerfile
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:${{ github.sha }}
            ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Verify the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-images.yml')); print('workflow valid')"
```
Expected: `workflow valid`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-images.yml
git commit -m "ci: build the images on github so the box never has to

next build wants 2-4GB and the VPS has 4GB with Postgres already in it. A
build that runs out of memory on the server would fail exactly when a fix is
most wanted, and one that succeeds would compete with a render for two cores.
The server's only job is to pull a tag it did not build.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Provision the server

Everything that turns a bare Ubuntu box into one that can run the stack, written down so it can be done again after a rebuild.

**Files:**
- Create: `docs/vps-deployment.md` (provisioning section)

**Interfaces:**
- Consumes: nothing.
- Produces: a provisioned host and a runbook Tasks 10–12 extend.

- [ ] **Step 1: Harden the host**

Against `51.38.80.36`, as root. OVH's own documentation is explicit that securing the machine is the customer's responsibility — on a managed platform this step did not exist.

```bash
apt-get update && apt-get upgrade -y
apt-get install -y ufw fail2ban unattended-upgrades

# Only SSH and the web.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# Keys only. Confirm your key works in a second terminal BEFORE running this.
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh

dpkg-reconfigure -plow unattended-upgrades
```

- [ ] **Step 2: Add swap**

4 GB with Postgres, two Next.js processes and ffmpeg is tight. Swap turns a spike into a slowdown rather than an OOM kill.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Prefer reclaiming cache to swapping a live process.
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

- [ ] **Step 3: Install Docker**

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

- [ ] **Step 4: Create the directory tree**

```bash
mkdir -p /srv/framecast/{postgres,env}
mkdir -p /srv/framecast/prod/{storage,renders}
mkdir -p /srv/framecast/staging/{storage,renders}
chmod 700 /srv/framecast/env
```

- [ ] **Step 5: Write the environment files**

Create `/srv/framecast/env/prod.env` and `staging.env` **on the server only**. Never commit them.

Production values, with the containers' own paths for storage:

```bash
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@postgres:5432/framecast
DIRECT_URL=postgresql://<user>:<password>@postgres:5432/framecast
DATABASE_SSL_DISABLE=true
BETTER_AUTH_URL=https://framecasts.com
NEXT_PUBLIC_APP_URL=https://framecasts.com
STORAGE_ROOT=/data/storage
RENDER_ROOT=/data/renders
```

Plus `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AI_GATEWAY_API_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `JAMENDO_CLIENT_ID`, `SEED_USER_EMAIL`.

**`CREDENTIAL_ENCRYPTION_KEY` must be copied from the current deployment unchanged.** A new one makes every stored provider key undecryptable, with no recovery. Verify by reading it out of the existing environment, not by generating one.

`DATABASE_SSL_DISABLE=true` is permitted here and only here: `config/env.ts` refuses it unless the database host is a single-label name, and `postgres` on the Compose network is exactly that.

Staging is identical but for `framecast_staging`, `staging.framecasts.com`, and `JAMENDO_CLIENT_ID` left empty so test renders do not consume the music quota.

- [ ] **Step 6: Record it**

Write the provisioning section of `docs/vps-deployment.md` covering every step above, with placeholders where secrets belong and a note that the env files live only on the server.

- [ ] **Step 7: Commit**

```bash
git add docs/vps-deployment.md
git commit -m "docs: how this box was provisioned

Firewall, keys-only SSH, unattended upgrades, swap and Docker, written down
because the machine is now the operator's responsibility rather than a
platform's. A VPS that has to be rebuilt at 2am is not the moment to
reconstruct which sysctl mattered.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Migrate the data

Files first, database last, so the database is never ahead of the objects it references.

**Files:**
- Create: `scripts/migrate-storage.ts`
- Create: `scripts/migrate-renders.ts`
- Create: `prisma/migrations/<timestamp>_output_url_to_path/migration.sql`
- Modify: `docs/vps-deployment.md` (migration section)

**Interfaces:**
- Consumes: `storagePath` semantics from Task 2, `renderPath` from Task 4.
- Produces: a populated `/srv/framecast/prod/` and a restored database.

**Both scripts are one-shot and are deleted in Task 12** once they have run. They are committed so the migration is reviewable and repeatable, not kept as permanent tooling.

- [ ] **Step 1: Write the object copier**

`scripts/migrate-storage.ts` lists every object in the Supabase bucket, downloads it, and writes it under `STORAGE_ROOT` at the identical relative path, plus its `.type` sidecar from Supabase's stored `mimetype`. It must:

- Recurse: Supabase's `list()` returns one level at a time.
- Preserve paths exactly, so `storagePath()` output keeps resolving.
- Be resumable: skip an object whose destination already exists with the same size, so an interrupted run can be re-run.
- Print a running count and a final total.

It reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` from the process environment directly — Task 6 removed them from the schema, and this script deliberately does not resurrect them there.

- [ ] **Step 2: Write the render copier**

`scripts/migrate-renders.ts` reads every `RenderJob.outputUrl` that looks like a Blob URL, downloads it, and writes it to `RENDER_ROOT` at `renders/<videoId>.mp4`.

**This step requires the Vercel Blob store to be un-suspended.** Suspended means unreadable. The script must detect the suspension, report it clearly, and exit non-zero rather than silently producing zero files. If the operator chooses not to restore billing, skip this script — Step 4's migration nulls the affected rows.

- [ ] **Step 3: Move the database**

```bash
# From the operator's Mac, with DIRECT_URL pointing at Supabase.
pg_dump "$DIRECT_URL" --no-owner --no-acl --format=custom --file=framecast.dump

scp framecast.dump root@51.38.80.36:/tmp/
ssh root@51.38.80.36 'docker compose -f /srv/framecast/docker-compose.yml cp /tmp/framecast.dump postgres:/tmp/'
ssh root@51.38.80.36 'docker compose -f /srv/framecast/docker-compose.yml exec postgres \
  pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d framecast /tmp/framecast.dump'
```

Then confirm Prisma agrees the schema is current:

```bash
npx prisma migrate status
```
Expected: "Database schema is up to date!"

- [ ] **Step 4: Rewrite `outputUrl`**

`outputUrl` held an absolute Blob URL and now holds a path. Generate the migration:

```bash
npx prisma migrate dev --name output_url_to_path --create-only
```

Write into it:

```sql
-- outputUrl held a Vercel Blob URL; it now holds a path relative to
-- RENDER_ROOT (see src/lib/render-storage.ts). Rows whose render was copied
-- across are rewritten to that path. Rows whose render was not copied are
-- nulled: the file does not exist on the new machine, and a path pointing at
-- nothing would surface as a broken player rather than as the honest "this
-- needs re-rendering" that a null already produces.
UPDATE "render_job"
SET "outputUrl" = 'renders/' || "videoId" || '.mp4'
WHERE "outputUrl" LIKE 'https://%.blob.vercel-storage.com/%';

UPDATE "render_job"
SET "outputUrl" = NULL
WHERE "outputUrl" LIKE 'https://%';
```

**Check the real table and column names first** with `\d` in psql — the schema uses `@@map`, so the SQL names may differ from the Prisma model names. Run the second statement only if Step 2 was skipped or partially completed.

- [ ] **Step 5: Verify the migration**

On the server:

```bash
# Row counts match the source.
docker compose exec postgres psql -U "$POSTGRES_USER" -d framecast \
  -c 'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM video) AS videos, (SELECT count(*) FROM channel) AS channels;'

# Objects arrived.
find /srv/framecast/prod/storage -type f ! -name '*.type' | wc -l
du -sh /srv/framecast/prod
```

Then, from the app container, confirm the thing that cannot be checked any other way:

```bash
docker compose exec app-prod node -e "
  const { credentialService } = require('./dist/services/credential.service');
  // Prove a stored provider key still decrypts under the carried key.
"
```

Simpler and sufficient: sign in to the running app and open the Providers page. If the stored ElevenLabs key renders as connected rather than as an error, `CREDENTIAL_ENCRYPTION_KEY` came across correctly. **Do not proceed past this check** — everything else can be redone; a wrong key cannot.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-storage.ts scripts/migrate-renders.ts prisma/migrations docs/vps-deployment.md
git commit -m "feat: scripts to carry the data across

Files first and the database last, so the database is never ahead of the
objects it references.

outputUrl changes meaning from a URL to a path, and rows whose render could
not be copied are nulled rather than pointed at a file that is not there — a
null already means 'this needs re-rendering' everywhere that reads it, while
a dead path would surface as a broken player.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Nightly backups, and a restore that was actually performed

This is where the trade made in this migration — managed backups for control — is paid for.

**Files:**
- Create: `deploy/backup.sh`
- Create: `deploy/framecast-backup.service`, `deploy/framecast-backup.timer`
- Modify: `docs/vps-deployment.md` (backup and restore section)

**Interfaces:**
- Consumes: the running Postgres from Task 7.
- Produces: a nightly dump in Cloudflare R2 and a documented, exercised restore.

- [ ] **Step 1: Write the backup script**

```bash
# deploy/backup.sh
#!/usr/bin/env bash
#
# Nightly dump of both databases to Cloudflare R2 — deliberately not OVH. An
# account-level failure, a billing suspension or a mistaken deletion must not
# be able to take the server and its backups together. That is not
# hypothetical: it is what happened to this project's Vercel Blob store on
# 2026-08-12.
#
# OVH's own automated backup covers "the server broke". This covers "the
# account is gone". They are different questions.
set -euo pipefail

: "${R2_BUCKET:?}" "${R2_ENDPOINT:?}"
: "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
: "${POSTGRES_USER:?}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for DB in framecast framecast_staging; do
  OUT="$WORK/${DB}-${STAMP}.dump.gz"
  docker compose -f /srv/framecast/docker-compose.yml exec -T postgres \
    pg_dump -U "$POSTGRES_USER" --no-owner --no-acl --format=custom "$DB" \
    | gzip -9 > "$OUT"

  # A dump that is suspiciously small is a failure that succeeded.
  SIZE=$(stat -c%s "$OUT")
  if [ "$SIZE" -lt 10000 ]; then
    echo "Refusing to upload ${DB}: dump is only ${SIZE} bytes." >&2
    exit 1
  fi

  aws s3 cp "$OUT" "s3://${R2_BUCKET}/postgres/$(basename "$OUT")" \
    --endpoint-url "$R2_ENDPOINT"
  echo "Uploaded $(basename "$OUT") (${SIZE} bytes)."
done
```

`chmod +x deploy/backup.sh`

- [ ] **Step 2: Write the timer**

```ini
# deploy/framecast-backup.service
[Unit]
Description=Framecast nightly database backup to R2

[Service]
Type=oneshot
EnvironmentFile=/srv/framecast/env/backup.env
ExecStart=/srv/framecast/backup.sh
```

```ini
# deploy/framecast-backup.timer
[Unit]
Description=Run the Framecast backup nightly

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` so a backup missed while the box was down runs on the next boot rather than being skipped silently.

- [ ] **Step 3: Install and run it once**

```bash
cp deploy/backup.sh /srv/framecast/backup.sh && chmod +x /srv/framecast/backup.sh
cp deploy/framecast-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now framecast-backup.timer

# Run it now rather than waiting for 03:00.
systemctl start framecast-backup.service
journalctl -u framecast-backup.service --no-pager
```
Expected: two uploads reported, no errors.

- [ ] **Step 4: Set the retention rule**

In the Cloudflare R2 dashboard, add a lifecycle rule on the bucket deleting objects under `postgres/` after 30 days. Record it in the runbook — an unbounded backup bucket is a bill that grows quietly.

- [ ] **Step 5: Actually restore one**

This step is the point of the task. A backup that has never been restored is a belief, not a backup.

```bash
# Pull last night's dump back down.
aws s3 cp "s3://${R2_BUCKET}/postgres/$(aws s3 ls "s3://${R2_BUCKET}/postgres/" \
  --endpoint-url "$R2_ENDPOINT" | sort | tail -1 | awk '{print $4}')" \
  /tmp/verify.dump.gz --endpoint-url "$R2_ENDPOINT"

gunzip -f /tmp/verify.dump.gz

# Restore into a scratch database, never over a live one.
docker compose exec -T postgres createdb -U "$POSTGRES_USER" restore_check
docker compose cp /tmp/verify.dump postgres:/tmp/
docker compose exec -T postgres pg_restore --no-owner --no-acl \
  -U "$POSTGRES_USER" -d restore_check /tmp/verify.dump

# The counts must match production.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d restore_check \
  -c 'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM video) AS videos;'

docker compose exec -T postgres dropdb -U "$POSTGRES_USER" restore_check
```

Record the counts you saw in the runbook, with the date. **Supabase is not cancelled until this step has passed.**

- [ ] **Step 6: Commit**

```bash
git add deploy/backup.sh deploy/framecast-backup.* docs/vps-deployment.md
git commit -m "feat: nightly backups to a provider that is not ovh

Cancelling Supabase means backups stop being someone else's job. They go to
R2 rather than OVH object storage deliberately: an account-level failure must
not be able to take the server and its backups together, which is exactly
what happened to the Blob store this week on a different provider.

The script refuses to upload a suspiciously small dump — a backup that
succeeded while producing nothing is worse than one that failed loudly — and
the plan requires restoring one before Supabase is cancelled, because a
backup nobody has restored is a belief rather than a backup.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Cut over

Nothing is cancelled until the replacement is serving real traffic.

**Files:**
- Modify: `docs/vps-deployment.md` (cutover and deploy sections)
- Delete: `railway.json`, `docs/worker-deployment.md`, `scripts/migrate-*.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `framecasts.com` served from the VPS.

- [ ] **Step 1: Bring up staging and exercise it**

```bash
cd /srv/framecast && docker compose pull && docker compose up -d
docker compose exec app-staging npx prisma migrate deploy
docker compose --profile staging-worker up -d worker-staging
```

On `staging.framecasts.com`: sign in, create a video, run it through script, narration, footage and render, publish it to an unlisted YouTube video, and confirm the thumbnail applies. This is the first end-to-end proof against real providers.

```bash
docker compose stop worker-staging
```

- [ ] **Step 2: Freeze production**

Stop the Railway worker so nothing new is written to Supabase while the data is copied.

- [ ] **Step 3: Run the migration**

Task 10, in order: objects, renders, database, `outputUrl`. Then Task 10 Step 5's verification, including the Providers page check.

- [ ] **Step 4: Move DNS**

The domain is registered at **GoDaddy** with nameservers delegated to Vercel. In GoDaddy:

1. Set nameservers back to GoDaddy's defaults.
2. Add `A` records: `@` → `51.38.80.36`, `www` → `51.38.80.36`, `staging` → `51.38.80.36`.
3. Delete any Vercel-specific records.

Registration is unaffected — cancelling Vercel cannot take the domain.

Propagation takes minutes to hours. Watch:

```bash
dig +short A framecasts.com
```

When it returns `51.38.80.36`, Caddy issues certificates on the first request. Confirm `https://framecasts.com` loads with a valid certificate.

- [ ] **Step 5: Watch for 48 hours**

Render a video end to end on production. Publish it. Confirm the thumbnail applies, and that the render is deleted afterwards:

```bash
ls -la /srv/framecast/prod/renders/   # the published video's file should be gone
df -h /                                # disk is not filling
docker compose logs --tail 100 worker-prod
```

Confirm the nightly backup ran: `journalctl -u framecast-backup.service --since yesterday`.

- [ ] **Step 6: Retire the old services**

Only after Step 5 is clean:

1. Delete the Railway worker.
2. Cancel Vercel — the app, the Blob store, and the DNS zone no longer in use.
3. **After the Task 11 restore has passed**, cancel Supabase.

- [ ] **Step 7: Remove what is now dead**

```bash
git rm railway.json docs/worker-deployment.md scripts/migrate-storage.ts scripts/migrate-renders.ts
```

The migration scripts are one-shot and have run. They stay in git history, where a repeat migration can retrieve them, rather than in the tree as permanent tooling that will silently rot.

- [ ] **Step 8: Finish the runbook**

`docs/vps-deployment.md` should end with the routine deploy — the thing that will be done a hundred times more often than a migration:

```bash
ssh root@51.38.80.36
cd /srv/framecast
docker compose pull
docker compose up -d
docker compose exec app-prod npx prisma migrate deploy
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: retire railway, vercel and supabase

framecasts.com is served from the VPS, the data is across, a backup has been
restored and verified, and a published video's render is reclaimed from disk
as designed.

The one-shot migration scripts go with them. They have run, they are in
history if a second migration ever needs them, and leaving them in the tree
would keep code that nothing calls and nothing tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the architecture to 7, the storage rewrite to 2–4, `signedUrl`'s deletion to 3, render reclaim to 5, data migration to 10, the credential-key warning to 9 and 10, cutover to 12, backups to 11, and the provisioning implied by "you take on TLS and patching" to 9. The spec's failure-handling table is covered by tests in Tasks 2, 4 and 5 and by verification steps in 10 and 12.

**Placeholders.** None. Every code step carries the code; every ops step carries the command. Three tasks (3, 10, 11) instruct the implementer to read the real schema or the real test helpers before writing against them, which is a check against this plan's assumptions rather than a gap in it.

**Type consistency.** `parseRangeHeader` returns `ByteRange | null | "unsatisfiable"` in Task 1 and is consumed with all three cases in Task 4. `writeRenderFile` returns a `location` string in Task 4, consumed as `location` in Task 5 and rewritten into `outputUrl` in Task 10. `objectContentType` is written by Task 2's sidecar and read by the narration route in Task 3.

**Known gap, deliberately left:** the two migration scripts in Task 10 are specified by behaviour rather than by complete code. They are one-shot, they run once against live data that only exists on the operator's account, and their correctness is proven by Task 10 Step 5's verification rather than by a test. Writing them speculatively against a bucket listing nobody can see from here would produce confident code that has never met the data.
