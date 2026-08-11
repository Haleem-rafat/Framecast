import "server-only";

import { createClient } from "@supabase/supabase-js";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";

export type StorageKind = "audio" | "clips" | "captions" | "music" | "output";

const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Every object lives under its video's prefix so deleting a video's assets is a
 * prefix delete. Filenames are validated rather than sanitised: a name that
 * would escape the prefix is a bug in the caller, not something to quietly fix.
 */
export function storagePath(
  videoId: string,
  kind: StorageKind,
  filename: string,
): string {
  if (!filename || filename.includes("/") || filename.includes("..")) {
    throw new ValidationError(`Unsafe storage filename: "${filename}"`);
  }

  return `videos/${videoId}/${kind}/${filename}`;
}

/** The per-object cap this codebase holds itself to. Discovered live: a 70.9MB
 * clip failed upload with "the object exceeded the maximum allowed size"
 * before any limit was set anywhere here. Stock footage is filtered well under
 * this (see stock-footage.provider.ts's MAX_CLIP_SIZE_BYTES) — this is the
 * backstop, not the primary defense.
 *
 * `ensureBucket` only applies it when it creates the bucket, and the dev
 * bucket predates that code: its `file_size_limit` reads back as null, meaning
 * the real ceiling there is whatever the Supabase project's global upload limit
 * happens to be, not this number. That is why `putObject` checks the size
 * itself below rather than trusting the bucket to reject an oversized body —
 * a limit that only exists on freshly created buckets is not a guarantee. */
const BUCKET_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

/** One decimal place, so a refusal reads "51.2MB exceeds the 50.0MB limit"
 * rather than two numbers that both round to 50 and look like a bug. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Idempotent. Safe to call on every render. Only applies `fileSizeLimit` at
 * creation time — an already-existing bucket is left alone rather than
 * updated on every call, since a limit change here should be a deliberate,
 * reviewed edit to this constant, not a side effect of the next render. */
export async function ensureBucket(): Promise<void> {
  const { data } = await client.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);

  if (data) {
    return;
  }

  // Private: rendered videos and narration are the operator's unpublished work.
  const { error } = await client.storage.createBucket(
    env.SUPABASE_STORAGE_BUCKET,
    { public: false, fileSizeLimit: BUCKET_FILE_SIZE_LIMIT_BYTES },
  );

  if (error) {
    throw new InternalError(`Could not create storage bucket: ${error.message}`);
  }
}

export async function putObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  // Checked here, before the network, for two reasons. The bucket's own limit
  // is unreliable (see BUCKET_FILE_SIZE_LIMIT_BYTES), and Supabase's rejection
  // — "The object exceeded the maximum allowed size" — names neither the size
  // that was sent nor the ceiling it broke, which cost real time to diagnose
  // from a pipeline log. Failing here costs one comparison and says both.
  if (body.byteLength > BUCKET_FILE_SIZE_LIMIT_BYTES) {
    throw new InternalError(
      `Refusing to upload ${path}: ${formatMegabytes(body.byteLength)} exceeds ` +
        `the ${formatMegabytes(BUCKET_FILE_SIZE_LIMIT_BYTES)} per-object limit.`,
    );
  }

  const { error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(path, body, { contentType, upsert: true });

  if (error) {
    throw new InternalError(`Upload failed for ${path}: ${error.message}`);
  }

  return path;
}

export async function getObject(path: string): Promise<Buffer> {
  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .download(path);

  if (error || !data) {
    throw new InternalError(`Download failed for ${path}: ${error?.message}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

/**
 * Permanently deletes objects from the bucket. Every other storage-owning row
 * in this codebase is soft-deleted (`deletedAt`) while its object is left in
 * place *on purpose* — deleting a Video, for instance, deliberately keeps its
 * rendered file and scene assets around so the soft delete stays reversible
 * (see `VideoService.remove`'s own doc comment). This function is the one
 * escape hatch from that convention: `publish.service.ts` calls it to reclaim
 * section clips once a video is `PUBLISHED`, a state nothing downstream ever
 * needs those clips to re-render from again. Reach for a soft delete first;
 * only use this where the caller can prove the object is genuinely done being
 * useful.
 *
 * A no-op on an empty list rather than a network round trip for nothing —
 * callers that computed zero paths to delete (e.g. a video with no clips
 * left) shouldn't have to guard the call themselves.
 *
 * A caller relying on this to have actually deleted everything it asked for
 * (`publish.service.ts`'s reclaim runs the storage delete *before* soft-
 * deleting the matching rows, specifically so a failure here leaves the rows
 * live rather than orphaning the bytes — see its own comment) needs more
 * than "the call didn't throw": Supabase's `.remove()` can come back with no
 * `error` at all while still only having deleted some of the requested
 * paths — one bad object doesn't necessarily fail the whole batch the way a
 * network error would. Its response's `data` is the list it actually
 * removed, so that count is checked against what was asked for rather than
 * trusting `error`'s absence to mean "all of them."
 */
export async function removeObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .remove(paths);

  if (error) {
    throw new InternalError(
      `Delete failed for ${paths.length} object(s) (e.g. ${paths[0]}): ${error.message}`,
    );
  }

  const deletedCount = data?.length ?? 0;
  if (deletedCount !== paths.length) {
    const deletedNames = new Set((data ?? []).map((object) => object.name));
    const missing = paths.filter((path) => !deletedNames.has(path));
    throw new InternalError(
      `Delete reported success but only removed ${deletedCount}/${paths.length} ` +
        `object(s) — missing e.g. ${missing[0]}.`,
    );
  }
}

/** The bucket is private, so anything shown in the browser needs a signed URL. */
export async function signedUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data) {
    throw new InternalError(`Could not sign ${path}: ${error?.message}`);
  }

  return data.signedUrl;
}

/**
 * There is no single-object "stat" call in the storage API — `list()` on the
 * containing folder is the only way to get an object's size, so this pays for
 * a folder listing to answer what feels like a one-object question. Throws
 * like the rest of this module's I/O (`getObject`, `putObject`, `signedUrl`);
 * callers that treat file size as optional page decoration, not load-bearing
 * data, should catch it the same way they catch a failed `signedUrl`.
 */
export async function objectSizeBytes(path: string): Promise<number | null> {
  const lastSlash = path.lastIndexOf("/");
  const folder = path.slice(0, lastSlash);
  const filename = path.slice(lastSlash + 1);

  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .list(folder, { search: filename });

  if (error) {
    throw new InternalError(`Could not list ${folder}: ${error.message}`);
  }

  return data?.find((item) => item.name === filename)?.metadata?.size ?? null;
}
