import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import type { ShortStatus, VideoStatus } from "@/generated/prisma/enums";
import { deleteRenderFile, renderPath, statRenderFile, writeRenderFile } from "@/lib/render-storage";
import { prisma } from "@/lib/prisma";
import { deleteShortFile, statShortFile, writeShortFile } from "@/lib/shorts-storage";
import { getObject, putObject, removeObjects, storagePath } from "@/lib/storage";
import { PUBLISHING_DEFAULTS } from "@/lib/youtube-categories";
import { DESCRIPTION_MAX } from "@/lib/youtube-limits";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import type { FetchLike } from "@/services/publish.service";
import {
  buildDescription,
  extractSourcesSection,
  hoursUntilQuotaReset,
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

/** Short files written under RENDER_ROOT by `makeReadyShort` below. `Short`
 * rows go with the user's cascade; their files do not, exactly like the
 * renders tracked above. */
const shortFilePaths: string[] = [];

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
  await Promise.all(
    shortFilePaths.splice(0).map((location) => deleteShortFile(location).catch(() => {})),
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
  // stopped hard-coding "unlisted" regardless of caller input. The audience
  // declaration used to be the one flag here that never varied by caller
  // input — it was the literal `false`. It now comes from the channel, and
  // the tests for it are in their own block below.
  it("declares not made for kids for a channel that has no brand row at all", async () => {
    // The state most channels are in, and the one the migration's default
    // reproduces: no brand row, so `brandService.resolve` falls back. This
    // has to send exactly what the hardcoded literal sent before the column
    // existed, or every existing channel's declaration changes under it.
    const { videoId, channelId } = await makePublishableVideo();
    expect(await prisma.channelBrand.findUnique({ where: { channelId } })).toBeNull();

    const { fetchImpl, calls } = createUploadFetch();
    const service = new PublishService(fetchImpl);

    await service.publish(userId, videoId);

    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
    expect(initCall).toBeDefined();
    const body = JSON.parse(initCall!.init!.body as string);
    expect(body.status.selfDeclaredMadeForKids).toBe(false);
  });

  it("sends the channel's declaration, not a constant, when it is made for kids", async () => {
    // The bug this whole feature exists for: every upload declared
    // `selfDeclaredMadeForKids: false` whatever the channel was. Under COPPA
    // that is a false declaration for a children's channel, not a default.
    const { videoId, channelId } = await makePublishableVideo();
    await prisma.channelBrand.create({ data: { channelId, madeForKids: true } });

    const { fetchImpl, calls } = createUploadFetch();
    const service = new PublishService(fetchImpl);

    await service.publish(userId, videoId);

    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
    const body = JSON.parse(initCall!.init!.body as string);
    expect(body.status.selfDeclaredMadeForKids).toBe(true);
  });

  it("sends false for a channel whose brand row says so", async () => {
    // A brand row exists — set for logo, tone or language — and its
    // declaration is false. Distinct from the no-row case above: this one
    // proves the column is read rather than that the fallback happens to
    // agree with it.
    const { videoId, channelId } = await makePublishableVideo();
    await prisma.channelBrand.create({
      data: { channelId, madeForKids: false, tone: "dry and factual" },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const initCall = calls.find((c) => c.url.includes("uploadType=resumable"));
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

  it("leads the description with the summary, not the credits", async () => {
    // The defect this replaces: the credits were placed first so a clamp would
    // eat the summary's tail, which meant the ~150 characters YouTube shows in
    // search results and above the fold were a Pixabay credit list. The first
    // video this app ever published opened on one.
    const { videoId } = await makePublishableVideo();
    await prisma.video.update({
      where: { id: videoId },
      data: { generatedDescription: "Inflation is money losing value, explained." },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    const description = body.snippet.description as string;

    expect(description.startsWith("Inflation is money losing value, explained.")).toBe(true);
    expect(description.indexOf("SOURCES")).toBeGreaterThan(0);
    expect(description.indexOf("Pixabay")).toBeGreaterThan(
      description.indexOf("Inflation is money losing value, explained."),
    );

    // What's persisted must match what YouTube actually received.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description).toBe(description);
  });

  it("clamps the summary, never the credits, when the combined text is over the limit", async () => {
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
    const description = body.snippet.description as string;
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);

    // The exact credit lines, not a `toContain("Pixabay")` that a
    // half-truncated attribution block would also satisfy. The credits' length
    // is reserved out of the cap before the summary is clamped, so they are
    // intact by arithmetic rather than by sitting on the lucky side of a cut.
    expect(description).toContain("Video clips courtesy of Pixabay (https://pixabay.com).");
    expect(description).toContain("SOURCES");
    expect(description).toContain("- https://example.com/federal-reserve-report");
    expect(description).toContain("- https://example.com/inflation-study");
    // And the credits are still last — this fixture has no music asset, so
    // the Pixabay line is the final one buildDescription emits. Only true if
    // the summary is what gave way.
    expect(
      description.endsWith("Video clips courtesy of Pixabay (https://pixabay.com)."),
    ).toBe(true);
    expect(description.startsWith("word word")).toBe(true);
    expect(description).not.toContain(nearLimitDescription.trim());

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.description!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(publication.description).toBe(description);
  });

  it("publishes the credits alone when the metadata stage never wrote a summary", async () => {
    // The pre-`generatedDescription` shape, and still what a video whose
    // metadata stage failed gets. Nothing about leading with the summary may
    // turn "no summary" into "no attribution".
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    const description = body.snippet.description as string;

    expect(description.startsWith("SOURCES")).toBe(true);
    expect(description).toContain("Video clips courtesy of Pixabay (https://pixabay.com).");
    // No stray separator where a summary would have been.
    expect(description.startsWith("\n")).toBe(false);
  });
});

/**
 * One short, as the worker would leave it: a row plus a real file under
 * RENDER_ROOT at `shorts/<id>.mp4`.
 *
 * The file is written for real rather than stubbed because two of the
 * properties below are about files — that a short's bytes are read from the
 * shorts path and not from the render, and that reclaiming the render after
 * publishing leaves them alone.
 */
async function makeReadyShort(
  videoId: string,
  index: number,
  opts: { title?: string | null; description?: string | null; status?: ShortStatus } = {},
): Promise<{ id: string; outputPath: string | null }> {
  const status = opts.status ?? "READY";

  const short = await prisma.short.create({
    data: {
      videoId,
      index,
      startSeconds: index * 60,
      endSeconds: index * 60 + 40,
      title: opts.title === undefined ? `Short about inflation ${index + 1}` : opts.title,
      description:
        opts.description === undefined ? `What this clip covers, ${index + 1}.` : opts.description,
      reason: "It stands on its own.",
      status,
    },
    select: { id: true },
  });

  // Only a READY short has a file — the whole point of the status.
  if (status !== "READY") {
    return { id: short.id, outputPath: null };
  }

  const sourcePath = path.join(tmpdir(), `framecast-test-short-${short.id}.mp4`);
  await writeFile(sourcePath, Buffer.from(`fake-short-${short.id}`));
  const outputPath = await writeShortFile(short.id, sourcePath);
  await rm(sourcePath, { force: true });
  shortFilePaths.push(outputPath);

  await prisma.short.update({ where: { id: short.id }, data: { outputPath } });

  return { id: short.id, outputPath };
}

/** One recorded `videos.insert`, in the order the uploads happened: the video
 *  first, then each short. */
interface RecordedUpload {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: string;
  publishAt?: string;
  language: string;
  categoryId: string;
  /** `status.selfDeclaredMadeForKids`. Recorded per upload because the whole
   *  point is that a clip of a kids video must carry the same declaration as
   *  the video it was cut from. */
  madeForKids: boolean;
  youtubeVideoId: string | null;
  /** The bytes that were PUT, so a test can prove which file went up. */
  body: string | null;
}

/**
 * A resumable-upload endpoint that can be made to fail on the *nth* upload,
 * which is the whole point of it: publishing a video with three shorts is four
 * uploads through one code path, and every interesting property here is about
 * what happens to the other three when one of them fails.
 *
 * Uploads are numbered from zero in call order, so 0 is always the video.
 */
function createSequenceFetch(
  opts: {
    /** Fail this upload's init with a plain 500. */
    failAt?: number;
    /** Fail this upload's init with the 403 body YouTube sends when the daily
     *  allowance is gone. */
    quotaAt?: number;
  } = {},
): { fetchImpl: FetchLike; uploads: RecordedUpload[] } {
  const uploads: RecordedUpload[] = [];
  /** Attempt number, counted on every init — including the ones made to fail,
   *  which is the difference between "the third upload" and "the third
   *  successful upload". `uploads` holds only the ones that got as far as
   *  sending metadata, so the two are indexed separately. */
  const byAttempt = new Map<number, RecordedUpload>();
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
          // The real shape, verbatim from the Data API's error documentation —
          // the reason token in the body is the only thing separating this
          // from a 403 for an unverified or suspended channel.
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

      const snippet = JSON.parse(init!.body as string) as {
        snippet: {
          title: string;
          description: string;
          tags: string[];
          defaultLanguage: string;
          categoryId: string;
        };
        status: {
          privacyStatus: string;
          publishAt?: string;
          selfDeclaredMadeForKids: boolean;
        };
      };

      const recorded: RecordedUpload = {
        title: snippet.snippet.title,
        description: snippet.snippet.description,
        tags: snippet.snippet.tags,
        privacyStatus: snippet.status.privacyStatus,
        publishAt: snippet.status.publishAt,
        language: snippet.snippet.defaultLanguage,
        categoryId: snippet.snippet.categoryId,
        madeForKids: snippet.status.selfDeclaredMadeForKids,
        youtubeVideoId: null,
        body: null,
      };
      uploads.push(recorded);
      byAttempt.set(at, recorded);

      return {
        ok: true,
        status: 200,
        headers: new Headers({
          location: `https://upload.example.invalid/resumable/${at}`,
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

    // The PUT of the bytes, back to the location handed out above.
    const at = Number(url.slice(url.lastIndexOf("/") + 1));
    const youtubeVideoId = `yt_upload_${at}`;
    const recorded = byAttempt.get(at)!;
    recorded.youtubeVideoId = youtubeVideoId;
    recorded.body = Buffer.from(init!.body as ArrayBuffer).toString("utf-8");

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: youtubeVideoId }),
    } as unknown as Response;
  }) as FetchLike;

  return { fetchImpl, uploads };
}

describe("publishService.publish — shorts, when the operator asks for them", () => {
  it("uploads only the video when the box is not ticked, whatever shorts exist", async () => {
    // The default, and the one that must never drift: shorts could not be
    // published at all until this feature landed, so a publish that does not
    // ask for them has to behave exactly as it did then.
    const { videoId } = await makePublishableVideo();
    const first = await makeReadyShort(videoId, 0);
    await makeReadyShort(videoId, 1);

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
    });

    expect(uploads).toHaveLength(1);
    expect(result.shorts).toEqual([]);
    expect(await prisma.shortPublication.count({ where: { short: { videoId } } })).toBe(0);

    // And the shorts are untouched, still READY with their files — not
    // consumed, not marked as anything.
    const short = await prisma.short.findUniqueOrThrow({ where: { id: first.id } });
    expect(short.status).toBe("READY");
    expect(await statShortFile(short.outputPath!)).not.toBeNull();
  });

  it("carries a made-for-kids channel's declaration onto every short too", async () => {
    // A clip cut from a children's video is children's content. The short
    // path takes the declaration from the video's own publish rather than
    // resolving it again, so this is the test that would catch a short going
    // up declared not-for-kids from a channel that is.
    const { videoId, channelId } = await makePublishableVideo();
    await prisma.channelBrand.create({ data: { channelId, madeForKids: true } });
    await makeReadyShort(videoId, 0);
    await makeReadyShort(videoId, 1);

    const { fetchImpl, uploads } = createSequenceFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      includeShorts: true,
    });

    expect(uploads).toHaveLength(3);
    // Every upload, not just the first — an assertion on `uploads[0]` alone
    // would pass with the shorts declaring the opposite.
    expect(uploads.map((upload) => upload.madeForKids)).toEqual([true, true, true]);
  });

  it("uploads the video and each READY short, and records one publication per short", async () => {
    const { videoId } = await makePublishableVideo();
    const one = await makeReadyShort(videoId, 0);
    const two = await makeReadyShort(videoId, 1);
    const three = await makeReadyShort(videoId, 2);

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      includeShorts: true,
    });

    // Four uploads: the video, then the shorts in play order.
    expect(uploads).toHaveLength(4);
    expect(result.youtubeVideoId).toBe("yt_upload_0");
    expect(result.shorts.map((short) => short.shortId)).toEqual([one.id, two.id, three.id]);
    expect(result.shorts.map((short) => short.youtubeVideoId)).toEqual([
      "yt_upload_1",
      "yt_upload_2",
      "yt_upload_3",
    ]);
    expect(result.shorts.every((short) => short.error === null)).toBe(true);

    // Each short's own bytes went up, not the render's — the clips are
    // separate files at `shorts/<id>.mp4` and are never re-cut here.
    expect(uploads[1].body).toBe(`fake-short-${one.id}`);
    expect(uploads[3].body).toBe(`fake-short-${three.id}`);

    // Shorts inherit the publish's visibility rather than choosing their own:
    // a public clip of a private video would be a leak with extra steps.
    expect(uploads.map((upload) => upload.privacyStatus)).toEqual([
      "public",
      "public",
      "public",
      "public",
    ]);

    // And the channel's language, category and audience declaration, exactly
    // as the video gets them.
    for (const upload of uploads) {
      expect(upload.language).toBe(PUBLISHING_DEFAULTS.language);
      expect(upload.categoryId).toBe(PUBLISHING_DEFAULTS.categoryId);
      expect(upload.madeForKids).toBe(PUBLISHING_DEFAULTS.madeForKids);
    }

    // The clip's own title, and the credits the same footage owes wherever it
    // is used — Pixabay's terms do not stop applying because the clip is
    // vertical.
    expect(uploads[1].title).toBe("Short about inflation 1");
    expect(uploads[1].description).toContain("Pixabay");
    expect(uploads[1].description).toContain("What this clip covers, 1.");

    const publications = await prisma.shortPublication.findMany({
      where: { shortId: { in: [one.id, two.id, three.id] } },
    });
    expect(publications).toHaveLength(3);
    for (const publication of publications) {
      expect(publication.status).toBe("PUBLISHED");
      expect(publication.visibility).toBe("PUBLIC");
      expect(publication.youtubeVideoId).toMatch(/^yt_upload_/);
      expect(publication.publishedAt).not.toBeNull();
      expect(publication.error).toBeNull();
    }
  });

  it("skips shorts that are not READY, and falls back to the video's title for an unnamed one", async () => {
    const { videoId } = await makePublishableVideo();
    await makeReadyShort(videoId, 0, { status: "QUEUED" });
    await makeReadyShort(videoId, 1, { status: "FAILED" });
    const named = await makeReadyShort(videoId, 2, { title: null, description: null });

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      includeShorts: true,
    });

    // A queued short has no file and a failed one never produced bytes;
    // uploading either is not a degraded publish, it is an impossible one.
    expect(uploads).toHaveLength(2);
    expect(result.shorts.map((short) => short.shortId)).toEqual([named.id]);
    expect(uploads[1].title).toBe("How inflation actually works — Short 3");
    // No clip description, but the attribution is still owed — and with
    // nothing to lead with, the credits are the whole description rather than
    // a description with a blank line on top of it.
    expect(uploads[1].description).toContain("Pixabay");
    expect(uploads[1].description.startsWith("SOURCES")).toBe(true);
  });

  it("leads a short's description with the clip's own summary, credits after", async () => {
    // The same reorder the video's own description got, for the same reason: a
    // Shorts description shows as a couple of lines under the player, so a
    // clip that opened on an attribution block opened on the only part of it a
    // viewer would ever see.
    const { videoId } = await makePublishableVideo();
    await makeReadyShort(videoId, 0, { description: "Why inflation is not prices going up." });

    const { fetchImpl, uploads } = createSequenceFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, { includeShorts: true });

    const description = uploads[1].description;
    expect(description.startsWith("Why inflation is not prices going up.")).toBe(true);
    expect(description.indexOf("Pixabay")).toBeGreaterThan(0);
    expect(description).toContain("Video clips courtesy of Pixabay (https://pixabay.com).");
    expect(description).toContain("SOURCES");
  });

  it("keeps a short's credits intact when its own summary is too long to fit", async () => {
    const { videoId } = await makePublishableVideo();
    const longSummary = "clip ".repeat(1200);
    await makeReadyShort(videoId, 0, { description: longSummary });

    const { fetchImpl, uploads } = createSequenceFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, { includeShorts: true });

    const description = uploads[1].description;
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    // The exact lines, not a substring that a half-cut block would satisfy.
    expect(description).toContain("Video clips courtesy of Pixabay (https://pixabay.com).");
    expect(description).toContain("- https://example.com/federal-reserve-report");
    expect(
      description.endsWith("Video clips courtesy of Pixabay (https://pixabay.com)."),
    ).toBe(true);
    expect(description.startsWith("clip clip")).toBe(true);
  });

  it("leaves the video published when a short fails, and records which one and why", async () => {
    // The property the whole feature turns on: four uploads, one click, and
    // the video's own outcome decided before any clip is read off disk.
    const { videoId } = await makePublishableVideo();
    const one = await makeReadyShort(videoId, 0);
    const two = await makeReadyShort(videoId, 1);
    const three = await makeReadyShort(videoId, 2);

    // Upload 2 is the second short — the video is 0.
    const { fetchImpl, uploads } = createSequenceFetch({ failAt: 2 });
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "UNLISTED",
      includeShorts: true,
    });

    // Not a throw. The publish did not fail; two thirds of the shorts did not
    // fail either, and reporting the whole thing as failed would be a lie
    // about something that cannot be repeated.
    expect(result.youtubeVideoId).toBe("yt_upload_0");

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.status).toBe("PUBLISHED");
    expect(video.failureReason).toBeNull();
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("PUBLISHED");

    // The failure is attributed to the one short that had it, by index, with a
    // reason — not to "the shorts".
    expect(result.shorts).toHaveLength(3);
    expect(result.shorts[0]).toMatchObject({ shortId: one.id, index: 0, error: null });
    expect(result.shorts[1]).toMatchObject({ shortId: two.id, index: 1, youtubeVideoId: null });
    expect(result.shorts[1].error).toMatch(/YouTube upload/i);
    expect(result.shorts[2]).toMatchObject({ shortId: three.id, index: 2, error: null });

    // The one after the failure still went up: one clip failing must not
    // abandon the rest.
    expect(uploads).toHaveLength(3);

    const failed = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: two.id },
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/YouTube upload/i);
    expect(failed.youtubeVideoId).toBeNull();

    const succeeded = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: three.id },
    });
    expect(succeeded.status).toBe("PUBLISHED");
  });

  it("records a short whose file has gone missing, and publishes the rest", async () => {
    const { videoId } = await makePublishableVideo();
    const gone = await makeReadyShort(videoId, 0);
    const kept = await makeReadyShort(videoId, 1);

    // A hand-deleted clip: the row still says READY with an outputPath.
    await deleteShortFile(gone.outputPath!);

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      includeShorts: true,
    });

    expect(uploads).toHaveLength(2);
    expect(result.shorts[0].error).toMatch(/no longer on disk/i);
    expect(result.shorts[1].youtubeVideoId).toBe("yt_upload_1");
    expect(
      (await prisma.shortPublication.findUniqueOrThrow({ where: { shortId: gone.id } })).status,
    ).toBe("FAILED");
    expect(
      (await prisma.shortPublication.findUniqueOrThrow({ where: { shortId: kept.id } })).status,
    ).toBe("PUBLISHED");
  });

  it("never re-publishes a short that already has a publication row, failed or not", async () => {
    // One-shot per short, enforced exactly the way the video's is: a row on
    // the `@unique` shortId, taken before any byte is sent. A FAILED row
    // blocks just as hard as a published one — the attempt happened, and
    // YouTube may already hold the clip.
    const { videoId, channelId } = await makePublishableVideo();
    const alreadyTried = await makeReadyShort(videoId, 0);
    const fresh = await makeReadyShort(videoId, 1);

    await prisma.shortPublication.create({
      data: {
        shortId: alreadyTried.id,
        channelId,
        title: "An earlier attempt",
        status: "FAILED",
        error: "Something went wrong the first time.",
      },
    });

    const service = new PublishService(createSequenceFetch().fetchImpl);
    // The count the dialog shows comes from the same query the upload loop
    // uses, so the offer and the action cannot describe different sets.
    expect(await service.countPublishableShorts(userId, videoId)).toBe(1);

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      includeShorts: true,
    });

    expect(uploads).toHaveLength(2);
    expect(result.shorts.map((short) => short.shortId)).toEqual([fresh.id]);

    // Untouched, including its original error — a refused re-publish must not
    // quietly overwrite the record of the attempt that blocked it.
    const untouched = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: alreadyTried.id },
    });
    expect(untouched.status).toBe("FAILED");
    expect(untouched.title).toBe("An earlier attempt");
  });

  it("refuses a second publish for the video and never reaches its shorts", async () => {
    // The video's own one-shot is what makes a second shorts publish
    // unreachable in practice: the claim on Publication.videoId is taken
    // first, so the second click stops before a single clip is considered.
    const { videoId } = await makePublishableVideo();
    await makeReadyShort(videoId, 0);

    const first = createSequenceFetch();
    await new PublishService(first.fetchImpl).publish(userId, videoId, {
      includeShorts: true,
    });
    expect(first.uploads).toHaveLength(2);

    const second = createSequenceFetch();
    await expect(
      new PublishService(second.fetchImpl).publish(userId, videoId, { includeShorts: true }),
    ).rejects.toThrow(ConflictError);

    expect(second.uploads).toHaveLength(0);
    // Still exactly one row per short, with the id from the first publish.
    const publications = await prisma.shortPublication.findMany({
      where: { short: { videoId } },
    });
    expect(publications).toHaveLength(1);
    expect(publications[0].youtubeVideoId).toBe("yt_upload_1");
  });

  it("keeps every short's file when publishing reclaims the render", async () => {
    // Reclaiming deletes `renders/<videoId>.mp4` and the `videos/<id>/clips/`
    // objects. Shorts live at `shorts/<shortId>.mp4`, written at generate
    // time, and are cut from the render long before this — so publishing must
    // leave them exactly where they are, whether or not they were uploaded.
    const { videoId, outputUrl } = await makePublishableVideo();
    const uploaded = await makeReadyShort(videoId, 0);
    const untouched = await makeReadyShort(videoId, 1, { status: "QUEUED" });

    const { fetchImpl } = createSequenceFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, { includeShorts: true });

    expect(await statRenderFile(outputUrl)).toBeNull();
    expect(await statShortFile(uploaded.outputPath!)).not.toBeNull();
    // A queued short has no file to keep, and nothing tried to publish it.
    expect(untouched.outputPath).toBeNull();
    expect(
      await prisma.shortPublication.count({ where: { shortId: untouched.id } }),
    ).toBe(0);
  });

  it("carries a scheduled publish's timestamp onto its shorts, so no clip goes live first", async () => {
    const { videoId } = await makePublishableVideo();
    await makeReadyShort(videoId, 0);
    const scheduledFor = new Date("2030-01-01T12:00:00.000Z");

    const { fetchImpl, uploads } = createSequenceFetch();
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      scheduledFor,
      includeShorts: true,
    });

    expect(uploads[1].privacyStatus).toBe("private");
    expect(uploads[1].publishAt).toBe(scheduledFor.toISOString());

    const publication = await prisma.shortPublication.findUniqueOrThrow({
      where: { shortId: result.shorts[0].shortId },
    });
    expect(publication.status).toBe("SCHEDULED");
    expect(publication.publishedAt).toBeNull();
  });
});

