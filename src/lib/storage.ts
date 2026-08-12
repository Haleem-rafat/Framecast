import "server-only";

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";

export type StorageKind =
  | "audio"
  | "clips"
  | "captions"
  | "music"
  | "output"
  | "thumbnails"
  | "logos";

/**
 * Every object lives under an owner's prefix so deleting everything that
 * owner owns is a prefix delete. `ownerId` is a video id for every
 * per-render `StorageKind` (audio, clips, captions, music, output,
 * thumbnails) — the original, narrower meaning this parameter carried when
 * it was named `videoId`. `logos` widens that: a channel's logo is
 * generated once and reused across every video that channel ever renders,
 * so it is filed under the channel id instead. The `videos/` segment of the
 * returned path is a historical name for "prefix", not a claim about what
 * `ownerId` actually identifies — kept as-is because every existing object
 * already lives under it and changing it would orphan them. Filenames are
 * validated rather than sanitised: a name that would escape the prefix is a
 * bug in the caller, not something to quietly fix.
 */
export function storagePath(
  ownerId: string,
  kind: StorageKind,
  filename: string,
): string {
  if (!filename || filename.includes("/") || filename.includes("..")) {
    throw new ValidationError(`Unsafe storage filename: "${filename}"`);
  }

  return `videos/${ownerId}/${kind}/${filename}`;
}

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

/** @deprecated Task 3 replaces this with `/api/videos/[id]/narration` and
 * deletes it, together with its one caller. A filesystem has no signed URLs;
 * this exists only so this commit typechecks. The unused second parameter
 * mirrors the Supabase original's `expiresInSeconds` so that caller — which
 * Task 3 owns removing, not this task — keeps compiling unchanged. */
export async function signedUrl(
  path: string,
  expiresInSeconds?: number,
): Promise<string> {
  void expiresInSeconds; // unused: kept only so the existing call site still typechecks
  throw new InternalError(
    `signedUrl is not available on filesystem storage (${path}); use the narration route.`,
  );
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
