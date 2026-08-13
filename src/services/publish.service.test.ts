import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import type { VideoStatus } from "@/generated/prisma/enums";
import { deleteRenderFile, renderPath, statRenderFile, writeRenderFile } from "@/lib/render-storage";
import { prisma } from "@/lib/prisma";
import { getObject, putObject, removeObjects, storagePath } from "@/lib/storage";
import { DESCRIPTION_MAX } from "@/lib/youtube-limits";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import {
  buildDescription,
  extractSourcesSection,
  PublishService,
} from "@/services/publish.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Tests run against a real, shared Postgres database and the real storage root (see
// src/test/setup.ts and src/lib/storage.ts) that also holds the operator's
// real data. Every test in this file gets its own private, throwaway User
// (see src/test/fixtures.ts). YouTube itself is never called: `fetch` is
// injected into PublishService (per its constructor), matching the injection
// shape already used by RenderService's process spawner and
// FootageService's clip downloader.
const RUN = randomUUID().slice(0, 8);
const PROJECT_NAME = `test-publish-${RUN}`;

// Several tests make multiple live round trips to storage and the database
// (connect a channel, create a project/video/script, upload fake render
// bytes, then download them back inside publish()) — comfortably past
// Vitest's 5s default under network variance, same rationale as
// render.service.test.ts's own timeout bump.
vi.setConfig({ testTimeout: 15_000 });

const SCRIPT_WITH_SOURCES = [
  "Hook: money is weirder than you think.",
  "",
  "Body: here is the full explanation of the topic.",
  "",
  "SOURCES",
  "- https://example.com/federal-reserve-report",
  "- https://example.com/inflation-study",
].join("\n");

let userId: string;

/** Mirrors render.service.test.ts's own cleanup list — every video id this
 * file writes a render fixture for (see `writeRenderFile` in
 * `makePublishableVideo`), so the file doesn't outlive the test under
 * RENDER_ROOT. Keyed on video id (via `renderPath`), not a captured
 * outputUrl, same rationale as render.service.test.ts's own list. */
const publishedVideoIds: string[] = [];

/** Storage paths the "clip storage reclaim" tests below write directly to
 * the real bucket via `putObject`, tracked here (not just relying on
 * `publish()` to clean up after itself) so a failed assertion that stops the
 * test before `publish()` runs still doesn't leave a real object behind.
 * `Asset` carries no FK back to `User`, the same gap `footage.service.test.ts`
 * works around (see its own `afterEach` comment) — `deleteTestUser`'s cascade
 * can't reach these rows either. */
const clipStoragePaths: string[] = [];

beforeEach(async () => {
  userId = await createTestUser("publish");
});

afterEach(async () => {
  // Swept first, and ahead of `deleteTestUser` specifically: this is the one
  // cleanup step that touches the real, shared bucket rather than only this
  // test's own throwaway rows, so it must run even if something later in
  // this function throws. If `deleteTestUser` ran first and rejected, an
  // `await` sequence with the bucket sweep after it would never reach that
  // sweep at all, leaking a real object into the operator's storage.
  const paths = clipStoragePaths.splice(0);
  if (paths.length > 0) {
    await removeObjects(paths).catch(() => {});
    await prisma.asset.deleteMany({ where: { storagePath: { in: paths } } }).catch(() => {});
  }

  await deleteTestUser(userId);
  await Promise.all(
    publishedVideoIds.splice(0).map((id) => deleteRenderFile(renderPath(id)).catch(() => {})),
  );
});

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * A fake resumable-upload endpoint: the first call (uploadType=resumable)
 * returns a `Location` header, the second (the PUT to that location) returns
 * the created video's id. Either leg can be made to fail.
 */
