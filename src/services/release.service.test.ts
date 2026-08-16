import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { deleteRenderFile, renderPath, writeRenderFile } from "@/lib/render-storage";
import { deleteShortFile, writeShortFile } from "@/lib/shorts-storage";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import { PublishService } from "@/services/publish.service";
import { ReleaseService } from "@/services/release.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The shorts drip, against a real Postgres and the real render store.
 *
 * Same discipline as publish.service.test.ts and schedule.service.test.ts:
 * these run against a shared database that also holds the operator's real data,
 * so every test gets its own throwaway `User` (src/test/fixtures.ts). YouTube
 * itself is never called — `fetch` is injected into `PublishService`.
 *
 * The publisher is deliberately a **real** `PublishService` with a fake `fetch`
 * rather than a stub of `publishShort`. Two of the behaviours this file has to
 * prove live inside that method and nowhere else: that a spent quota gives the
 * clip its one-shot attempt back, and that a missing file never takes it. A
 * stub would assert that `ReleaseService` calls something, which is the
 * uninteresting half.
 *
 * The DST arithmetic is asserted in src/lib/release-time.test.ts, which needs
 * no database at all. What is asserted here is that the *claim* uses it — that
 * the instant written back into `nextReleaseAt` is the one that reads 08:00 on
 * the operator's own clock.
 */

const RUN = randomUUID().slice(0, 8);

// A tick is a claim, a queue scan, a stat, an upload and three history writes —
// a dozen sequential round trips to a remote database, and the concurrency
// tests do that several times over.
vi.setConfig({ testTimeout: 40_000 });

let userId: string;

/** Render files written under RENDER_ROOT by the fixtures below. `Video` rows
 *  go with the user's cascade; their files do not. */
const renderedVideoIds: string[] = [];
/** Short files, same reasoning. */
const shortFilePaths: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("release");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestUser(userId);
  await Promise.all(
    renderedVideoIds.splice(0).map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
  );
  await Promise.all(
    shortFilePaths.splice(0).map((location) => deleteShortFile(location).catch(() => {})),
  );
});

/** One recorded `videos.insert`, so a test can prove what went up. */
interface RecordedUpload {
  title: string;
  privacyStatus: string;
  youtubeVideoId: string;
}

/**
 * A fake resumable-upload endpoint. `quotaAt` fails the nth upload with the
 * exact 403 body YouTube sends when the daily allowance is gone — the reason
 * token in the body is the only thing separating that from a 403 for an
 * unverified channel, so it is reproduced verbatim.
 */
function createUploadFetch(
  opts: { quotaAt?: number; failAt?: number } = {},
): { fetchImpl: FetchLike; uploads: RecordedUpload[] } {
  const uploads: RecordedUpload[] = [];
  let attempts = 0;

  const fetchImpl: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("uploadType=resumable")) {
      const at = attempts++;

      if (opts.quotaAt === at) {
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          json: async () => ({
            error: {
              code: 403,
              message: "The request cannot be completed because you have exceeded your quota.",
              errors: [{ domain: "youtube.quota", reason: "quotaExceeded" }],
            },
          }),
        } as unknown as Response;
      }

      if (opts.failAt === at) {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }

      const body = JSON.parse(init!.body as string) as {
        snippet: { title: string };
        status: { privacyStatus: string };
      };

      uploads.push({
        title: body.snippet.title,
        privacyStatus: body.status.privacyStatus,
        youtubeVideoId: `yt_release_${at}`,
      });

      return {
        ok: true,
        status: 200,
        headers: new Headers({
          location: `https://upload.example.invalid/resumable/${at}`,
        }),
        json: async () => ({}),
      } as unknown as Response;
    }

    // The PUT of the actual bytes to the resumable location.
    const at = Number(url.split("/").pop());

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: uploads[at]?.youtubeVideoId ?? "yt_release" }),
    } as unknown as Response;
  }) as FetchLike;

  return { fetchImpl, uploads };
}

function service(opts: { quotaAt?: number; failAt?: number } = {}) {
  const { fetchImpl, uploads } = createUploadFetch(opts);

  return { service: new ReleaseService(new PublishService(fetchImpl)), uploads };
}

