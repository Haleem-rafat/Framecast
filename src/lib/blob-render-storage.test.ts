import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteRenderFile,
  getRenderFile,
  renderBlobPathname,
  RenderFileMissingError,
  statRenderFile,
  writeRenderFile,
} from "@/lib/blob-render-storage";
import { ValidationError } from "@/lib/errors";

/** Every test in this file hits the real, shared `framecast-renders` Blob
 * store — there is no local or in-memory fake for `@vercel/blob` (see the
 * task brief). Each test writes under a fresh, random video id, so runs
 * never collide with each other or with the operator's real renders, and
 * `afterEach` deletes whatever the test wrote regardless of pass/fail. */
vi.setConfig({ testTimeout: 20_000 });

const writtenVideoIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    writtenVideoIds.splice(0).map((id) => deleteRenderFile(renderBlobPathname(id)).catch(() => {})),
  );
});

describe("renderBlobPathname", () => {
  it("is deterministic and rooted under the renders/ prefix", () => {
    const videoId = randomUUID();
    expect(renderBlobPathname(videoId)).toBe(`renders/${videoId}.mp4`);
    expect(renderBlobPathname(videoId)).toBe(renderBlobPathname(videoId));
  });

  it("refuses anything that isn't a bare UUID — same discipline storagePath applies to Supabase keys", () => {
    expect(() => renderBlobPathname("../../etc/passwd")).toThrow(ValidationError);
    expect(() => renderBlobPathname("not-a-uuid")).toThrow(ValidationError);
    expect(() => renderBlobPathname("")).toThrow(ValidationError);
  });
});

describe("writeRenderFile / statRenderFile / getRenderFile / deleteRenderFile — round trip", () => {
  it("writes bytes that stat and get agree on, then deletes cleanly", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from(`fake-mp4-bytes-${videoId}`);

    const url = await writeRenderFile(videoId, body);
    expect(url).toContain(renderBlobPathname(videoId));

    const stat = await statRenderFile(url);
    expect(stat).not.toBeNull();
    expect(stat!.sizeBytes).toBe(body.byteLength);

    const content = await getRenderFile(videoId, url);
    expect(content).not.toBeNull();
    expect(content!.contentType).toBe("video/mp4");
    expect(content!.sizeBytes).toBe(body.byteLength);
    expect(content!.contentRange).toBeNull();

    const readBack = Buffer.from(await new Response(content!.stream).arrayBuffer());
    expect(readBack.equals(body)).toBe(true);

    await deleteRenderFile(url);

    // Deleted: both read paths now report absence, not an error.
    expect(await statRenderFile(url)).toBeNull();
    expect(await getRenderFile(videoId, url)).toBeNull();
  });

  it("allowOverwrite lets a retried render replace the same pathname's bytes", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);

    const firstUrl = await writeRenderFile(videoId, Buffer.from("first-attempt"));
    const secondUrl = await writeRenderFile(videoId, Buffer.from("second-attempt-longer"));

    // Same deterministic pathname both times (addRandomSuffix: false).
    expect(firstUrl).toBe(secondUrl);

    const content = await getRenderFile(videoId, secondUrl);
    const readBack = await new Response(content!.stream).text();
    expect(readBack).toBe("second-attempt-longer");
  });
});

describe("a render that is on the DB but not in Blob", () => {
  it("statRenderFile returns null, never throws", async () => {
    const videoId = randomUUID(); // never written
    const pathname = renderBlobPathname(videoId);

    await expect(statRenderFile(pathname)).resolves.toBeNull();
  });

  it("getRenderFile returns null, never throws", async () => {
    const videoId = randomUUID();
    const pathname = renderBlobPathname(videoId);

    await expect(getRenderFile(videoId, pathname)).resolves.toBeNull();
  });

  it("RenderFileMissingError (thrown by callers on that null) is a ConflictError, so it serializes to a 409", () => {
    const videoId = randomUUID();
    const error = new RenderFileMissingError(videoId);

    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("no longer available");
  });
});

describe("range requests", () => {
  it("forwards the Range header to Blob and returns the real requested bytes with a matching content-range", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"); // 36 bytes
    const url = await writeRenderFile(videoId, body);

    const content = await getRenderFile(videoId, url, "bytes=5-9");
    expect(content).not.toBeNull();
    expect(content!.contentRange).toBe(`bytes 5-9/${body.byteLength}`);
    expect(content!.contentLength).toBe(5);

    const readBack = await new Response(content!.stream).text();
    // The actual bytes 5-9 of the fixture above, not just a length match —
    // this is the assertion that proves Blob's range handling, not just its
    // presence, is wired through correctly.
    expect(readBack).toBe("56789");
    expect(body.subarray(5, 10).toString()).toBe(readBack);
  });

  it("an open-ended suffix range still returns real bytes and a full content-range", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const url = await writeRenderFile(videoId, body);

    const content = await getRenderFile(videoId, url, "bytes=30-");
    expect(content).not.toBeNull();
    expect(content!.contentRange).toBe(`bytes 30-35/${body.byteLength}`);

    const readBack = await new Response(content!.stream).text();
    expect(readBack).toBe("UVWXYZ");
  });

  it("no Range header returns the whole file with no content-range", async () => {
    const videoId = randomUUID();
    writtenVideoIds.push(videoId);
    const body = Buffer.from("full-file-bytes");
    const url = await writeRenderFile(videoId, body);

    const content = await getRenderFile(videoId, url);
    expect(content!.contentRange).toBeNull();
    expect(content!.contentLength).toBe(body.byteLength);

    const readBack = await new Response(content!.stream).text();
    expect(readBack).toBe("full-file-bytes");
  });
});