function createUploadFetch(
  opts: {
    failInit?: boolean;
    failUpload?: boolean;
    youtubeVideoId?: string;
    /** Status code for a faked `thumbnails/set` failure — e.g. 403 for the
     *  unverified-channel case `applyThumbnail` exists to survive. Omitted
     *  entirely means the call succeeds. */
    failThumbnail?: number;
  } = {},
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const youtubeVideoId = opts.youtubeVideoId ?? `yt_${randomUUID().slice(0, 8)}`;

  const fetchImpl: FetchLike = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("uploadType=resumable")) {
      if (opts.failInit) {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ location: "https://upload.example.invalid/resumable/abc123" }),
        json: async () => ({}),
      } as unknown as Response;
    }

    // Matched before the PUT branch below, which is the current catch-all —
    // a thumbnails/set request is a POST, same as it would fall through to
    // otherwise, so this has to be checked first, not merely added last.
    if (url.includes("thumbnails/set")) {
      if (opts.failThumbnail) {
        return {
          ok: false,
          status: opts.failThumbnail,
          headers: new Headers(),
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
      } as unknown as Response;
    }

    // The PUT of the actual bytes to the resumable location.
    if (opts.failUpload) {
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
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

/**
 * Builds a video that is fully eligible to publish: a connected channel
 * assigned to its project, a READY status, and a RenderJob whose outputUrl
 * points at real bytes in the (test) storage bucket. Rows this stage doesn't
 * own (Channel, Script, RenderJob) are created directly rather than through
 * their owning services, same approach render.service.test.ts takes for its
 * upstream fixtures.
 */
async function makePublishableVideo(
  opts: {
    scriptContent?: string | null;
    status?: VideoStatus;
    /** `ScriptVersion.sources` — what a script generated through the
     *  structured-output schema stores instead of an inline SOURCES block. */
    scriptSources?: string[];
    /** Skips the `writeRenderFile` write and points `RenderJob.outputUrl` at
     *  a path nothing was ever written to.
     *
     *  Only for tests of a refusal that happens *before* `publish()` ever
     *  reads the render — the finalizing gate and the scheduling gate below.
     *  Both refuse while validating the video row, several steps ahead of the
     *  `getRenderFile` call, so writing ~26 bytes under RENDER_ROOT and
     *  deleting them again in `afterEach` would prove nothing about either
     *  one. A test that gets this wrong fails loudly (the publish reaches
     *  `getRenderFile` and errors on a path with nothing behind it) rather
     *  than passing for the wrong reason. */
    withoutRenderFile?: boolean;
  } = {},
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

  if (opts.scriptContent !== null) {
    const script = await prisma.script.create({ data: { videoId: video.id } });
    const version = await prisma.scriptVersion.create({
      data: {
        scriptId: script.id,
        version: 1,
        content: opts.scriptContent ?? SCRIPT_WITH_SOURCES,
        sources: opts.scriptSources,
      },
    });
    await prisma.script.update({
      where: { id: script.id },
      data: { activeVersionId: version.id },
    });
  }

  // The render itself lives under RENDER_ROOT, separate from STORAGE_ROOT — see
  // render-storage.ts. `outputUrl` is the same value `RenderService.render`
  // would have written to `RenderJob.outputUrl`.
  let outputUrl: string;
  if (opts.withoutRenderFile) {
    outputUrl = renderPath(video.id); // never written
  } else {
    outputUrl = await writeRenderFile(video.id, Buffer.from(`fake-rendered-mp4-${RUN}`));
    publishedVideoIds.push(video.id);
  }
  await prisma.renderJob.create({
    data: { videoId: video.id, status: "SUCCEEDED", progress: 100, outputUrl },
  });

  await prisma.video.update({
    where: { id: video.id },
    data: { status: opts.status ?? "READY" },
  });

  return { videoId: video.id, channelId: channel.id, outputUrl };
}

describe("publishService.publish — extractSourcesSection", () => {
  it("returns everything from the SOURCES heading to the end", () => {
    expect(extractSourcesSection(SCRIPT_WITH_SOURCES)).toBe(
      ["SOURCES", "- https://example.com/federal-reserve-report", "- https://example.com/inflation-study"].join(
        "\n",
      ),
    );
  });

  it("returns an empty string when there is no SOURCES heading", () => {
    expect(extractSourcesSection("Just a script with no citations.")).toBe("");
  });

  it("finds nothing in a generated script, which is one line with no breaks", () => {
    // Not a curiosity — this is the shape gateway.provider.ts now produces:
    // sections joined with a single space. The heading regex requires the word
    // alone on a line, so this path is dead for anything generated, which is
    // why the citations are stored in `ScriptVersion.sources` instead.
    expect(
      extractSourcesSection(
        "Inflation is not prices going up. SOURCES https://example.com/a",
      ),
    ).toBe("");
  });
});

describe("publishService.publish — buildDescription", () => {
  it("credits the music alongside the Pixabay credit", () => {
    const description = buildDescription(
      SCRIPT_WITH_SOURCES,
      null,
      'Music: "Test Track" by Artist (https://creativecommons.org/licenses/by/3.0/)',
    );

    expect(description).toContain("Pixabay");
    expect(description).toContain('Music: "Test Track" by Artist');
  });

  it("omits the music line when the video rendered without music", () => {
    const description = buildDescription(SCRIPT_WITH_SOURCES);

    expect(description).toContain("Pixabay");
    expect(description).not.toContain("Music:");
  });

  it("still credits Pixabay when the script has no sources", () => {
    expect(buildDescription("No citations here.")).toContain("Pixabay");
  });

  it("publishes the stored sources of a generated script, whose content has none", () => {
    // The interaction the two features created: `content` is a single line of
    // narration with no SOURCES heading in it at all, so citations survive
    // only because they are carried beside it.
    const description = buildDescription(
      "Inflation is not prices going up. It is money losing value.",
      ["Federal Reserve, H.6 release, 2024", "https://example.com/inflation-study"],
    );

    expect(description).toContain("SOURCES");
    expect(description).toContain("- Federal Reserve, H.6 release, 2024");
    expect(description).toContain("- https://example.com/inflation-study");
  });

  it("still lifts an older hand-written script's inline SOURCES block", () => {
    // The path that must keep working: a script with real line breaks and no
    // `sources` column, which is every script written before that column.
    const description = buildDescription(SCRIPT_WITH_SOURCES, null);

    expect(description).toContain("- https://example.com/federal-reserve-report");
  });

  it("prefers the stored sources over an inline block when both exist", () => {
    const description = buildDescription(SCRIPT_WITH_SOURCES, [
      "https://example.com/stored",
    ]);

    expect(description).toContain("- https://example.com/stored");
    expect(description).not.toContain("federal-reserve-report");
  });
});

describe("publishService.publish — Gate 2", () => {
  it("throws NotFoundError for a video that does not belong to the caller", async () => {
    const service = new PublishService(createUploadFetch().fetchImpl);
    await expect(service.publish(userId, randomUUID())).rejects.toThrow(NotFoundError);
  });

  const nonReadyStatuses: VideoStatus[] = [
    "DRAFT",
    "QUEUED",
    "GENERATING",
    "RENDERING",
    "PUBLISHED",
    "FAILED",
  ];

  it.each(nonReadyStatuses)("refuses to publish a video in %s", async (status) => {
    const { videoId } = await makePublishableVideo({ status });
    const service = new PublishService(createUploadFetch().fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow(ConflictError);

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(0);
  });

  it("refuses to publish a READY video with no successful RenderJob output", async () => {
    const { videoId } = await makePublishableVideo();
    // The video is READY, but its only RenderJob never produced an outputUrl —
    // e.g. render() flipped it to READY through a path this fixture doesn't
    // model. Simulate that directly.
    await prisma.renderJob.deleteMany({ where: { videoId } });

    const service = new PublishService(createUploadFetch().fetchImpl);
    await expect(service.publish(userId, videoId)).rejects.toThrow(ConflictError);
  });

  it("refuses to publish, with a clear typed error (not a raw fetch failure), when the render is on the DB but no longer on disk", async () => {
    const { videoId, outputUrl } = await makePublishableVideo();
    // A RenderJob row with an outputUrl exists, but the file it points at is
    // gone — deleted from disk, reclaimed, or a machine that no longer
    // exists. This is exactly the failure mode render-storage.ts's
    // RenderFileMissingError exists for.
    await deleteRenderFile(outputUrl);

    const service = new PublishService(createUploadFetch().fetchImpl);
    // One in-flight call, checked twice — not two calls. A second real call
    // would hit the unique-constraint retry guard (see the "second publish
    // attempt" test below) instead of exercising the missing-file path again.
    const publishAttempt = service.publish(userId, videoId);
    await expect(publishAttempt).rejects.toThrow(ConflictError);
    await expect(publishAttempt).rejects.toThrow(/no longer available/);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.failureReason).toContain("no longer available");
  });

  // Visibility-default and "asked-for visibility wins" coverage moved to the
  // "metadata and visibility" describe block below, once uploadToYouTube
  // stopped hard-coding "unlisted" regardless of caller input. What's left
  // worth asserting here, on its own, is the one flag that genuinely never
  // varies by caller input.
  it("declares every upload not made for kids", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl, calls } = createUploadFetch();
    const service = new PublishService(fetchImpl);

    await service.publish(userId, videoId);

    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
    expect(initCall).toBeDefined();
    const body = JSON.parse(initCall!.init!.body as string);
    expect(body.status.selfDeclaredMadeForKids).toBe(false);
  });

  it("carries the script's SOURCES section and a Pixabay credit in the description", async () => {
    const { videoId } = await makePublishableVideo();
    const service = new PublishService(createUploadFetch().fetchImpl);

    await service.publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toContain("SOURCES");
    expect(publication.description).toContain("https://example.com/federal-reserve-report");
    expect(publication.description).toContain("Pixabay");
  });

  it("carries a generated script's stored sources into the description and the upload", async () => {
    // The end-to-end shape of a script generated since sections landed:
    // `content` is one line of narration with no heading to extract, and the
    // citations live in `ScriptVersion.sources`. Without that column being
    // read here, every generated video would publish uncited.
    const { videoId } = await makePublishableVideo({
      scriptContent: "Inflation is not prices going up. It is money losing value.",
      scriptSources: ["https://example.com/h6-release", "SEC filing, 2001"],
    });
    const { fetchImpl, calls } = createUploadFetch();
    const service = new PublishService(fetchImpl);

    await service.publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toContain("SOURCES");
    expect(publication.description).toContain("- https://example.com/h6-release");
    expect(publication.description).toContain("- SEC filing, 2001");

    // And the same text is what YouTube was actually sent, not just what was
    // recorded locally.
    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
    const body = JSON.parse(initCall!.init!.body as string);
    expect(body.snippet.description).toContain("- https://example.com/h6-release");
  });

  it("still credits Pixabay even when the script has no SOURCES section", async () => {
    const { videoId } = await makePublishableVideo({ scriptContent: "No citations here." });
    const service = new PublishService(createUploadFetch().fetchImpl);

    await service.publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toContain("Pixabay");
  });

  it("moves the video READY → PUBLISHED and records the youtubeVideoId", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ youtubeVideoId: "yt_abc123" });
    const service = new PublishService(fetchImpl);

    const result = await service.publish(userId, videoId);
    expect(result.youtubeVideoId).toBe("yt_abc123");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.youtubeVideoId).toBe("yt_abc123");
    expect(publication.status).toBe("PUBLISHED");
    // No visibility was requested, so this is the new safe default — see the
    // "metadata and visibility" describe block for the dedicated coverage.
    expect(publication.visibility).toBe("PRIVATE");

    const events = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("READY->PUBLISHED");
  });

  it("deletes the local render once YouTube has the video", async () => {
    const service = new PublishService(createUploadFetch().fetchImpl);
    const { videoId, outputUrl } = await makePublishableVideo({});

    await service.publish(userId, videoId, {});

    expect(await statRenderFile(outputUrl)).toBeNull();
  });

  it("keeps the render when the publish failed", async () => {
    const service = new PublishService(createUploadFetch({ failUpload: true }).fetchImpl);
    const { videoId, outputUrl } = await makePublishableVideo({});

    await expect(service.publish(userId, videoId, {})).rejects.toThrow();

    // A failed publish must leave the render in place, or a retry has nothing
    // to upload and the video is unrecoverable.
    expect(await statRenderFile(outputUrl)).not.toBeNull();
  });

  it("a failed upload sets the video and its Publication FAILED — the claim row is kept, not deleted", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ failUpload: true });
    const service = new PublishService(fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");
    expect(video.failureReason).toBeTruthy();

    // The claim Publication created before the upload attempt is updated to
    // FAILED, not deleted — deleting it would let a retry storm re-upload
    // immediately (see PublishService's class doc comment on retries).
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("FAILED");
    expect(publication.error).toBeTruthy();
    expect(publication.youtubeVideoId).toBeNull();

    const events = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(events.map((e) => `${e.from}->${e.to}`)).toContain("READY->FAILED");
  });

  it("a failed upload init also sets the video and Publication FAILED", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl } = createUploadFetch({ failInit: true });
    const service = new PublishService(fetchImpl);

    await expect(service.publish(userId, videoId)).rejects.toThrow();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("FAILED");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("FAILED");
  });

  it("a second publish attempt after a failure is refused — retrying requires clearing the failed row first", async () => {
    const { videoId } = await makePublishableVideo();
    const { fetchImpl: failingFetch } = createUploadFetch({ failUpload: true });
    await expect(new PublishService(failingFetch).publish(userId, videoId)).rejects.toThrow();

    // The video is now FAILED (not READY), so this is refused on the status
    // check alone — but even if an operator manually flipped the video back
    // to READY, the surviving FAILED Publication row's unique videoId
    // constraint would still refuse a second create(). Exercise the more
    // interesting case directly: force the video back to READY and confirm
    // the stale Publication row is what blocks the retry.
    await prisma.video.update({ where: { id: videoId }, data: { status: "READY" } });

    const { fetchImpl: secondAttemptFetch, calls } = createUploadFetch();
    await expect(
      new PublishService(secondAttemptFetch).publish(userId, videoId),
    ).rejects.toThrow(ConflictError);
    expect(calls).toHaveLength(0); // never reached the network

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(1); // still just the original FAILED row
  });
});

