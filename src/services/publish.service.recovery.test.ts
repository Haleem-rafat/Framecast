import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { deleteRenderFile, renderPath, writeRenderFile } from "@/lib/render-storage";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import { PublishService, PUBLISH_LEASE_SECONDS } from "@/services/publish.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The two defects a real publish hit on the same day, and the one mechanism
 * they share.
 *
 * A 463MB render was published from inside the app container — the publish is a
 * Server Action, so it runs in the app process, not the worker — and a deploy
 * restarted that container twice while the upload was streaming. A SIGKILL runs
 * no `catch`, so the `Publication` row was left `UPLOADING` with a null
 * `youtubeVideoId`, a null `error`, and an `updatedAt` that never moved off
 * `createdAt`. Nothing on any screen could tell that from an upload still in
 * progress, and because `Publication.videoId` is `@unique`, that row went on
 * refusing every retry for a video that had never reached YouTube at all.
 *
 * Everything below is about telling those two states apart safely. The
 * asymmetry is the whole design: calling a *dead* upload alive costs the
 * operator a wait, and calling a *live* upload dead risks a second copy of a
 * video on a real channel that this app has no way to remove. So the tests here
 * lean hard on the second direction — a slow upload must keep its claim, a live
 * lease must refuse to be cleared, and a video already on YouTube must refuse
 * forever.
 *
 * Real Postgres and a real render on disk, like every other publish test.
 * YouTube is never called: `fetch` is injected.
 */
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-recovery-${RUN}`;

vi.setConfig({ testTimeout: 20_000 });

let userId: string;

/** Render fixtures written under RENDER_ROOT, swept in `afterEach` — a `User`
 *  cascade cannot reach a file on disk. */
const renderVideoIds: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("publish-recovery");
});

afterEach(async () => {
  await deleteTestUser(userId);
  await Promise.all(
    renderVideoIds.splice(0).map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
  );
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * A fake resumable-upload endpoint that speaks the chunked half of the
 * protocol: a `Content-Range` PUT that does not reach the last byte is answered
 * `308` with a `Range` header naming what it kept, and the one that does is
 * answered with the finished video's id.
 *
 * `onChunk` runs after each chunk is accepted and before the response is
 * returned, which is the only moment a test can observe the database *during* a
 * live upload — the point of the whole progress mechanism.
 */
function createChunkedFetch(
  opts: {
    youtubeVideoId?: string;
    /** Fail the PUT at this offset, to model an upload that dies partway. */
    failAtOffset?: number;
    /** Confirm fewer bytes than were sent, to model YouTube keeping part of a
     *  chunk. */
    shortConfirmBy?: number;
    onChunk?: (offset: number, end: number) => Promise<void>;
  } = {},
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const youtubeVideoId = opts.youtubeVideoId ?? `yt_${randomUUID().slice(0, 8)}`;

  const fetchImpl: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("uploadType=resumable")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          location: "https://upload.example.invalid/resumable/chunked",
        }),
        json: async () => ({}),
      } as unknown as Response;
    }

    if (url.includes("thumbnails/set")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response;
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const contentRange = headers["Content-Range"];

    if (!contentRange) {
      // The single-PUT shape — a short, or a render small enough not to chunk.
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: youtubeVideoId }),
      } as unknown as Response;
    }

    const [, rawStart, rawEnd, rawTotal] =
      /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange) ?? [];
    const start = Number(rawStart);
    const end = Number(rawEnd);
    const total = Number(rawTotal);

    if (opts.failAtOffset !== undefined && start >= opts.failAtOffset) {
      return {
        ok: false,
        status: 503,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response;
    }

    // Only the first chunk is under-confirmed. A fake that shortened every
    // chunk would never reach the last byte, which is a property of the fake
    // rather than anything worth asserting.
    const confirmedThrough = start === 0 ? end - (opts.shortConfirmBy ?? 0) : end;

    await opts.onChunk?.(start, end);

    if (confirmedThrough + 1 < total) {
      return {
        ok: false,
        status: 308,
        headers: new Headers({ range: `bytes=0-${confirmedThrough}` }),
        json: async () => ({}),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: youtubeVideoId }),
    } as unknown as Response;
  }) as FetchLike;

  return { fetchImpl, calls };
}

/** The same fixture publish.service.test.ts builds, trimmed to what these
 *  tests need: a READY video with a channel, a project and real render bytes on
 *  disk. `renderBytes` is what decides whether the upload chunks. */
async function makePublishableVideo(
  opts: { renderBytes?: number } = {},
): Promise<{ videoId: string; channelId: string; outputUrl: string }> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test-access-token",
    refreshToken: "1//test-refresh-token",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  const project = await projectService.create(userId, {
    name: `${PROJECT_NAME}-${randomUUID().slice(0, 8)}`,
    channelId: channel.id,
  });

  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "How inflation actually works",
    topic: "inflation",
  });

  const outputUrl = await writeRenderFile(
    video.id,
    // A byte pattern rather than zeroes so a chunk that arrives at the wrong
    // offset would be visible if anything ever asserted on the body.
    Buffer.alloc(opts.renderBytes ?? 32, 0x2a),
  );
  renderVideoIds.push(video.id);

  await prisma.renderJob.create({
    data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl },
  });

  await prisma.video.update({ where: { id: video.id }, data: { status: "READY" } });

  return { videoId: video.id, channelId: channel.id, outputUrl };
}

/**
 * The state a SIGKILL leaves behind, built directly because it cannot be
 * produced any other way: the process died between `create()` and the `catch`
 * that would have written FAILED, so the row says UPLOADING forever and the
 * video is still READY — it was never marked failed by anybody.
 *
 * `leaseExpiresAt: null` is what a row written before leases existed looks
 * like, and also what one looks like after ten minutes with nothing renewing
 * it. Both are "no process is holding this".
 */
async function makeAbandonedPublication(
  videoId: string,
  channelId: string,
  overrides: {
    leaseExpiresAt?: Date | null;
    uploadedBytes?: number;
    totalBytes?: number | null;
  } = {},
): Promise<string> {
  const publication = await prisma.publication.create({
    data: {
      videoId,
      channelId,
      title: "How inflation actually works",
      description: "",
      tags: [],
      visibility: "PRIVATE",
      status: "UPLOADING",
      uploadedBytes: overrides.uploadedBytes ?? 0,
      totalBytes: overrides.totalBytes ?? null,
      uploadStartedAt: new Date(Date.now() - 7_200_000),
      leaseExpiresAt:
        overrides.leaseExpiresAt === undefined ? null : overrides.leaseExpiresAt,
    },
    select: { id: true },
  });

  return publication.id;
}

describe("publishService — progress an operator can actually read", () => {
  it("sends a large render in chunks and records the bytes YouTube confirms", async () => {
    // Just over one 8 MiB chunk, so the upload takes the chunked path and the
    // final chunk is a short one — the case the protocol treats specially.
    const total = 9 * 1024 * 1024;
    const { videoId } = await makePublishableVideo({ renderBytes: total });

    const { fetchImpl, calls } = createChunkedFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId);

    expect(result.youtubeVideoId).toMatch(/^yt_/);

    const puts = calls.filter(
      (call) => (call.init?.headers as Record<string, string>)?.["Content-Range"],
    );
    expect(puts).toHaveLength(2);
    expect(
      (puts[0].init?.headers as Record<string, string>)["Content-Range"],
    ).toBe(`bytes 0-${8 * 1024 * 1024 - 1}/${total}`);
    expect(
      (puts[1].init?.headers as Record<string, string>)["Content-Range"],
    ).toBe(`bytes ${8 * 1024 * 1024}-${total - 1}/${total}`);

    const publication = await prisma.publication.findFirstOrThrow({
      where: { videoId },
    });
    expect(publication.totalBytes).toBe(total);
    expect(publication.uploadedBytes).toBe(total);
    // The lease is dropped the moment the upload is over: a PUBLISHED row that
    // still looked leased would be claiming a process is running.
    expect(publication.leaseExpiresAt).toBeNull();
    expect(publication.uploadStartedAt).not.toBeNull();
  });

  it("writes progress to the database mid-upload, so a reload shows the same bar", async () => {
    const total = 9 * 1024 * 1024;
    const firstChunkEnd = 8 * 1024 * 1024 - 1;
    const { videoId } = await makePublishableVideo({ renderBytes: total });
    const service = new PublishService(
      createChunkedFetch({
        // Observed from inside the second chunk's request — i.e. while the
        // upload is genuinely still running, which is the only moment that
        // proves the progress is server state rather than a component's.
        onChunk: async (start) => {
          if (start === 0) return;

          const live = await service.getPublishProgress(userId, videoId);

          expect(live).not.toBeNull();
          expect(live?.status).toBe("UPLOADING");
          expect(live?.uploadedBytes).toBe(firstChunkEnd + 1);
          expect(live?.totalBytes).toBe(total);
          expect(live?.percent).toBeCloseTo((8 / 9) * 100, 1);
          // Alive, because something renewed the lease — not because bytes
          // moved. The distinction is the entire safety argument.
          expect(live?.isLive).toBe(true);
          expect(live?.isStalled).toBe(false);
          // And therefore not clearable: an upload in flight must never have
          // its claim taken away underneath it.
          expect(live?.canClear).toBe(false);
        },
      }).fetchImpl,
    );

    await service.publish(userId, videoId);
  });

  it("advances on YouTube's accounting, not on what was sent", async () => {
    // YouTube confirms one byte fewer than the chunk carried. The next chunk
    // has to start from what it kept, not from where this process thought it
    // had got to.
    const total = 9 * 1024 * 1024;
    const { videoId } = await makePublishableVideo({ renderBytes: total });

    const { fetchImpl, calls } = createChunkedFetch({ shortConfirmBy: 1 });
    await new PublishService(fetchImpl).publish(userId, videoId);

    const ranges = calls
      .map((call) => (call.init?.headers as Record<string, string>)?.["Content-Range"])
      .filter(Boolean);

    expect(ranges[1]).toBe(`bytes ${8 * 1024 * 1024 - 1}-${total - 1}/${total}`);
  });

  it("leaves a small render on the single-PUT path it has always used", async () => {
    const { videoId } = await makePublishableVideo({ renderBytes: 64 });

    const { fetchImpl, calls } = createChunkedFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const put = calls.find((call) => call.init?.method === "PUT");
    expect(put).toBeDefined();
    expect((put?.init?.headers as Record<string, string>)["Content-Range"]).toBeUndefined();

    const publication = await prisma.publication.findFirstOrThrow({ where: { videoId } });
    expect(publication.uploadedBytes).toBe(64);
    expect(publication.totalBytes).toBe(64);
  });

  it("records why an upload that fails partway stopped, and how far it got", async () => {
    const total = 9 * 1024 * 1024;
    const { videoId } = await makePublishableVideo({ renderBytes: total });

    const { fetchImpl } = createChunkedFetch({ failAtOffset: 8 * 1024 * 1024 });
    await expect(
      new PublishService(fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(/YouTube upload failed \(503\)/);

    const publication = await prisma.publication.findFirstOrThrow({ where: { videoId } });
    expect(publication.status).toBe("FAILED");
    expect(publication.error).toMatch(/503/);
    // The first chunk really did land, and the row says so — "it stopped at
    // 89%" and "it never sent a byte" are different situations, and only one of
    // them can have left anything on the channel.
    expect(publication.uploadedBytes).toBe(8 * 1024 * 1024);
    expect(publication.totalBytes).toBe(total);
    // A failed attempt is not running, so it must not look leased — otherwise
    // the row the operator most needs to act on refuses to be cleared for
    // another ten minutes.
    expect(publication.leaseExpiresAt).toBeNull();

    const progress = await new PublishService(fetchImpl).getPublishProgress(
      userId,
      videoId,
    );
    expect(progress?.isLive).toBe(false);
    expect(progress?.error).toMatch(/503/);
    expect(progress?.canClear).toBe(true);
  });
});

describe("publishService — telling a dead upload from a slow one", () => {
  it("treats an upload whose lease is still live as running, however little it has sent", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    // Two hours in, 4% sent — the exact shape of the incident, except that the
    // process is still there and heartbeating.
    await makeAbandonedPublication(videoId, channelId, {
      leaseExpiresAt: new Date(Date.now() + PUBLISH_LEASE_SECONDS * 1000),
      uploadedBytes: 20 * 1024 * 1024,
      totalBytes: 463 * 1024 * 1024,
    });

    const service = new PublishService(createChunkedFetch().fetchImpl);
    const progress = await service.getPublishProgress(userId, videoId);

    expect(progress?.isLive).toBe(true);
    expect(progress?.isStalled).toBe(false);
    expect(progress?.canClear).toBe(false);
    expect(progress?.silentForSeconds).toBeNull();
    // Two hours of evidence is plenty for an estimate, and it is drawn from the
    // rate actually observed rather than from any assumed bandwidth.
    expect(progress?.bytesPerSecond).toBeGreaterThan(0);
    expect(progress?.remainingSeconds).toBeGreaterThan(0);

    // And the recovery path refuses it outright. This is the refusal that makes
    // the heartbeat load-bearing: clearing here would free the unique
    // constraint while bytes were still going out.
    await expect(service.clearStuckPublication(userId, videoId)).rejects.toThrow(
      ConflictError,
    );
    await expect(service.clearStuckPublication(userId, videoId)).rejects.toThrow(
      /running right now/,
    );
    expect(await prisma.publication.count({ where: { videoId } })).toBe(1);
  });

  it("treats an upload whose process is gone as stalled once the lease lapses", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId, {
      leaseExpiresAt: new Date(Date.now() - 60_000),
      uploadedBytes: 20 * 1024 * 1024,
      totalBytes: 463 * 1024 * 1024,
    });

    const progress = await new PublishService(
      createChunkedFetch().fetchImpl,
    ).getPublishProgress(userId, videoId);

    expect(progress?.isStalled).toBe(true);
    expect(progress?.isLive).toBe(false);
    expect(progress?.canClear).toBe(true);
    // A minute past a ten-minute lease means the last heartbeat was eleven
    // minutes ago. Saying so beats repeating the operator's own "it's stuck".
    expect(progress?.silentForSeconds).toBeGreaterThanOrEqual(
      PUBLISH_LEASE_SECONDS + 55,
    );
  });

  it("reads the operator's actual stuck row — no lease at all — as stalled", async () => {
    // The row that started this: written before leases existed, so its
    // `leaseExpiresAt` is null. It must not read as alive.
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId);

    const progress = await new PublishService(
      createChunkedFetch().fetchImpl,
    ).getPublishProgress(userId, videoId);

    expect(progress?.isStalled).toBe(true);
    expect(progress?.canClear).toBe(true);
  });
});

describe("publishService.clearStuckPublication", () => {
  it("makes an abandoned publish recoverable — and the video publishes on the next try", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId, {
      uploadedBytes: 20 * 1024 * 1024,
      totalBytes: 463 * 1024 * 1024,
    });

    // Before the fix: permanently unpublishable. The video is READY (nothing
    // ever marked it otherwise), so it looks fine, and every attempt dies on
    // the unique constraint.
    const blocked = createChunkedFetch();
    await expect(
      new PublishService(blocked.fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(ConflictError);
    expect(blocked.calls).toHaveLength(0);

    const service = new PublishService(createChunkedFetch().fetchImpl);
    const cleared = await service.clearStuckPublication(userId, videoId);

    expect(cleared.clearedStatus).toBe("UPLOADING");
    // The video was never marked FAILED — a SIGKILL runs no `catch` — so there
    // is nothing to restore.
    expect(cleared.videoRestoredToReady).toBe(false);
    expect(await prisma.publication.count({ where: { videoId } })).toBe(0);

    // The clear is recorded where the operator reads about their video, and in
    // the account-wide trail.
    const events = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(
      events.some((event) =>
        /Cleared a stuck publish attempt \(uploading\)/i.test(event.message ?? ""),
      ),
    ).toBe(true);
    const logs = await prisma.activityLog.findMany({
      where: { userId, action: "publish.clearStuckPublication" },
    });
    expect(logs).toHaveLength(1);

    // And now the thing the operator could not do: publish it.
    const retry = new PublishService(createChunkedFetch().fetchImpl);
    const result = await retry.publish(userId, videoId);

    expect(result.youtubeVideoId).toMatch(/^yt_/);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");
  });

  it("puts a video its failed publish marked FAILED back to READY", async () => {
    const { videoId } = await makePublishableVideo({ renderBytes: 9 * 1024 * 1024 });

    await expect(
      new PublishService(
        createChunkedFetch({ failAtOffset: 0 }).fetchImpl,
      ).publish(userId, videoId),
    ).rejects.toThrow();

    expect(
      (await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status,
    ).toBe("FAILED");

    const service = new PublishService(createChunkedFetch().fetchImpl);
    const cleared = await service.clearStuckPublication(userId, videoId);

    expect(cleared.clearedStatus).toBe("FAILED");
    expect(cleared.videoRestoredToReady).toBe(true);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
    expect(video.failureReason).toBeNull();

    // Genuinely publishable again, all the way through to YouTube.
    const result = await new PublishService(createChunkedFetch().fetchImpl).publish(
      userId,
      videoId,
    );
    expect(result.youtubeVideoId).toMatch(/^yt_/);
  });

  it("leaves a FAILED video failed when there is no render left to publish", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId, {
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await prisma.video.update({ where: { id: videoId }, data: { status: "FAILED" } });
    // No successful render: a READY badge over this would send the operator to
    // a publish button that refuses. It needs re-rendering, not republishing.
    await prisma.renderJob.deleteMany({ where: { videoId } });

    const cleared = await new PublishService(
      createChunkedFetch().fetchImpl,
    ).clearStuckPublication(userId, videoId);

    expect(cleared.videoRestoredToReady).toBe(false);
    expect(
      (await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status,
    ).toBe("FAILED");
  });

  it("refuses to clear a publication whose video is already on YouTube", async () => {
    const { videoId } = await makePublishableVideo();
    const service = new PublishService(
      createChunkedFetch({ youtubeVideoId: "yt_live_one" }).fetchImpl,
    );
    await service.publish(userId, videoId);

    // The one refusal that must hold no matter what: this row is not a stuck
    // attempt, it is the receipt for a video sitting on a real channel.
    await expect(service.clearStuckPublication(userId, videoId)).rejects.toThrow(
      ConflictError,
    );
    await expect(service.clearStuckPublication(userId, videoId)).rejects.toThrow(
      /yt_live_one/,
    );

    expect(await prisma.publication.count({ where: { videoId } })).toBe(1);
    const progress = await service.getPublishProgress(userId, videoId);
    expect(progress?.canClear).toBe(false);
  });

  it("refuses a video with no publish attempt at all", async () => {
    const { videoId } = await makePublishableVideo();

    await expect(
      new PublishService(createChunkedFetch().fetchImpl).clearStuckPublication(
        userId,
        videoId,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("cannot be reached for another operator's video", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId);

    const strangerId = await createTestUser("publish-recovery-stranger");
    try {
      await expect(
        new PublishService(createChunkedFetch().fetchImpl).clearStuckPublication(
          strangerId,
          videoId,
        ),
      ).rejects.toThrow(/not found/i);
      expect(await prisma.publication.count({ where: { videoId } })).toBe(1);
    } finally {
      await deleteTestUser(strangerId);
    }
  });
});

describe("publishService — Gate 2 is unchanged by any of this", () => {
  it("still refuses a genuine duplicate after a successful publish", async () => {
    const { videoId } = await makePublishableVideo();
    const first = createChunkedFetch();
    await new PublishService(first.fetchImpl).publish(userId, videoId);

    // Both refusals in turn: the status check, and — with the status forced
    // back — the claim row itself, which is the guard that holds against a
    // hand-made request.
    const second = createChunkedFetch();
    await expect(
      new PublishService(second.fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(ConflictError);

    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });

    const third = createChunkedFetch();
    await expect(
      new PublishService(third.fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(/already being published/);
    expect(third.calls).toHaveLength(0);

    expect(await prisma.publication.count({ where: { videoId } })).toBe(1);
  });

  it("refuses a second publish while the first is still uploading", async () => {
    const { videoId, channelId } = await makePublishableVideo();
    await makeAbandonedPublication(videoId, channelId, {
      leaseExpiresAt: new Date(Date.now() + PUBLISH_LEASE_SECONDS * 1000),
    });

    const { fetchImpl, calls } = createChunkedFetch();
    await expect(
      new PublishService(fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(/already being published/);
    // The claim, not the network, is what stopped it.
    expect(calls).toHaveLength(0);
  });

  it("lets exactly one of two concurrent publishes reach YouTube", async () => {
    const { videoId } = await makePublishableVideo();
    const a = createChunkedFetch();
    const b = createChunkedFetch();

    const results = await Promise.allSettled([
      new PublishService(a.fetchImpl).publish(userId, videoId),
      new PublishService(b.fetchImpl).publish(userId, videoId),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    // The loser never touched the network — Postgres settled it at the claim.
    const uploads = [...a.calls, ...b.calls].filter((call) =>
      call.url.includes("uploadType=resumable"),
    );
    expect(uploads).toHaveLength(1);
    expect(await prisma.publication.count({ where: { videoId } })).toBe(1);
  });
});
