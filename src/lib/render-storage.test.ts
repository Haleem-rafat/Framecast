import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@/lib/errors";
import type { RenderFileContent } from "@/lib/render-storage";

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

/** Narrows `getRenderFile`'s three-outcome return type down to real content,
 * failing loudly (rather than a confusing property-access crash) if a test
 * that expects a hit got `null` or `"unsatisfiable"` instead. */
function expectContent(
  content: RenderFileContent | null | "unsatisfiable",
): RenderFileContent {
  if (content === null || content === "unsatisfiable") {
    throw new Error(`Expected render file content, got ${JSON.stringify(content)}`);
  }
  return content;
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
    expect(() => renderPath("../escape")).toThrow(ValidationError);
    expect(() => renderPath("not-a-uuid")).toThrow(ValidationError);
    expect(() => renderPath("")).toThrow(ValidationError);
  });
});

describe("path traversal — resolveRender, not renderPath", () => {
  // `outputUrl` is database-supplied, not the output of `renderPath` — the
  // route never calls `renderPath` at all (see file/route.ts), so a suite
  // that only exercises `renderPath`'s own UUID check says nothing about the
  // guard that actually stands between a stored `outputUrl` and an arbitrary
  // filesystem read: `resolveRender`, exercised here through every function
  // that takes a `location` directly.
  it("refuses a traversing location passed to getRenderFile", async () => {
    const { getRenderFile } = await renderStorage();
    await expect(getRenderFile(VIDEO_ID, "../escape.mp4")).rejects.toThrow(ValidationError);
  });

  it("refuses a traversing location passed to statRenderFile", async () => {
    const { statRenderFile } = await renderStorage();
    await expect(statRenderFile("../escape.mp4")).rejects.toThrow(ValidationError);
  });

  it("refuses a traversing location passed to deleteRenderFile", async () => {
    const { deleteRenderFile } = await renderStorage();
    await expect(deleteRenderFile("../escape.mp4")).rejects.toThrow(ValidationError);
  });

  it("refuses a prefix-trap location — a sibling directory that merely shares ROOT's string prefix", async () => {
    const { getRenderFile } = await renderStorage();
    // If resolveRender checked `absolute.startsWith(ROOT)` instead of
    // `absolute.startsWith(ROOT + sep)`, this would slip through undetected:
    // `join(ROOT, trap)` resolves to `<dirname(ROOT)>/<basename(ROOT)>-evil/x.mp4`,
    // which starts with the exact string ROOT while living in a sibling
    // directory entirely outside it.
    const trap = `../${basename(root)}-evil/x.mp4`;
    await expect(getRenderFile(VIDEO_ID, trap)).rejects.toThrow(ValidationError);
  });
});

describe("writeRenderFile / getRenderFile", () => {
  it("round-trips bytes and reports where it put them", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const body = Buffer.from("abcdefghijklmnopqrstuvwxyz");

    const location = await writeRenderFile(VIDEO_ID, body);
    expect(location).toBe(`renders/${VIDEO_ID}.mp4`);

    const content = expectContent(await getRenderFile(VIDEO_ID, location));
    expect(await readAll(content.stream)).toEqual(body);
    expect(content.sizeBytes).toBe(26);
    expect(content.contentLength).toBe(26);
    expect(content.contentRange).toBeNull();
    expect(content.contentType).toBe("video/mp4");
  });

  it("accepts a stream source without buffering it into a Buffer first — what render.service.ts actually passes", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const body = Buffer.from("streamed-instead-of-buffered");

    const location = await writeRenderFile(VIDEO_ID, Readable.from(body));

    const content = expectContent(await getRenderFile(VIDEO_ID, location));
    expect(await readAll(content.stream)).toEqual(body);
  });

  it("serves a byte range and describes it the way the route expects", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("abcdefghijklmnopqrstuvwxyz"));

    const content = expectContent(await getRenderFile(VIDEO_ID, location, "bytes=5-9"));

    expect(await readAll(content.stream)).toEqual(Buffer.from("fghij"));
    expect(content.contentLength).toBe(5);
    expect(content.sizeBytes).toBe(26);
    expect(content.contentRange).toBe("bytes 5-9/26");
  });

  it("serves an open-ended range to the last byte", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const location = await writeRenderFile(VIDEO_ID, Buffer.from("abcdefghijklmnopqrstuvwxyz"));

    const content = expectContent(await getRenderFile(VIDEO_ID, location, "bytes=20-"));

    expect(await readAll(content.stream)).toEqual(Buffer.from("uvwxyz"));
    expect(content.contentRange).toBe("bytes 20-25/26");
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

/** A stream that emits a few bytes, then errors — standing in for a
 * mid-write failure (a real one would be e.g. ENOSPC on a full 40GB disk). */
function failingStream(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.from("partial-bytes-that-must-never-land"));
      queueMicrotask(() => this.destroy(new Error("boom")));
    },
  });
}

describe("writeRenderFile — atomicity and fd safety", () => {
  it("leaves the previous complete render untouched when a re-render fails mid-write", async () => {
    const { writeRenderFile, getRenderFile } = await renderStorage();
    const original = Buffer.from("original-complete-render");
    const location = await writeRenderFile(VIDEO_ID, original);

    // Writing in place (this module's behaviour before the fix) would
    // truncate `location` the instant the second write started, so
    // `getRenderFile` would see a corrupt, partial file here — or nothing at
    // all, if the failure landed before any bytes were flushed. The
    // temp-file-then-rename write means a failed re-render never touches the
    // file `location` already points at.
    await expect(writeRenderFile(VIDEO_ID, failingStream())).rejects.toThrow();

    const content = expectContent(await getRenderFile(VIDEO_ID, location));
    expect(await readAll(content.stream)).toEqual(original);
  });

  it("cleans up its temp file when a write fails, rather than leaving it under RENDER_ROOT forever", async () => {
    const { writeRenderFile } = await renderStorage();

    await expect(writeRenderFile(VIDEO_ID, failingStream())).rejects.toThrow();

    const entries = await readdir(join(root, "renders"));
    expect(entries.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("destroys a stream source when the write is refused before ever reaching pipeline", async () => {
    const { writeRenderFile } = await renderStorage();
    const source = Readable.from(Buffer.from("would-leak-its-fd-without-destroy"));

    // An invalid video id makes `renderPath` throw before `source` is ever
    // piped — exactly the window pipeline's own cleanup can't reach, since
    // pipeline never got to run.
    await expect(writeRenderFile("not-a-uuid", source)).rejects.toThrow(ValidationError);

    expect(source.destroyed).toBe(true);
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