/**
 * The window between `render.service.ts` committing READY and
 * `runPipeline` (pipeline-runner.ts) finishing the `metadata` and `thumbnail`
 * stages that come after it. `Video.leaseExpiresAt` is the signal — the same
 * one `PipelineState.isFinalizing` is defined on — so setting it directly is
 * exactly what a worker mid-`runPipeline` looks like to this service.
 */
async function setLease(videoId: string, expiresAt: Date | null): Promise<void> {
  await prisma.video.update({
    where: { id: videoId },
    data: { leaseExpiresAt: expiresAt },
  });
}

describe("publishService.publish — the finalizing window", () => {
  it("refuses a READY video whose lease is still live, and says why", async () => {
    const { videoId } = await makePublishableVideo({ withoutRenderFile: true });
    // A worker that has just committed READY and is now generating the title,
    // tags and thumbnail. It renews this lease for the whole of runPipeline.
    await setLease(videoId, new Date(Date.now() + 60_000));

    const { fetchImpl, calls } = createUploadFetch();
    const attempt = new PublishService(fetchImpl).publish(userId, videoId);

    await expect(attempt).rejects.toThrow(ConflictError);
    // The operator's next step has to be in the message: "wait" is
    // actionable, "conflict" is not, and there is no other channel telling
    // them the video is still being finished off.
    await expect(attempt).rejects.toThrow(/Wait a moment/);

    // Refused before the network and before the claim, so nothing about the
    // video changed and publishing after the wait is still possible — a
    // Publication row here would block every future attempt permanently (see
    // PublishService's own doc comment on retries).
    expect(calls).toHaveLength(0);
    expect(await prisma.publication.count({ where: { videoId } })).toBe(0);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("READY");
  });

  it("refuses even though the video is READY and has everything else it needs", async () => {
    // The whole point of the gate: READY, a channel, a render, a script — the
    // video passes every other check in publish(), and would upload with the
    // operator's placeholder title, no tags and no thumbnail if this one
    // didn't exist.
    const { videoId } = await makePublishableVideo({ withoutRenderFile: true });
    await setLease(videoId, new Date(Date.now() + 60_000));

    const before = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(before.status).toBe("READY");
    expect(before.generatedTitle).toBeNull();
    expect(before.tags).toEqual([]);

    await expect(
      new PublishService(createUploadFetch().fetchImpl).publish(userId, videoId),
    ).rejects.toThrow(/still being finished off/);
  });

  it("allows a READY video whose lease has already lapsed", async () => {
    const { videoId } = await makePublishableVideo({ withoutRenderFile: true });
    // A lapsed lease means runPipeline has already had its single automatic
    // chance at metadata and thumbnail — waiting longer would achieve nothing,
    // so this must not be refused. Reaching getRenderFile is what proves the
    // gate let it through; the path points at nothing on disk, so it fails
    // *there*.
    await setLease(videoId, new Date(Date.now() - 60_000));

    await expect(
      new PublishService(createUploadFetch().fetchImpl).publish(userId, videoId),
    ).rejects.not.toThrow(/still being finished off/);
  });
});