describe("publishService.publish — the daily upload allowance", () => {
  it("says when the quota resets instead of surfacing a bare 403", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl } = createSequenceFetch({ quotaAt: 0 });
    let message = "";
    try {
      await new PublishService(fetchImpl).publish(userId, videoId);
      expect.unreachable("a spent quota must not look like a successful publish");
    } catch (thrown) {
      message = (thrown as Error).message;
    }

    // Not "Could not start the YouTube upload (403)" — the operator would go
    // looking for a permissions problem that is not there. This is the one
    // failure whose fix is a clock.
    expect(message).toMatch(/daily upload allowance/i);
    expect(message).toMatch(/midnight Pacific/i);
    expect(message).toMatch(/100 uploads a day/i);

    // Everything else about a failed publish is unchanged: the claim row is
    // kept as FAILED so nothing re-fires, and the video is FAILED with it.
    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.status).toBe("FAILED");
    expect((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status).toBe(
      "FAILED",
    );
  });

  it("stops uploading shorts once the allowance is gone, and spends no further claims", async () => {
    const { videoId } = await makePublishableVideo();
    const one = await makeReadyShort(videoId, 0);
    const two = await makeReadyShort(videoId, 1);
    const three = await makeReadyShort(videoId, 2);

    // The video goes up, then the first short meets the limit.
    const { fetchImpl, uploads } = createSequenceFetch({ quotaAt: 1 });
    const result = await new PublishService(fetchImpl).publish(userId, videoId, {
      includeShorts: true,
    });

    expect(result.youtubeVideoId).toBe("yt_upload_0");
    expect(uploads).toHaveLength(1);

    expect(result.shorts[0].error).toMatch(/daily upload allowance/i);
    // The two after it are reported as not attempted rather than as failures
    // of their own — and, crucially, they keep their one attempt: no claim row
    // is spent on an upload that never happened.
    expect(result.shorts[1].error).toMatch(/^Not attempted/);
    expect(result.shorts[2].error).toMatch(/^Not attempted/);

    expect(
      (await prisma.shortPublication.findUniqueOrThrow({ where: { shortId: one.id } })).status,
    ).toBe("FAILED");
    expect(await prisma.shortPublication.count({ where: { shortId: { in: [two.id, three.id] } } })).toBe(0);

    // Tomorrow's dialog can still offer the two that were never tried.
    expect(await new PublishService(fetchImpl).countPublishableShorts(userId, videoId)).toBe(2);
  });

  it("counts the hours to midnight Pacific, never down to zero", () => {
    // 03:00 in Los Angeles (PDT, UTC-7) — twenty-one hours left of the day.
    expect(hoursUntilQuotaReset(new Date("2026-08-15T10:00:00.000Z"))).toBe(21);
    // 23:45 there: rounded up to one, because "in about 0 hours" reads as
    // "right now", which is the one thing this must not say.
    expect(hoursUntilQuotaReset(new Date("2026-08-16T06:45:00.000Z"))).toBe(1);
    // Winter, so the same wall-clock hour is a different UTC instant — the
    // zone does the work, not a fixed offset.
    expect(hoursUntilQuotaReset(new Date("2026-01-15T11:00:00.000Z"))).toBe(21);
  });
});
