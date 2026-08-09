import "server-only";

import { createClient } from "@supabase/supabase-js";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";

export type StorageKind = "audio" | "clips" | "captions" | "output";

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

/** Supabase's default per-object cap on this plan — set explicitly at bucket
 * creation (below) so an oversized upload fails at a documented boundary
 * instead of whatever the plan default happens to be. Discovered live: a
 * 70.9MB clip failed upload with "the object exceeded the maximum allowed
 * size" before this was ever set anywhere in this codebase. Stock footage is
 * now filtered well under this (see stock-footage.provider.ts's
 * MAX_CLIP_SIZE_BYTES) — this is the backstop, not the primary defense. */
const BUCKET_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

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
