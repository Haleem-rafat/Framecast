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
