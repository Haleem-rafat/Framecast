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

/** Idempotent. Safe to call on every render. */
export async function ensureBucket(): Promise<void> {
  const { data } = await client.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);

  if (data) {
    return;
  }

  // Private: rendered videos and narration are the operator's unpublished work.
  const { error } = await client.storage.createBucket(
    env.SUPABASE_STORAGE_BUCKET,
    { public: false },
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
