import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