async function makeChannel(): Promise<string> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: `Money Mechanics ${RUN}`,
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  return channel.id;
}

/** A published-and-rendered video on `channelId`, ready to be cut into shorts. */
async function makeVideo(channelId: string, title: string): Promise<string> {
  const project = await projectService.create(userId, {
    name: `release-${randomUUID().slice(0, 8)}`,
    channelId,
  });

  const video = await videoService.create(userId, {
    projectId: project.id,
    title,
    topic: "inflation",
  });

  const outputUrl = await writeRenderFile(video.id, Buffer.from(`fake-render-${RUN}`));
  renderedVideoIds.push(video.id);

  await prisma.renderJob.create({
    data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl },
  });
  await prisma.video.update({ where: { id: video.id }, data: { status: "READY" } });

  return video.id;
}

/** A banked clip: READY, with real bytes under RENDER_ROOT and no publication. */
async function makeBankedShort(
  videoId: string,
  index: number,
  opts: { withFile?: boolean } = {},
): Promise<{ id: string; outputPath: string }> {
  const short = await prisma.short.create({
    data: {
      videoId,
      index,
      startSeconds: index * 60,
      endSeconds: index * 60 + 40,
      title: `Clip ${index + 1}`,
      description: `What clip ${index + 1} covers.`,
      reason: "It stands on its own.",
      status: "READY",
    },
    select: { id: true },
  });

  const sourcePath = path.join(tmpdir(), `framecast-test-short-${short.id}.mp4`);
  await writeFile(sourcePath, Buffer.from(`fake-short-${short.id}`));
  const outputPath = await writeShortFile(short.id, sourcePath);
  await rm(sourcePath, { force: true });
  shortFilePaths.push(outputPath);

  await prisma.short.update({ where: { id: short.id }, data: { outputPath } });

  // `withFile: false` is the hand-deleted-clip case: the row still points at a
  // path, and there is nothing behind it. Written and then removed rather than
  // never written, so the row is byte-for-byte what a real one looks like.
  if (opts.withFile === false) {
    await deleteShortFile(outputPath);
  }

  return { id: short.id, outputPath };
}

/** A cadence that is already overdue, so a single `tick()` fires it. */
async function makeDueCadence(
  channelId: string,
  opts: { dueAt?: Date; slotMinutes?: number[]; timeZone?: string } = {},
): Promise<string> {
  const cadence = await prisma.releaseCadence.create({
    data: {
      userId,
      channelId,
      slotMinutes: opts.slotMinutes ?? [480, 840, 1200],
      timeZone: opts.timeZone ?? "UTC",
      visibility: "PUBLIC",
      nextReleaseAt: opts.dueAt ?? new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });

  return cadence.id;
}

describe("releaseService — a due slot releases exactly one clip", () => {
  it("publishes the head of the queue and records it", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const first = await makeBankedShort(videoId, 0);
    const second = await makeBankedShort(videoId, 1);
    const cadenceId = await makeDueCadence(channelId);

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SUCCEEDED");
    expect(result?.shortId).toBe(first.id);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].title).toBe("Clip 1");
    expect(uploads[0].privacyStatus).toBe("public");

    const publication = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: first.id },
    });
    expect(publication.status).toBe("PUBLISHED");
    expect(publication.channelId).toBe(channelId);
    expect(publication.publishedAt).not.toBeNull();

    // One slot, one clip. The second stays banked for the next one.
    expect(await prisma.shortPublication.count({ where: { shortId: second.id } })).toBe(0);

    const runs = await prisma.releaseRun.findMany({ where: { cadenceId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("SUCCEEDED");
    expect(runs[0].shortId).toBe(first.id);
    expect(runs[0].youtubeVideoId).toBe(publication.youtubeVideoId);
  });

  it("advances nextReleaseAt into the future and releases the claim", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    await service().service.tick();

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.nextReleaseAt).not.toBeNull();
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
    // A lease left behind would make the cadence skip its own next slot.
    expect(cadence.claimExpiresAt).toBeNull();
    expect(cadence.status).toBe("ACTIVE");
    expect(cadence.consecutiveFailures).toBe(0);
    expect(cadence.lastReleaseAt).not.toBeNull();
  });

  it("is no longer due immediately afterwards", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    await makeBankedShort(videoId, 1);
    await makeDueCadence(channelId);

    const { service: releases } = service();

    expect(await releases.tick()).not.toBeNull();
    expect(await releases.tick()).toBeNull();
  });

  it("spends the queue oldest video first, then in play order within it", async () => {
    const channelId = await makeChannel();
    const older = await makeVideo(channelId, "The older video");
    // A distinct `createdAt`, since the ordering is on the video and two rows
    // created in the same millisecond would make this assertion a coin toss.
    await prisma.video.update({
      where: { id: older },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const newer = await makeVideo(channelId, "The newer video");

    const newerClip = await makeBankedShort(newer, 0);
    const olderSecond = await makeBankedShort(older, 1);
    const olderFirst = await makeBankedShort(older, 0);

    const cadenceId = await makeDueCadence(channelId);
    const { service: releases } = service();

    for (const expected of [olderFirst, olderSecond, newerClip]) {
      await prisma.releaseCadence.update({
        where: { id: cadenceId },
        data: { nextReleaseAt: new Date(Date.now() - 60_000) },
      });

      const result = await releases.tick();
      expect(result?.shortId).toBe(expected.id);
    }
  });
});

