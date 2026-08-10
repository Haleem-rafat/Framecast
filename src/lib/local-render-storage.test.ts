import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/errors";
import {
  createRenderReadStream,
  localRenderPath,
  readRenderFile,
  RenderFileMissingError,
  RENDER_STORAGE_DIR,
  statRenderFile,
  writeRenderFile,
} from "@/lib/local-render-storage";

/** No database or network involved — this module is pure `node:fs`, so
 * unlike every other `*.service.test.ts` in this codebase, these tests don't
 * need a test user or the shared Supabase database. Every written file is
 * removed in `afterEach` regardless of pass/fail. */
const writtenVideoIds: string[] = [];

function absolute(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

afterEach(async () => {
  await Promise.all(
    writtenVideoIds.splice(0).map((id) => rm(absolute(localRenderPath(id)), { force: true })),
  );
});

describe("localRenderPath", () => {
  it("is deterministic and rooted under RENDER_STORAGE_DIR", () => {
    const videoId = randomUUID();
    expect(localRenderPath(videoId)).toBe(path.join(RENDER_STORAGE_DIR, `${videoId}.mp4`));
    expect(localRenderPath(videoId)).toBe(localRenderPath(videoId));
  });

  it("refuses anything that isn't a bare UUID — the same discipline storagePath applies to Supabase keys", () => {
    expect(() => localRenderPath("../../etc/passwd")).toThrow(ValidationError);
    expect(() => localRenderPath("not-a-uuid")).toThrow(ValidationError);
    expect(() => localRenderPath("")).toThrow(ValidationError);
  });
});

describe("writeRenderFile / statRenderFile / readRenderFile — round trip", () => {
  it("writes bytes that stat and read agree on", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from(`fake-mp4-bytes-${videoId}`);

    const relativePath = await writeRenderFile(videoId, body);
    expect(relativePath).toBe(localRenderPath(videoId));

    const stat = await statRenderFile(videoId);
    expect(stat.sizeBytes).toBe(body.byteLength);
    expect(stat.absolutePath).toBe(absolute(relativePath));

    const readBack = await readRenderFile(videoId);
    expect(readBack.equals(body)).toBe(true);
  });

  it("creates RENDER_STORAGE_DIR on first use rather than requiring it to pre-exist", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);

    // No prior directory setup — writeRenderFile must mkdir it itself, same
    // as any other video id would find on a machine that has never rendered.
    await expect(writeRenderFile(videoId, Buffer.from("bytes"))).resolves.toBeTruthy();
  });
});

describe("a render that is on the DB but not on disk", () => {
  it("statRenderFile throws RenderFileMissingError, never a raw ENOENT", async () => {
    const videoId = randomUUID(); // never written
    const error = await statRenderFile(videoId).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RenderFileMissingError);
    expect((error as Error).message).toContain("no longer on disk");
    expect((error as Error).message).not.toContain("ENOENT");
  });

  it("readRenderFile throws the same typed error", async () => {
    const videoId = randomUUID();
    await expect(readRenderFile(videoId)).rejects.toBeInstanceOf(RenderFileMissingError);
  });

  it("is a ConflictError under the hood, so it serializes to a 409 like the rest of the app's business-state errors", async () => {
    const videoId = randomUUID();
    const error = (await statRenderFile(videoId).catch((e: unknown) => e)) as RenderFileMissingError;
    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe("CONFLICT");
  });
});

describe("createRenderReadStream", () => {
  it("streams the full file when no range is given", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from("0123456789");
    await writeRenderFile(videoId, body);

    const chunks: Buffer[] = [];
    for await (const chunk of createRenderReadStream(videoId)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe("0123456789");
  });

  it("streams only the requested byte range", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from("0123456789");
    await writeRenderFile(videoId, body);

    const chunks: Buffer[] = [];
    for await (const chunk of createRenderReadStream(videoId, { start: 2, end: 5 })) {
      chunks.push(chunk as Buffer);
    }
    // node's fs range is inclusive on both ends: bytes 2-5 is "2345".
    expect(Buffer.concat(chunks).toString()).toBe("2345");
  });
});
