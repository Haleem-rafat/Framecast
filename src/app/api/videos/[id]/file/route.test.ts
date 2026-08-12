import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@/server/session` pulls in `next/headers` and better-auth's own session
// lookup — neither of which has anything to do with what this route's own
// logic (the ownership check, the disk read) is supposed to do. Mocked
// wholesale so each test controls exactly who the "current user" is, the
// same "inject the boundary this test isn't about" approach RenderService's
// `ProcessSpawner` and PublishService's `FetchLike` already use.
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));

import type { Session } from "@/lib/auth";
import { deleteRenderFile, renderPath, writeRenderFile } from "@/lib/render-storage";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/server/session";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

import { GET } from "./route";

// Tests run against a real, shared Supabase database (see src/test/setup.ts)
// and the real local render store (RENDER_ROOT, see render-storage.ts) —
// every test gets its own throwaway User (src/test/fixtures.ts) and cleans
// up whatever render it wrote in afterEach.
vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

function sessionFor(userId: string): Session {
  return { user: { id: userId } } as unknown as Session;
}

function fileRequest(videoId: string, rangeHeader?: string): NextRequest {
  const headers = rangeHeader ? { range: rangeHeader } : undefined;
  return new NextRequest(`http://localhost/api/videos/${videoId}/file`, { headers });
}

function call(videoId: string, rangeHeader?: string) {
  return GET(fileRequest(videoId, rangeHeader), { params: Promise.resolve({ id: videoId }) });
}

let ownerId: string;
const writtenVideoIds: string[] = [];

beforeEach(async () => {
  ownerId = await createTestUser("file-route");
});

afterEach(async () => {
  vi.mocked(getSession).mockReset();
  await deleteTestUser(ownerId);
  await Promise.all(
    writtenVideoIds.splice(0).map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
  );
});

/** A video belonging to `ownerId`, optionally with a SUCCEEDED RenderJob
 * pointing at real bytes on local disk. */
async function makeVideo(opts: { withRender?: Buffer } = {}): Promise<string> {
  const project = await projectService.create(ownerId, {
    name: `test-file-route-${RUN}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(ownerId, {
    projectId: project.id,
    title: "File route fixture",
    topic: "testing",
  });

  if (opts.withRender) {
    const outputUrl = await writeRenderFile(video.id, opts.withRender);
    writtenVideoIds.push(video.id);
    await prisma.renderJob.create({
      data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl },
    });
  }

  return video.id;
}

describe("GET /api/videos/[id]/file — auth", () => {
  it("401s an unauthenticated request without ever querying the video", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const findFirstSpy = vi.spyOn(prisma.video, "findFirst");

    const response = await call(randomUUID());

    expect(response.status).toBe(401);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("404s a video id that belongs to a different user", async () => {
    const intruderId = await createTestUser("file-route-intruder");
    try {
      const videoId = await makeVideo({ withRender: Buffer.from("owner-only-bytes") });
      vi.mocked(getSession).mockResolvedValue(sessionFor(intruderId));

      const response = await call(videoId);

      expect(response.status).toBe(404);
    } finally {
      await deleteTestUser(intruderId);
    }
  });

  it("404s a video id that does not exist at all", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(randomUUID());

    expect(response.status).toBe(404);
  });
});

describe("GET /api/videos/[id]/file — missing render", () => {
  it("404s a video with no RenderJob yet", async () => {
    const videoId = await makeVideo();
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(videoId);

    expect(response.status).toBe(404);
  });

  it("409s (RenderFileMissingError) a video whose RenderJob points at a file that no longer exists", async () => {
    const videoId = await makeVideo({ withRender: Buffer.from("will-be-deleted") });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));
    await deleteRenderFile(renderPath(videoId));

    const response = await call(videoId);

    // Distinct from "never rendered" (404) above — the row says a render
    // exists, so this is the named "needs re-rendering" condition
    // publish.service.ts and the video detail page already surface as 409.
    expect(response.status).toBe(409);
  });
});

describe("GET /api/videos/[id]/file — serving bytes", () => {
  it("returns the whole file with 200 when no Range header is sent", async () => {
    const body = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const videoId = await makeVideo({ withRender: Buffer.from(body) });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(videoId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();
    await expect(response.text()).resolves.toBe(body);
  });

  it("parses a Range header locally and returns 206 with the real requested bytes", async () => {
    const body = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36 bytes
    const videoId = await makeVideo({ withRender: Buffer.from(body) });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(videoId, "bytes=5-9");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 5-9/${body.length}`);
    expect(response.headers.get("content-length")).toBe("5");
    // The actual bytes 5-9 of the fixture, not just a status/length match —
    // this is what proves the route's range plumbing (not just its
    // presence) is wired through correctly.
    const received = await response.text();
    expect(received).toBe("56789");
    expect(body.slice(5, 10)).toBe(received);
  });

  it("416s with the real size when a Range starts past the end of a file re-rendered shorter", async () => {
    // What a filesystem can't answer for itself the way Blob used to: a
    // player seeking into a video that got shorter on re-render must get a
    // 416 carrying the real size, not a 200 carrying bytes it never asked
    // for. See render-storage.ts's getRenderFile and http-range.ts.
    const body = "short-body"; // 10 bytes
    const videoId = await makeVideo({ withRender: Buffer.from(body) });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(videoId, "bytes=500-");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${body.length}`);
  });
});