describe("releaseService — the claim race", () => {
  it("never releases the same slot twice under concurrent ticks", async () => {
    // The failure this prevents is unrecoverable rather than merely expensive:
    // two workers poll the same table, both see the same due cadence, and the
    // same clip goes onto the channel twice — with no unpublish path from this
    // app. Run several rounds so the race is genuinely exercised rather than
    // accidentally serialised by a fast first call.
    for (let round = 0; round < 4; round++) {
      const channelId = await makeChannel();
      const videoId = await makeVideo(channelId, `Race round ${round}`);
      const only = await makeBankedShort(videoId, 0);
      const cadenceId = await makeDueCadence(channelId);

      // Two independent services, as two workers would be, sharing one fake
      // upload endpoint so the call count is across both.
      const { fetchImpl, uploads } = createUploadFetch();
      const [first, second] = await Promise.all([
        new ReleaseService(new PublishService(fetchImpl)).tick(),
        new ReleaseService(new PublishService(fetchImpl)).tick(),
      ]);

      const fired = [first, second].filter((result) => result !== null);

      expect(fired).toHaveLength(1);
      expect(uploads).toHaveLength(1);

      // And the durable record agrees: one history row, one publication.
      expect(await prisma.releaseRun.count({ where: { cadenceId } })).toBe(1);
      expect(await prisma.shortPublication.count({ where: { shortId: only.id } })).toBe(1);

      await prisma.releaseCadence.delete({ where: { id: cadenceId } });
    }
  });

  it("cannot be claimed twice for the same slot even by a repeated claim", async () => {
    // `claimDue` is the lock; this asserts it directly rather than through
    // `tick`, because it is the single statement everything else rests on.
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    const { service: releases } = service();
    const claims = await Promise.all([
      releases.claimDue(),
      releases.claimDue(),
      releases.claimDue(),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("releaseService — an empty queue is a normal state", () => {
  it("records a skip, does not pause, and does not count a failure", async () => {
    const channelId = await makeChannel();
    await makeVideo(channelId, "A video nobody has cut yet");
    const cadenceId = await makeDueCadence(channelId);

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(result?.reason).toMatch(/Nothing was banked/);
    expect(uploads).toHaveLength(0);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    // The whole point of the difference from ScheduleService: a schedule with
    // an empty topic queue pauses itself; a cadence with nothing banked has not
    // failed, and must restart by itself the moment a video is cut.
    expect(cadence.status).toBe("ACTIVE");
    expect(cadence.consecutiveFailures).toBe(0);
    expect(cadence.pausedReason).toBeNull();
    // It still moved, because the due-check did look.
    expect(cadence.lastReleaseAt).not.toBeNull();
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());

    const runs = await prisma.releaseRun.findMany({ where: { cadenceId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("SKIPPED");
    expect(runs[0].shortId).toBeNull();
  });

  it("picks up by itself as soon as a clip is banked", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const cadenceId = await makeDueCadence(channelId);

    const { service: releases, uploads } = service();
    expect((await releases.tick())?.outcome).toBe("SKIPPED");

    const short = await makeBankedShort(videoId, 0);

    await prisma.releaseCadence.update({
      where: { id: cadenceId },
      data: { nextReleaseAt: new Date(Date.now() - 60_000) },
    });

    const result = await releases.tick();

    expect(result?.outcome).toBe("SUCCEEDED");
    expect(result?.shortId).toBe(short.id);
    expect(uploads).toHaveLength(1);
  });

  it("never publishes a short that already has a publication row", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const short = await makeBankedShort(videoId, 0);

    // A previous attempt that failed. One-shot: the row blocks a retry
    // regardless of its status, the same rule Publication.videoId enforces.
    await prisma.shortPublication.create({
      data: {
        shortId: short.id,
        channelId,
        title: "Clip 1",
        status: "FAILED",
        error: "Something went wrong last time.",
      },
    });

    await makeDueCadence(channelId);

    const { service: releases, uploads } = service();

    expect((await releases.tick())?.outcome).toBe("SKIPPED");
    expect(uploads).toHaveLength(0);
  });
});

describe("releaseService — a clip whose file is gone", () => {
  it("marks it failed and releases the next one instead, so the slot is not wasted", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const missing = await makeBankedShort(videoId, 0, { withFile: false });
    const present = await makeBankedShort(videoId, 1);
    await makeDueCadence(channelId);

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    // The slot went to the clip behind it rather than being spent discovering
    // the problem.
    expect(result?.outcome).toBe("SUCCEEDED");
    expect(result?.shortId).toBe(present.id);
    expect(uploads).toHaveLength(1);

    // And the broken one is out of the queue for good, rather than stalling
    // the whole drip on it forever.
    const stale = await prisma.short.findUniqueOrThrow({ where: { id: missing.id } });
    expect(stale.status).toBe("FAILED");
    expect(stale.error).toMatch(/no longer on disk/);

    // Crucially: no publication row was created for it, so nothing believes an
    // upload was attempted.
    expect(await prisma.shortPublication.count({ where: { shortId: missing.id } })).toBe(0);
  });

  it("skips the slot when nothing left in the bank has a file", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const missing = await makeBankedShort(videoId, 0, { withFile: false });
    await makeDueCadence(channelId);

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(uploads).toHaveLength(0);
    expect(
      (await prisma.short.findUniqueOrThrow({ where: { id: missing.id } })).status,
    ).toBe("FAILED");
  });

  it("refuses a direct publish of a missing file without spending its one attempt", async () => {
    // The guard inside `publishShort` itself, asserted on its own: the file is
    // checked *before* the claim row is taken, so a hand-deleted clip does not
    // silently lose its single attempt.
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const missing = await makeBankedShort(videoId, 0, { withFile: false });

    const { fetchImpl, uploads } = createUploadFetch();

    await expect(
      new PublishService(fetchImpl).publishShort(userId, missing.id, {
        visibility: "PUBLIC",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(uploads).toHaveLength(0);
    expect(await prisma.shortPublication.count({ where: { shortId: missing.id } })).toBe(0);
  });
});

describe("releaseService — the daily upload allowance", () => {
  it("names the shared quota, keeps the clip banked, and stays active", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const short = await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    const { service: releases } = service({ quotaAt: 0 });
    const result = await releases.tick();

    expect(result?.outcome).toBe("FAILED");
    // Not a bare 403: the operator would go looking for a permissions problem
    // that is not there.
    expect(result?.reason).toMatch(/daily upload allowance/i);
    expect(result?.reason).toMatch(/midnight Pacific/i);
    // And the fact that makes this diagnosable at all — the bucket belongs to
    // the Google Cloud project, so the operator's other channels are failing
    // the same way and this one is not at fault.
    expect(result?.reason).toMatch(/shared by every channel/i);

    // The clip keeps its one attempt: `videos.insert` refused, so nothing
    // exists on YouTube and nothing is at risk of being duplicated.
    expect(await prisma.shortPublication.count({ where: { shortId: short.id } })).toBe(0);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.status).toBe("ACTIVE");
    expect(cadence.consecutiveFailures).toBe(1);

    const runs = await prisma.releaseRun.findMany({ where: { cadenceId } });
    expect(runs[0].outcome).toBe("FAILED");
    expect(runs[0].reason).toMatch(/daily upload allowance/i);
  });

  it("releases the same clip once the allowance is back", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const short = await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    expect((await service({ quotaAt: 0 }).service.tick())?.outcome).toBe("FAILED");

    await prisma.releaseCadence.update({
      where: { id: cadenceId },
      data: { nextReleaseAt: new Date(Date.now() - 60_000) },
    });

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    // Tomorrow's slot finds the clip exactly where it left it.
    expect(result?.outcome).toBe("SUCCEEDED");
    expect(result?.shortId).toBe(short.id);
    expect(uploads).toHaveLength(1);
    expect(
      (await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } }))
        .consecutiveFailures,
    ).toBe(0);
  });

  it("pauses itself after three failures in a row, naming the cause", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    for (let attempt = 0; attempt < 3; attempt++) {
      await prisma.releaseCadence.update({
        where: { id: cadenceId },
        data: { nextReleaseAt: new Date(Date.now() - 60_000) },
      });

      await service({ quotaAt: 0 }).service.tick();
    }

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.status).toBe("PAUSED");
    expect(cadence.pausedReason).toMatch(/3 releases in a row failed/);
    expect(cadence.pausedReason).toMatch(/daily upload allowance/i);

    // Paused means paused: the next due-check ignores it entirely.
    await prisma.releaseCadence.update({
      where: { id: cadenceId },
      data: { nextReleaseAt: new Date(Date.now() - 60_000) },
    });
    expect(await service().service.tick()).toBeNull();
  });

  it("keeps a failed upload's claim row, unlike a refused one", async () => {
    // A 500 mid-upload is not a refusal: YouTube may hold the video. The claim
    // stays FAILED so nothing re-uploads a clip that may already be live —
    // which is exactly the opposite of what a quota failure does, and the
    // distinction is the whole reason `publishShort` branches on the error.
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const short = await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    const result = await service({ failAt: 0 }).service.tick();

    expect(result?.outcome).toBe("FAILED");

    const publication = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: short.id },
    });
    expect(publication.status).toBe("FAILED");

    // So the clip is out of the queue, and the next slot finds nothing.
    await prisma.releaseCadence.update({
      where: { id: cadenceId },
      data: { nextReleaseAt: new Date(Date.now() - 60_000) },
    });
    expect((await service().service.tick())?.outcome).toBe("SKIPPED");
  });
});

