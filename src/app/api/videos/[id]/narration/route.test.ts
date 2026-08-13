import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@/server/session` pulls in `next/headers` and better-auth's own session
// lookup — neither of which has anything to do with what this route's own
// logic (the ownership check, the storage read) is supposed to do. Mocked
// wholesale so each test controls exactly who the "current user" is, same
// approach as file/route.test.ts.
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));

import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { putObject, removeObjects, storagePath } from "@/lib/storage";
import { getSession } from "@/server/session";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

import { GET } from "./route";

// Tests run against a real, shared Postgres database (see src/test/setup.ts)
// and the real local storage root (see storage.ts) — every test gets its own
// throwaway User (src/test/fixtures.ts) and its own throwaway storage object,
// cleaned up in afterEach.
vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

function sessionFor(userId: string): Session {
  return { user: { id: userId } } as unknown as Session;
}

function call(videoId: string) {
  const request = new NextRequest(`http://localhost/api/videos/${videoId}/narration`);
  return GET(request, { params: Promise.resolve({ id: videoId }) });
}

let ownerId: string;
const writtenPaths: string[] = [];

beforeEach(async () => {
  ownerId = await createTestUser("narration-route");
});

afterEach(async () => {
  vi.mocked(getSession).mockReset();
  await deleteTestUser(ownerId);
  await removeObjects(writtenPaths.splice(0)).catch(() => {});
});

/** A video belonging to `ownerId`, optionally with a VoiceOver row pointing
 * at real bytes written to storage. */
async function makeVideo(opts: { withNarration?: Buffer } = {}): Promise<string> {
  const project = await projectService.create(ownerId, {
    name: `test-narration-route-${RUN}-${randomUUID().slice(0, 8)}`,
  });
  const video = await videoService.create(ownerId, {
    projectId: project.id,
    title: "Narration route fixture",
    topic: "testing",
  });

  if (opts.withNarration) {
    const audioPath = storagePath(video.id, "audio", "narration.mp3");
    const audioUrl = await putObject(audioPath, opts.withNarration, "audio/mpeg");
    writtenPaths.push(audioUrl);

    await prisma.voiceOver.create({
      data: {
        videoId: video.id,
        provider: "ELEVENLABS",
        voiceId: "test-voice",
        audioUrl,
      },
    });
  }

  return video.id;
}

describe("GET /api/videos/[id]/narration — auth", () => {
  it("401s an unauthenticated request without ever querying the video", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const findFirstSpy = vi.spyOn(prisma.voiceOver, "findFirst");

    const response = await call(randomUUID());

    expect(response.status).toBe(401);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("404s a video id that belongs to a different user, same as one with no narration", async () => {
    const intruderId = await createTestUser("narration-route-intruder");
    try {
      const videoId = await makeVideo({ withNarration: Buffer.from("owner-only-bytes") });
      vi.mocked(getSession).mockResolvedValue(sessionFor(intruderId));

      const intruderResponse = await call(videoId);
      expect(intruderResponse.status).toBe(404);
      const intruderBody = await intruderResponse.json();

      const noNarrationVideoId = await makeVideo();
      vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));
      const noNarrationResponse = await call(noNarrationVideoId);
      expect(noNarrationResponse.status).toBe(404);
      const noNarrationBody = await noNarrationResponse.json();

      // A video that belongs to someone else must be indistinguishable from
      // one that has no narration at all — same status, same body.
      expect(intruderBody).toEqual(noNarrationBody);
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

describe("GET /api/videos/[id]/narration — missing object", () => {
  it("409s a video whose VoiceOver points at an object that no longer exists", async () => {
    const videoId = await makeVideo({ withNarration: Buffer.from("will-be-deleted") });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));
    await removeObjects(writtenPaths.splice(0));

    const response = await call(videoId);

    // Distinct from "no narration at all" (404) above — the row says the
    // narration exists, so this is the named "needs regenerating" condition,
    // the same shape /api/videos/[id]/file returns for a missing render. It
    // must not be the 500 `getObject`'s InternalError would produce.
    expect(response.status).toBe(409);
  });
});

describe("GET /api/videos/[id]/narration — serving bytes", () => {
  it("returns 200 with the narration bytes and the right headers for the owner", async () => {
    const body = "fake-mp3-bytes-for-the-narration-route-test";
    const videoId = await makeVideo({ withNarration: Buffer.from(body) });
    vi.mocked(getSession).mockResolvedValue(sessionFor(ownerId));

    const response = await call(videoId);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    await expect(response.text()).resolves.toBe(body);
  });
});