describe("publishService.publish — concurrency", () => {
  it("Gate 2: two concurrent publishes produce exactly one Publication, one VideoStatusEvent, and exactly one real upload", async () => {
    const { videoId } = await makePublishableVideo();

    // One shared fetch client (and one shared `calls` array) across both
    // concurrent PublishService instances. The claim (Publication.create,
    // guarded by the unique videoId constraint) happens before either
    // instance ever calls this — so if the claim is doing its job, the loser
    // must be rejected without ever invoking it, and `calls` must show
    // exactly the one init+PUT pair the winner made. Asserting the call
    // count is what actually proves no double upload happened; asserting
    // just the DB row counts (as an earlier version of this test did) cannot
    // tell a "claimed before upload" gate apart from a "claimed after
    // upload" one — both leave exactly one Publication behind.
    const { fetchImpl, calls } = createUploadFetch();

    const results = await Promise.allSettled([
      new PublishService(fetchImpl).publish(userId, videoId),
      new PublishService(fetchImpl).publish(userId, videoId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);

    // Exactly one upload sequence: the resumable-init POST and the bytes PUT.
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("uploadType=resumable"))).toHaveLength(1);

    const publications = await prisma.publication.count({ where: { videoId } });
    expect(publications).toBe(1);

    const events = await prisma.videoStatusEvent.count({
      where: { videoId, to: "PUBLISHED" },
    });
    expect(events).toBe(1);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");
  });
});