describe("releaseService — downtime does not become a burst", () => {
  it("releases one clip for two days of missed slots, and records the rest", async () => {
    // The worker was down for two days. Catching up would dump six clips onto
    // the channel in ninety seconds, at whatever time of day the worker
    // happened to come back — which is the thing the slots exist to prevent.
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    await makeBankedShort(videoId, 1);
    await makeBankedShort(videoId, 2);

    const cadenceId = await makeDueCadence(channelId, {
      dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SUCCEEDED");
    expect(uploads).toHaveLength(1);

    const runs = await prisma.releaseRun.findMany({
      where: { cadenceId },
      orderBy: { scheduledFor: "asc" },
    });

    // One released, the rest recorded as missed rather than published late.
    expect(runs.filter((run) => run.outcome === "SUCCEEDED")).toHaveLength(1);
    const missed = runs.filter((run) => run.outcome === "MISSED");
    expect(missed.length).toBeGreaterThanOrEqual(4);
    expect(missed[0].reason).toMatch(/passed over rather than released late/);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("releaseService — DST", () => {
  it("advances to the instant that reads the same wall clock after a transition", async () => {
    // Europe/London moves to BST at 01:00 on Sunday 29 March 2026. A cadence
    // due at 08:00 on the Saturday must advance to the instant that reads 08:00
    // on the *Sunday* — 07:00Z, not 08:00Z. Adding 24 hours of milliseconds
    // would publish an hour late, every day, until October.
    const channelId = await makeChannel();
    const cadenceId = await makeDueCadence(channelId, {
      slotMinutes: [480],
      timeZone: "Europe/London",
      dueAt: new Date("2026-03-28T08:00:00Z"),
    });

    const claim = await service().service.claimDue();
    expect(claim).not.toBeNull();

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });

    // Not the naive 2026-03-29T08:00:00Z.
    const reading = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(cadence.nextReleaseAt!);

    // The claim happened long after March 2026 in wall-clock terms only if the
    // test clock says so; what is asserted is the *local reading*, which is
    // 08:00 whichever future day the walk lands on.
    expect(reading).toMatch(/ 08:00$/);
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps a whole day's slots straight through a spring-forward morning", async () => {
    // The reordering case, through the service rather than the pure module: on
    // 8 March 2026 in New York the 02:30 slot is deleted and fires at 03:30,
    // *after* the 03:00 slot. The claim must advance to 03:00, not skip it.
    const channelId = await makeChannel();
    const cadenceId = await makeDueCadence(channelId, {
      slotMinutes: [150, 180],
      timeZone: "America/New_York",
      // 01:30 EST on the morning of the transition.
      dueAt: new Date("2026-03-08T06:30:00Z"),
    });

    const claim = await service().service.claimDue();
    expect(claim).not.toBeNull();

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    // Whichever future slot the catch-up walk lands on, it must read as one of
    // the two configured times — never a third one invented by arithmetic.
    const reading = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(cadence.nextReleaseAt!);

    expect(["02:30", "03:00"]).toContain(reading);
  });
});

describe("releaseService — a channel that has gone", () => {
  it("pauses the cadence rather than skipping forever", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);

    await prisma.channel.update({
      where: { id: channelId },
      data: { deletedAt: new Date() },
    });

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(result?.reason).toMatch(/disconnected/);
    expect(uploads).toHaveLength(0);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.status).toBe("PAUSED");
    expect(cadence.pausedReason).toMatch(/disconnected/);
  });
});

describe("releaseService — operator actions", () => {
  it("starts a new cadence at the next slot, never immediately", async () => {
    const channelId = await makeChannel();
    const releases = new ReleaseService();

    const { id } = await releases.create(userId, {
      channelId,
      slotMinutes: [480, 840, 1200],
      timeZone: "UTC",
      visibility: "PUBLIC",
    });

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id } });
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
    // Nothing is due, so nothing goes out the moment Save is pressed.
    expect(await releases.claimDue()).toBeNull();
  });

  it("refuses a second cadence on the same channel", async () => {
    const channelId = await makeChannel();
    const releases = new ReleaseService();
    const input = {
      channelId,
      slotMinutes: [480],
      timeZone: "UTC",
      visibility: "PUBLIC" as const,
    };

    await releases.create(userId, input);
    await expect(releases.create(userId, input)).rejects.toBeInstanceOf(ConflictError);
  });

  it("pauses immediately and resumes from a future slot, not a missed one", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);
    const releases = new ReleaseService();

    await releases.pause(userId, cadenceId);
    expect(await releases.claimDue()).toBeNull();

    await releases.resume(userId, cadenceId);

    const cadence = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(cadence.status).toBe("ACTIVE");
    expect(cadence.pausedReason).toBeNull();
    // Not the overdue slot it was paused on — resuming means "carry on from
    // here", not "catch up on what I paused".
    expect(cadence.nextReleaseAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await releases.claimDue()).toBeNull();
  });

  it("resumes a cadence with nothing banked, unlike a schedule with no topics", async () => {
    const channelId = await makeChannel();
    const cadenceId = await makeDueCadence(channelId);
    const releases = new ReleaseService();

    await releases.pause(userId, cadenceId);
    // An operator who has just fixed a quota problem should not have to wait
    // for a render to finish before they can turn their channel back on.
    await expect(releases.resume(userId, cadenceId)).resolves.toBeUndefined();
  });

  it("only recomputes the next slot when the timing actually changed", async () => {
    const channelId = await makeChannel();
    const cadenceId = await makeDueCadence(channelId, { dueAt: new Date(Date.now() + 60_000) });
    const releases = new ReleaseService();

    const before = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });

    // Visibility only: the next release must not move. Changing it at 07:59
    // pushing that morning's clip to 14:00 would be a destructive side effect
    // of an edit that had nothing to do with time.
    await releases.update(userId, cadenceId, {
      slotMinutes: [480, 840, 1200],
      timeZone: "UTC",
      visibility: "UNLISTED",
    });

    const unchanged = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(unchanged.nextReleaseAt!.getTime()).toBe(before.nextReleaseAt!.getTime());
    expect(unchanged.visibility).toBe("UNLISTED");

    await releases.update(userId, cadenceId, {
      slotMinutes: [540],
      timeZone: "UTC",
      visibility: "UNLISTED",
    });

    const moved = await prisma.releaseCadence.findUniqueOrThrow({ where: { id: cadenceId } });
    expect(moved.nextReleaseAt!.getTime()).not.toBe(before.nextReleaseAt!.getTime());
  });

  it("leaves banked clips alone when the cadence is deleted", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    const short = await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);
    const releases = new ReleaseService();

    await releases.remove(userId, cadenceId);

    expect(await prisma.releaseCadence.count({ where: { id: cadenceId } })).toBe(0);
    // The bank is untouched, so a new cadence finds exactly the same queue.
    expect(
      (await prisma.short.findUniqueOrThrow({ where: { id: short.id } })).status,
    ).toBe("READY");
  });
});