/**
 * Writes one real clip: a bucket object plus its matching `Asset` row, in
 * the exact shape `footage.service.ts`'s `collectPerCue` produces for a
 * script with b-roll cues. Pushes the path onto `clipStoragePaths`
 * immediately after the `putObject` that actually created it succeeds —
 * *before* the `asset.create` that follows — so a failure in the DB write
 * still leaves the object tracked for `afterEach` to sweep. A `Promise.all`
 * over several of these calls would push nothing until every call settles,
 * which is exactly what let a first clip's real object go untracked if a
 * later one's `putObject` rejected.
 */
async function createClipAsset(
  videoId: string,
  index: number,
): Promise<string> {
  const path = storagePath(videoId, "clips", `section-${String(index).padStart(3, "0")}.mp4`);
  await putObject(path, Buffer.from(`fake-clip-${RUN}-${index}`), "video/mp4");
  clipStoragePaths.push(path);
  await prisma.asset.create({
    data: {
      kind: "VIDEO",
      storagePath: path,
      mimeType: "video/mp4",
      sizeBytes: BigInt(16),
      provider: "PEXELS",
      externalId: `clip-${RUN}-${index}`,
    },
  });
  return path;
}

describe("publishService.publish — clip storage reclaim", () => {
  it("deletes the video's stock clips once it is published", async () => {
    const { videoId } = await makePublishableVideo();

    // Sequential, not Promise.all: see createClipAsset's own doc comment —
    // each path is tracked for cleanup the moment its object exists, not
    // only once every clip in the batch has finished.
    const path0 = await createClipAsset(videoId, 0);
    const path1 = await createClipAsset(videoId, 1);

    // Never the default (real `fetch`) PublishService — every publish in
    // this file goes through the injected fake, so this never risks a real
    // call to YouTube.
    const service = new PublishService(createUploadFetch().fetchImpl);
    await service.publish(userId, videoId);

    // Source clips have done their job; ~400MB per video would make storage
    // the binding constraint at around 200 videos.
    const clips = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/clips/` },
      },
    });
    expect(clips).toHaveLength(0);

    // Not just soft-deleted in Postgres — the underlying bucket objects are
    // gone too, which is the actual storage this test exists to reclaim.
    await expect(getObject(path0)).rejects.toThrow();
    await expect(getObject(path1)).rejects.toThrow();
  });

  it("keeps clips when publishing fails, since a FAILED video may still be retried", async () => {
    const { videoId } = await makePublishableVideo();

    const path = await createClipAsset(videoId, 0);

    const service = new PublishService(createUploadFetch({ failUpload: true }).fetchImpl);
    await expect(service.publish(userId, videoId)).rejects.toThrow();

    const clips = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/clips/` },
      },
    });
    expect(clips).toHaveLength(1);

    // Asymmetric on purpose: this test's whole point is that a *failed*
    // publish must leave the clip alone completely — not just the Asset
    // row (see the "deletes the video's stock clips" test above for the
    // successful-publish, both-are-gone half of this behaviour). An
    // implementation that deleted the bucket object unconditionally, before
    // ever checking whether the publish itself succeeded, would still pass
    // the row-only assertion above; this is what actually catches that.
    await expect(getObject(path)).resolves.toBeInstanceOf(Buffer);
  });

  it("never touches sibling assets outside clips/ — narration, captions or music", async () => {
    const { videoId } = await makePublishableVideo();

    await createClipAsset(videoId, 0);

    // One sibling per kind that shares the video's `videos/{videoId}/`
    // prefix but lives outside `clips/` — exactly what a reclaim query
    // widened to the video-wide prefix, or one that dropped its `kind:
    // "VIDEO"` filter, would start deleting. Every one of these tests
    // create only clip assets, so a regression that broadened the scope
    // would still pass them all; this is the test the global "never delete
    // or modify rows you did not create" constraint is really about, since
    // narration and alignment cost a paid ElevenLabs call to regenerate and
    // a render's exact music track can't be regenerated to match at all.
    const narrationPath = storagePath(videoId, "audio", "narration.mp3");
    const captionsPath = storagePath(videoId, "captions", "alignment.json");
    const musicPath = storagePath(videoId, "music", "track.mp3");

    await putObject(narrationPath, Buffer.from(`fake-narration-${RUN}`), "audio/mpeg");
    clipStoragePaths.push(narrationPath);
    await putObject(captionsPath, Buffer.from(`fake-captions-${RUN}`), "application/json");
    clipStoragePaths.push(captionsPath);
    await putObject(musicPath, Buffer.from(`fake-music-${RUN}`), "audio/mpeg");
    clipStoragePaths.push(musicPath);

    const narrationAsset = await prisma.asset.create({
      data: { kind: "AUDIO", storagePath: narrationPath, mimeType: "audio/mpeg", provider: "ELEVENLABS" },
    });
    const captionsAsset = await prisma.asset.create({
      data: { kind: "SUBTITLE", storagePath: captionsPath, mimeType: "application/json", provider: "ELEVENLABS" },
    });
    const musicAsset = await prisma.asset.create({
      data: {
        kind: "MUSIC",
        storagePath: musicPath,
        mimeType: "audio/mpeg",
        provider: "PIXABAY",
        prompt: 'Music: "Test Track" by Artist (https://creativecommons.org/licenses/by/3.0/)',
      },
    });

    const service = new PublishService(createUploadFetch().fetchImpl);
    await service.publish(userId, videoId);

    // The sibling rows are untouched — not deleted, not soft-deleted.
    const survivors = await prisma.asset.findMany({
      where: { id: { in: [narrationAsset.id, captionsAsset.id, musicAsset.id] } },
    });
    expect(survivors).toHaveLength(3);
    for (const asset of survivors) {
      expect(asset.deletedAt).toBeNull();
    }

    // Not just the rows — the actual bucket objects too.
    await expect(getObject(narrationPath)).resolves.toBeInstanceOf(Buffer);
    await expect(getObject(captionsPath)).resolves.toBeInstanceOf(Buffer);
    await expect(getObject(musicPath)).resolves.toBeInstanceOf(Buffer);

    // And the clip itself was still reclaimed — this isn't just testing
    // that reclaim silently does nothing.
    const clips = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/clips/` },
      },
    });
    expect(clips).toHaveLength(0);
  });
});

/**
 * Attaches an active thumbnail to a video, writing a real object to the bucket
 * so `publish()` has something to download and send.
 *
 * Defaults to a JPEG, which is what `ThumbnailService`'s composited path
 * always produces. A test exercising the PNG fallback path (composite
 * failed — see `detectImageFormat` in thumbnail.service.ts) can pass
 * `format: "png"` to write a `.png` object with an `image/png` content-type
 * instead, so `applyThumbnail`'s `objectContentType` read-back is actually
 * exercised against both shapes, not just the common one.
 */
async function giveVideoAThumbnail(
  videoId: string,
  format: "jpg" | "png" = "jpg",
): Promise<string> {
  const contentType = format === "png" ? "image/png" : "image/jpeg";
  const objectPath = storagePath(videoId, "thumbnails", `thumbnail-001.${format}`);
  await putObject(objectPath, Buffer.from(`thumb-${RUN}`), contentType);
  clipStoragePaths.push(objectPath);

  const thumbnail = await prisma.thumbnail.create({ data: { videoId } });
  const version = await prisma.thumbnailVersion.create({
    data: {
      thumbnailId: thumbnail.id,
      version: 1,
      imageUrl: objectPath,
      prompt: "a city at night",
    },
  });
  await prisma.thumbnail.update({
    where: { id: thumbnail.id },
    data: { activeVersionId: version.id },
  });

  return objectPath;
}

describe("publishService.publish — thumbnail", () => {
  it("uploads the thumbnail after the video insert, not with it", async () => {
    const { videoId } = await makePublishableVideo();
    await giveVideoAThumbnail(videoId);

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    // thumbnails.set is a separate endpoint — it cannot ride along with
    // videos.insert — so it must come after the video exists to attach to.
    const thumbnailCall = calls.findIndex((call) => call.url.includes("thumbnails/set"));
    const insertCall = calls.findIndex((call) => call.url.includes("uploadType=resumable"));

    expect(thumbnailCall).toBeGreaterThan(-1);
    expect(thumbnailCall).toBeGreaterThan(insertCall);
    expect(calls[thumbnailCall].url).toContain("videoId=");

    // Publication.thumbnailApplied is the entire point of this task — a
    // console.error the operator never sees is not a report. A successful
    // attach must record `true`, not just silently succeed at the network
    // call.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.thumbnailApplied).toBe(true);
  });

  it("sends the stored content-type, not a hard-coded assumption", async () => {
    const { videoId } = await makePublishableVideo();
    await giveVideoAThumbnail(videoId, "jpg");

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const thumbnailCall = calls.find((call) => call.url.includes("thumbnails/set"));
    const headers = new Headers(thumbnailCall!.init!.headers);
    expect(headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("sends image/png for the composite-failure fallback's PNG bytes", async () => {
    // The path `detectImageFormat` in thumbnail.service.ts exists for:
    // FFmpeg compositing failed, so the raw image-provider bytes were stored
    // as-is, which may be PNG rather than the usual composited JPEG. Sending
    // a hard-coded `image/jpeg` here would misdeclare the body's actual type.
    const { videoId } = await makePublishableVideo();
    await giveVideoAThumbnail(videoId, "png");

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const thumbnailCall = calls.find((call) => call.url.includes("thumbnails/set"));
    const headers = new Headers(thumbnailCall!.init!.headers);
    expect(headers.get("Content-Type")).toBe("image/png");
  });

  it("leaves the video published when the channel is unverified (403)", async () => {
    const { videoId } = await makePublishableVideo();
    await giveVideoAThumbnail(videoId);

    const { fetchImpl } = createUploadFetch({ failThumbnail: 403 });

    // Custom thumbnails require a verified YouTube channel — a property of the
    // operator's account, not something this code can satisfy. Failing an
    // upload that already succeeded, over a thumbnail, is the wrong trade.
    await expect(new PublishService(fetchImpl).publish(userId, videoId)).resolves
      .toMatchObject({ youtubeVideoId: expect.any(String) });

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("PUBLISHED");
    // The attach genuinely failed — this must read false, not just default
    // to it by the write never having fired at all.
    expect(publication.thumbnailApplied).toBe(false);
  });

  it("survives any other thumbnail failure just as completely", async () => {
    const { videoId } = await makePublishableVideo();
    await giveVideoAThumbnail(videoId);

    const { fetchImpl } = createUploadFetch({ failThumbnail: 500 });

    await expect(new PublishService(fetchImpl).publish(userId, videoId)).resolves
      .toMatchObject({ youtubeVideoId: expect.any(String) });

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.thumbnailApplied).toBe(false);
  });

  it("skips the thumbnail call entirely when the video has none", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    // 50 quota units, against the same daily allowance as the 1,600 the upload
    // itself costs — not free, and not worth spending on nothing.
    expect(calls.some((call) => call.url.includes("thumbnails/set"))).toBe(false);

    // No thumbnail existed to attach, so this must read false, not the
    // "attached" default a missing write would be indistinguishable from.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.thumbnailApplied).toBe(false);
  });
});

describe("publishService.publish — metadata and visibility", () => {
  it("sends the generated title and tags, not the operator's placeholder", async () => {
    const { videoId } = await makePublishableVideo();
    await prisma.video.update({
      where: { id: videoId },
      data: {
        generatedTitle: "How inflation actually works",
        generatedDescription: "The full explanation.",
        tags: ["money", "inflation"],
      },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe("How inflation actually works");
    expect(body.snippet.tags).toEqual(["money", "inflation"]);
  });

  it("falls back to the operator's title when nothing was generated", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe("How inflation actually works");
  });

  it("publishes at the visibility asked for, not a constant", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, { visibility: "PUBLIC" });

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status.privacyStatus).toBe("public");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.visibility).toBe("PUBLIC");
  });

  it("defaults to private rather than to whatever it used to hard-code", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status.privacyStatus).toBe("private");
  });

  it("schedules with publishAt and a private status, which is how YouTube schedules", async () => {
    const { videoId } = await makePublishableVideo();
    const scheduledFor = new Date("2030-01-01T12:00:00.000Z");

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      scheduledFor,
    });

    const body = JSON.parse(calls[0].init!.body as string);
    // A scheduled upload must go up private; publishAt is what flips it later.
    expect(body.status.privacyStatus).toBe("private");
    expect(body.status.publishAt).toBe(scheduledFor.toISOString());
  });

  it.each(["UNLISTED", "PRIVATE"] as const)(
    "refuses to schedule a %s publish, which YouTube would make public anyway",
    async (visibility) => {
      const { videoId } = await makePublishableVideo({ withoutRenderFile: true });

      const { fetchImpl, calls } = createUploadFetch();
      const attempt = new PublishService(fetchImpl).publish(userId, videoId, {
        visibility,
        scheduledFor: new Date("2030-01-01T12:00:00.000Z"),
      });

      // status.publishAt is only valid with privacyStatus: private, and what
      // it does at the timestamp is make the video *public*. There is no way
      // to schedule a video to become unlisted, so accepting this and
      // uploading it would publish something publicly that the caller
      // explicitly asked to keep off search — with Publication.visibility
      // still recording UNLISTED, so nothing downstream would ever say so.
      await expect(attempt).rejects.toThrow(ConflictError);
      await expect(attempt).rejects.toThrow(/always goes live as public/);

      expect(calls).toHaveLength(0);
      expect(await prisma.publication.count({ where: { videoId } })).toBe(0);
    },
  );

  it("refuses to schedule when no visibility is given, rather than using the PRIVATE default", async () => {
    // The default exists so an unspecified *immediate* publish leaks nothing.
    // Silently applying it to a scheduled publish would mean "schedule this"
    // alone resolved to a combination YouTube cannot honour, so the caller has
    // to say PUBLIC out loud.
    const { videoId } = await makePublishableVideo({ withoutRenderFile: true });

    await expect(
      new PublishService(createUploadFetch().fetchImpl).publish(userId, videoId, {
        scheduledFor: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/always goes live as public/);
  });

  it("records a scheduled publish as SCHEDULED with no publishedAt, not as already published", async () => {
    const { videoId } = await makePublishableVideo();
    const scheduledFor = new Date("2030-01-01T12:00:00.000Z");

    const { fetchImpl } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      scheduledFor,
    });

    // The bytes are on YouTube, but nobody can see them until publishAt
    // arrives — publishedAt means "when this went live", and it hasn't yet.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("SCHEDULED");
    expect(publication.publishedAt).toBeNull();

    // The video itself has genuinely left Framecast's pipeline the moment
    // the upload succeeds — there's no VideoStatus for "uploaded but not yet
    // live", and nothing here ever re-renders or retries it either way.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");
  });

  it("records an immediate publish as PUBLISHED with a publishedAt timestamp", async () => {
    const { videoId } = await makePublishableVideo();

    const before = new Date();
    const { fetchImpl } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("PUBLISHED");
    expect(publication.publishedAt).not.toBeNull();
    expect(publication.publishedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("clamps the combined description to YouTube's limit without losing the credits", async () => {
    const { videoId } = await makePublishableVideo();
    // Comfortably over DESCRIPTION_MAX even before the sources/Pixabay block
    // is added on top, so this exercises the clamp rather than just missing it.
    const nearLimitDescription = "word ".repeat(1200);
    await prisma.video.update({
      where: { id: videoId },
      data: { generatedDescription: nearLimitDescription },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect((body.snippet.description as string).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    // sourcesAndCredits is placed first specifically so a cut lands in the
    // narration summary's tail, never in the licensing-required attribution.
    expect(body.snippet.description).toContain("Pixabay");
    expect(body.snippet.description).toContain("SOURCES");

    // What's persisted must match what YouTube actually received.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(publication.description).toBe(body.snippet.description);
  });
});