describe("releaseService — the read model", () => {
  it("reports the bank, the cover it buys, and what goes out when", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    for (let index = 0; index < 7; index++) {
      await makeBankedShort(videoId, index);
    }

    const cadenceId = await makeDueCadence(channelId, {
      dueAt: new Date(Date.now() + 60_000),
    });

    const detail = await new ReleaseService().get(userId, cadenceId);

    expect(detail.bankedCount).toBe(7);
    // Seven clips at three a day. Floored, never rounded up: "about two days"
    // when there is two and a third is the direction that gets a video
    // recorded in time.
    expect(detail.daysOfCover).toBe(2);
    expect(detail.cadence).toBe("Every day at 08:00, 14:00 and 20:00 (UTC)");
    expect(detail.nextShortTitle).toBe("Clip 1");

    // The queue is paired with the slots that will spend it, in order.
    expect(detail.queue).toHaveLength(7);
    expect(detail.queue[0].title).toBe("Clip 1");
    expect(detail.queue[0].releasesAt?.getTime()).toBe(detail.nextReleaseAt?.getTime());
    for (let index = 1; index < detail.queue.length; index++) {
      expect(detail.queue[index].releasesAt!.getTime()).toBeGreaterThan(
        detail.queue[index - 1].releasesAt!.getTime(),
      );
    }
  });

  it("offers no release times for a paused cadence", async () => {
    const channelId = await makeChannel();
    const videoId = await makeVideo(channelId, "How inflation actually works");
    await makeBankedShort(videoId, 0);
    const cadenceId = await makeDueCadence(channelId);
    const releases = new ReleaseService();

    await releases.pause(userId, cadenceId);
    const detail = await releases.get(userId, cadenceId);

    // Showing a time on a paused cadence would advertise a clip that is not
    // coming.
    expect(detail.queue[0].releasesAt).toBeNull();
  });

  it("scopes every read to the signed-in user", async () => {
    const channelId = await makeChannel();
    const cadenceId = await makeDueCadence(channelId);

    const stranger = await createTestUser("release-stranger");

    try {
      const releases = new ReleaseService();

      expect(await releases.list(stranger)).toEqual([]);
      // A foreign id and an invented one are indistinguishable, so nothing
      // leaks about whether the row exists.
      await expect(releases.get(stranger, cadenceId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(releases.pause(stranger, cadenceId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(releases.remove(stranger, cadenceId)).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await deleteTestUser(stranger);
    }
  });

  it("never draws a clip from another channel's bank", async () => {
    const mine = await makeChannel();
    const theirs = await makeChannel();

    const theirVideo = await makeVideo(theirs, "Somebody else's video");
    await makeBankedShort(theirVideo, 0);

    await makeDueCadence(mine);

    const { service: releases, uploads } = service();
    const result = await releases.tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(uploads).toHaveLength(0);
  });
});
