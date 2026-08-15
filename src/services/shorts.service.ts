import "server-only";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGateway, generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import { env } from "@/config/env";
import type { ShortStatus, VideoStatus } from "@/generated/prisma/enums";
import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { buildShortArgs } from "@/lib/ffmpeg-command";
import { prisma } from "@/lib/prisma";
import { statRenderFile } from "@/lib/render-storage";
import {
  anchorCues,
  cueWindows,
  type CueWindow,
  type ScriptCue,
} from "@/lib/script-cues";
import {
  describeSections,
  MAX_SHORT_SECONDS,
  MIN_SHORT_SECONDS,
  planShortWindow,
  SHORT_MAX_CHARS_PER_LINE,
  SHORT_MAX_WORDS_PER_LINE,
  type ShortWindow,
  sliceAlignment,
  verticalCaptionStyle,
  windowsOverlap,
} from "@/lib/shorts-plan";
import { deleteShortFile, writeShortFile } from "@/lib/shorts-storage";
import { getObject } from "@/lib/storage";
import {
  describeProviderFailure,
  isRetryableProviderFailure,
  repairDoubleEncodedObject,
} from "@/lib/structured-output";
import { brandService } from "@/services/brand.service";
import { MAX_ATTEMPTS } from "@/services/job.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { defaultSpawner, type ProcessSpawner, type RenderProgress } from "@/services/render.service";

/**
 * Cutting vertical shorts out of a video that is already finished.
 *
 * Two halves that never run at the same time:
 *
 *   1. `generate` — the operator asks for shorts. A model is shown the script,
 *      section by section, and picks the moments worth clipping; each pick is
 *      turned into a time window and stored as a QUEUED `Short`. No encoding
 *      happens here, so the operator's click returns in the time one model call
 *      takes rather than the time three encodes take.
 *   2. `claimNext` / `heartbeat` / `renderShort` / `release` — the worker,
 *      polling the same loop it polls videos with, takes one queued short at a
 *      time and encodes it.
 *
 * The split is what keeps a failed short off its parent video. Nothing in this
 * file writes to `Video` at all: a short that cannot be selected, encoded or
 * stored fails its own row and leaves a READY, publishable video exactly as it
 * was. The worker's own error handling (worker/index.ts) preserves that — it
 * releases the *short*, never the video.
 */

/** How many moments a single `generate` asks the model for. Three is enough to
 *  give the operator a choice and few enough that reviewing them is a minute's
 *  work rather than an afternoon's; each one costs a real encode. */
const DEFAULT_SHORT_COUNT = 3;

/**
 * How long a worker holds a claimed short before another may take over.
 *
 * Much shorter than `job.service.ts`'s ten minutes because the work is much
 * shorter: a minute of already-rendered footage re-encoded from a local file
 * takes seconds, not the ten minutes a full render can. A lease sized for a
 * render would leave a short stranded for ten minutes after a worker died over
 * work that takes twenty seconds. Not imported from job.service.ts — that
 * module's `LEASE_SECONDS` is deliberately unexported, and it would be the
 * wrong number here anyway.
 */
const SHORT_LEASE_SECONDS = 120;

/** Stderr is batched rather than written per line, same as render.service.ts. */
const STDERR_FLUSH_BYTES = 4000;

export interface ShortSummary {
  id: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
  title: string | null;
  description: string | null;
  reason: string | null;
  status: ShortStatus;
  error: string | null;
  hasFile: boolean;
}

/** What the model is asked to choose. Sections are 1-based here because that is
 *  how they are numbered in the prompt the model reads. */
export interface MomentCandidate {
  startSection: number;
  endSection: number;
  title: string;
  description: string;
  reason: string;
}

export interface MomentSelectionInput {
  /** The numbered section list, one per line, with each section's spoken
   *  length. See `describeSections`. */
  sections: string;
  count: number;
  tone: string;
  niche: string;
  apiKey?: string;
}

/** Injectable so tests never make a real model call. */
export type MomentSelector = (input: MomentSelectionInput) => Promise<MomentCandidate[]>;

/**
 * The structured shape the model must answer in.
 *
 * Sections are chosen by NUMBER, not quoted back as text, and that is the whole
 * reliability argument for this feature. A model asked to quote the narration it
 * wants would have to reproduce it byte-for-byte for a string search to find it
 * again, and a near-miss — a smart quote, a dropped comma, a silently corrected
 * typo — would either orphan the moment or, worse, match somewhere else. An
 * integer either indexes a real section or does not, and `planShortWindow`
 * rejects the ones that do not.
 *
 * The descriptions live on the schema rather than only in the prompt, following
 * `scriptSchema`/`metadataSchema` in gateway.provider.ts: the schema is the one
 * instruction that travels with every structured request.
 */
const momentSchema = z.object({
  moments: z
    .array(
      z.object({
        startSection: z
          .number()
          .int()
          .describe("The number of the first section of this moment, from the list given."),
        endSection: z
          .number()
          .int()
          .describe(
            "The number of the last section of this moment, inclusive. Must be " +
              "greater than or equal to startSection — a moment is a run of " +
              "consecutive sections, never a selection of scattered ones.",
          ),
        title: z
          .string()
          .describe(
            "A YouTube Shorts title under 100 characters for this clip alone. " +
              "It must make sense to someone who has not seen the full video.",
          ),
        description: z
          .string()
          .describe("One or two sentences describing this clip. No hashtags, no links."),
        reason: z
          .string()
          .describe(
            "One sentence on why this moment stands on its own — the thing that " +
              "would make someone stop scrolling.",
          ),
      }),
    )
    .min(1),
});

/**
 * The default `MomentSelector`: one `generateObject` call through the Vercel AI
 * Gateway, the same path `gateway.provider.ts` uses for scripts and metadata.
 *
 * It lives here rather than as a method on `GatewayProvider` because that class
 * implements `TextGenerationProvider`, an interface every one of its callers
 * shares; adding a shorts-only method there would put a concern no other caller
 * has into the type all of them depend on. The gateway construction, the
 * per-request `apiKey` override and the `ProviderError` wrapping are copied
 * from it deliberately, so an operator's own stored Anthropic key is honoured
 * here exactly as it is everywhere else.
 *
 * Exported for `shorts.service.selector.test.ts`, which is the only way to
 * cover the parts of this feature that live between the schema and the SDK.
 */
export const gatewayMomentSelector: MomentSelector = async (input) => {
  const apiKey = input.apiKey ?? env.AI_GATEWAY_API_KEY;

  if (!apiKey) {
    throw new ProviderError(
      "ANTHROPIC",
      "No API key configured. Add one on the Providers page.",
      false,
    );
  }

  const prompt = [
    `You are choosing ${input.count} moments from a finished ${input.niche} video ` +
      `to cut into vertical YouTube Shorts. Tone: ${input.tone}.`,
    "",
    "The narration is numbered by section below, with how long each section is " +
      "spoken for. Choose runs of consecutive sections that work as standalone " +
      "clips: a complete thought with a hook at the front, understandable to " +
      "someone who has never seen the full video.",
    "",
    `Each moment must run between ${MIN_SHORT_SECONDS} and ${MAX_SHORT_SECONDS} ` +
      "seconds — add up the section lengths to check. The moments must not " +
      "overlap each other, and must not all come from the same part of the video.",
    "",
    "Sections:",
    input.sections,
  ].join("\n");

  try {
    const result = await generateObject({
      model: createGateway({ apiKey }).languageModel(env.AI_SCRIPT_MODEL),
      schema: momentSchema,
      prompt,
      // The one repair this call needs, and the reason it needs it at all is
      // in `repairDoubleEncodedObject`: this exact prompt and schema made
      // `anthropic/claude-sonnet-5` serialise its whole answer into the string
      // slot of its own `moments` property, every single time, which is why
      // shorts never once succeeded in production. The SDK only calls this
      // after validation has already failed, so on a well-formed answer it
      // costs nothing.
      repairText: async ({ text }) => repairDoubleEncodedObject(text),
    });

    return result.object.moments;
  } catch (cause) {
    // The provider's own words, server-side, before anything is wrapped. The
    // wrapper below is written for an operator and cannot carry a rejected
    // model answer or a gateway response body; without this line the next
    // failure here is another investigation rather than one `docker compose
    // logs`.
    console.error(
      `gatewayMomentSelector: ${env.AI_SCRIPT_MODEL} could not choose moments — ` +
        describeProviderFailure(cause),
    );

    // A model that answered in the wrong shape is a different fault from a
    // provider that never answered, and only one of them is worth clicking
    // again. Telling an operator "the model provider failed" when the provider
    // answered fine leaves them retrying against a platform problem that isn't
    // there — or, as here, waiting for an outage to end that never began.
    const answeredButUnusable = NoObjectGeneratedError.isInstance(cause);

    throw new ProviderError(
      "ANTHROPIC",
      answeredButUnusable
        ? "The model answered, but not in a shape shorts can be cut from, so no " +
            "moments could be read out of it. Try generating again."
        : "The model provider failed to choose moments for shorts.",
      isRetryableProviderFailure(cause),
      { cause },
    );
  }
};

/** Everything needed to turn a section number into a second, gathered once. */
interface VideoTimeline {
  windows: CueWindow[];
  sections: string;
  alignment: Alignment;
  narrationSeconds: number;
  renderLocation: string;
  channelId: string | null;
  /** Only so a missing render can say *why* it is missing. A PUBLISHED video's
   *  render was deleted on purpose; any other video's went missing. */
  videoStatus: VideoStatus;
}

export class ShortsService {
  constructor(
    private readonly selectMoments: MomentSelector = gatewayMomentSelector,
    /** Same injection shape render.service.ts uses, and the same default, so a
     *  test can observe the argv without spawning a real encoder. */
    private readonly spawnProcess: ProcessSpawner = defaultSpawner,
  ) {}

  /**
   * Loads the one thing everything else in this file needs: the mapping from
   * script sections to seconds of the finished render.
   *
   * Every refusal here is a `ConflictError` naming what is missing, because
   * each one is a real, recoverable state an operator can be in — a video that
   * was rendered before per-section cues existed, a render whose file was
   * reclaimed after publishing — rather than a bug.
   */
  private async loadTimeline(userId: string, videoId: string): Promise<VideoTimeline> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        project: { select: { channelId: true } },
        voiceOver: { select: { durationSeconds: true } },
        script: { select: { activeVersion: { select: { content: true, cues: true } } } },
        // The render the shorts are cut out of. Only a SUCCEEDED job's
        // `outputUrl` names a file that was ever completely written.
        renderJobs: {
          where: { status: "SUCCEEDED", outputUrl: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outputUrl: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // READY or PUBLISHED, and PUBLISHED matters: `publish.service.ts` reclaims
    // the section clips once a video is live but leaves the render itself in
    // place, so a published video is still perfectly clippable — and is in fact
    // the state an operator is most likely to want shorts from.
    if (video.status !== "READY" && video.status !== "PUBLISHED") {
      throw new ConflictError(
        `Shorts are cut out of a finished video. This one is ${video.status.toLowerCase()}.`,
      );
    }

    const renderLocation = video.renderJobs[0]?.outputUrl;
    if (!renderLocation) {
      throw new ConflictError("This video has no completed render to cut shorts from.");
    }

    const narrationSeconds = video.voiceOver?.durationSeconds;
    if (narrationSeconds == null) {
      throw new ConflictError("This video's narration length is unknown; re-render it first.");
    }

    const activeVersion = video.script?.activeVersion ?? null;
    const rawCues = activeVersion?.cues;
    const scriptCues = Array.isArray(rawCues) ? (rawCues as unknown as ScriptCue[]) : [];

    if (!activeVersion || scriptCues.length === 0) {
      // Deliberately refused rather than approximated. Without cues there is no
      // sentence boundary anywhere in the script to cut on — only the raw
      // character alignment — and a clip that starts mid-clause is exactly the
      // failure this feature must not ship. Slicing the narration into equal
      // chunks would produce something, and what it produced would be wrong in
      // a way an operator only discovers after uploading it.
      throw new ConflictError(
        "This video's script has no section cues, so there is no reliable place " +
          "to cut a short. Regenerate the script (newer scripts carry cues) and " +
          "re-render before generating shorts.",
      );
    }

    // Re-anchored against the current content rather than trusting any stored
    // offsets, and trimmed — the exact same two steps render.service.ts takes
    // for the exact same reason. The alignment indexes the string ElevenLabs
    // was sent, which is `content.trim()`; anchoring against the untrimmed
    // content shifts every offset by whatever leading whitespace the content
    // carries, and each shifted character is a tenth of a second of picture.
    const content = activeVersion.content.trim();
    const { anchored } = anchorCues(scriptCues, content);

    if (anchored.length === 0) {
      throw new ConflictError(
        "None of this script's section cues still match its text, so there is no " +
          "reliable place to cut a short.",
      );
    }

    const alignment = await this.loadAlignment(videoId);
    const windows = cueWindows(anchored, alignment);

    return {
      windows,
      sections: describeSections(anchored, windows, content),
      alignment,
      narrationSeconds,
      renderLocation,
      videoStatus: video.status,
      channelId: video.project?.channelId ?? null,
    };
  }

  /**
   * The per-character narration alignment, read from the SUBTITLE asset the
   * narration stage wrote.
   *
   * Located by storage prefix rather than by a `videoId` column, because Asset
   * has none by design — see its comment in schema.prisma. Same query
   * render.service.ts uses to find the same object.
   */
  private async loadAlignment(videoId: string): Promise<Alignment> {
    const subtitleAsset = await prisma.asset.findFirst({
      where: {
        kind: "SUBTITLE",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    if (!subtitleAsset) {
      throw new ConflictError(
        "This video has no narration alignment stored, so its script cannot be " +
          "mapped onto the finished video's timeline.",
      );
    }

    return JSON.parse(
      (await getObject(subtitleAsset.storagePath)).toString("utf-8"),
    ) as Alignment;
  }

  /**
   * Picks moments and queues them. Does not encode anything.
   *
   * Replaces any previous set outright, files included. Regeneration is the
   * operator saying the last set was not good enough, and keeping both would
   * leave them choosing between six clips of which three are known-rejected —
   * plus `@@unique([videoId, index])` would refuse the write anyway (see the
   * Short model's comment on why that constraint earns its keep).
   */
  async generate(
    userId: string,
    videoId: string,
    count: number = DEFAULT_SHORT_COUNT,
  ): Promise<ShortSummary[]> {
    const timeline = await this.loadTimeline(userId, videoId);

    // Refused before the model is called, not after: a short in flight is
    // holding a lease and a temp directory, and deleting its row underneath the
    // worker would have that worker write a READY status to a row that no
    // longer exists.
    const inFlight = await prisma.short.count({
      where: { videoId, status: "RENDERING" },
    });

    if (inFlight > 0) {
      throw new ConflictError(
        "A short for this video is still rendering. Wait for it to finish before " +
          "generating a new set.",
      );
    }

    // The render has to exist before anything here is destructive, because
    // everything after this line is: the model call costs money, and the write
    // below hard-deletes the video's existing shorts to replace them.
    //
    // This was found the expensive way. An operator published a video — which
    // reclaims the local render on purpose — and then pressed Generate. The
    // three READY shorts they already had were deleted, three replacements were
    // created, and all three failed two seconds later against a file that no
    // longer existed. Every individual step behaved as designed; the sequence
    // destroyed good work to arrive at a message we could have given first.
    //
    // Checked here rather than in `renderShort`, which also checks: by the time
    // the worker gets there the deletion has already happened.
    const renderStat = await statRenderFile(timeline.renderLocation);
    if (!renderStat) {
      throw new ConflictError(
        timeline.videoStatus === "PUBLISHED"
          ? "This video was published, and publishing deletes the local render to " +
            "reclaim disk — so there is nothing left to cut shorts from. Any " +
            "shorts it already has are kept; generating a new set would only " +
            "replace them with ones that cannot render."
          : "This video's render is no longer on disk, so no short can be cut " +
            "from it. The shorts it already has are kept.",
      );
    }

    const brand = await brandService.resolve(timeline.channelId);
    const apiKey =
      (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ?? undefined;

    const candidates = await this.selectMoments({
      sections: timeline.sections,
      count,
      tone: brand.tone,
      niche: brand.niche,
      apiKey,
    });

    const accepted: Array<{ window: ShortWindow; candidate: MomentCandidate }> = [];

    for (const candidate of candidates) {
      // The model answers in 1-based section numbers because that is how the
      // prompt numbers them; everything past this line is 0-based, like every
      // other index in this codebase.
      const window = planShortWindow(
        timeline.windows,
        candidate.startSection - 1,
        candidate.endSection - 1,
        timeline.narrationSeconds,
      );

      // A moment that cannot be turned into a usable window is dropped, not
      // repaired into a different moment. `planShortWindow` already stretches
      // and truncates within the sentence the model chose; anything it still
      // refuses is a section number that does not exist or a window running
      // past the narration, neither of which this side can guess the intent of.
      if (!window) {
        continue;
      }

      if (accepted.some((entry) => windowsOverlap(entry.window, window))) {
        continue;
      }

      accepted.push({ window, candidate });

      if (accepted.length >= count) {
        break;
      }
    }

    if (accepted.length === 0) {
      throw new ConflictError(
        "No usable moment could be cut from this video — every section the model " +
          "chose was too short, too long, or outside the narration. Try again, or " +
          "edit the script into clearer sections.",
      );
    }

    // Ordered by where they fall in the video rather than by the model's own
    // ranking. `index` is the play order the panel lists them in, and "in the
    // order they happen" is the only ordering an operator can reason about
    // while scrubbing the source video beside it.
    accepted.sort((a, b) => a.window.startSeconds - b.window.startSeconds);

    const previous = await prisma.short.findMany({
      where: { videoId },
      select: { outputPath: true },
    });

    await prisma.$transaction(async (tx) => {
      // Hard delete, per the Short model's comment: a soft-deleted row would
      // keep occupying its `(videoId, index)` slot and block this insert while
      // being filtered out of every read.
      await tx.short.deleteMany({ where: { videoId } });

      await tx.short.createMany({
        data: accepted.map(({ window, candidate }, index) => ({
          videoId,
          index,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          title: candidate.title,
          description: candidate.description,
          reason: candidate.reason,
        })),
      });
    });

    // After the transaction commits, not inside it: a rolled-back transaction
    // must not leave the operator's existing shorts playable-in-name-only with
    // their files already deleted. Best-effort — an orphaned file costs disk,
    // a throw here would cost the whole regeneration.
    for (const row of previous) {
      if (row.outputPath) {
        await deleteShortFile(row.outputPath).catch(() => {});
      }
    }

    return this.list(userId, videoId);
  }

  /** Every short for a video, in play order. Ownership-scoped through the
   *  parent video, the same way every other read in this codebase is. */
  async list(userId: string, videoId: string): Promise<ShortSummary[]> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const shorts = await prisma.short.findMany({
      where: { videoId },
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        startSeconds: true,
        endSeconds: true,
        title: true,
        description: true,
        reason: true,
        status: true,
        error: true,
        outputPath: true,
      },
    });

    return shorts.map((short) => ({
      id: short.id,
      index: short.index,
      startSeconds: short.startSeconds,
      endSeconds: short.endSeconds,
      title: short.title,
      description: short.description,
      reason: short.reason,
      status: short.status,
      error: short.error,
      // Whether a file exists is deliberately derived from the column rather
      // than by stat-ing the disk once per short: this runs on every page load
      // and the panel's only use for it is deciding whether to offer a player.
      hasFile: short.outputPath !== null,
    }));
  }

  /**
   * Finds the oldest claimable short and wins it with a conditional update.
   *
   * Deliberately the same two-step shape as `JobService.claimNext`, for the
   * same reason: Prisma's `updateMany` has no `LIMIT`, so an unconditional
   * "claim the oldest queued short" would let two workers both match and both
   * believe they won the same row. Reading candidates and then winning each
   * with an update whose `where` repeats the exact state just read makes the
   * conditional update itself the lock.
   */
  async claimNext(): Promise<{ shortId: string; videoId: string; userId: string } | null> {
    const now = new Date();

    const candidates = await prisma.short.findMany({
      where: {
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          {
            status: "QUEUED",
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
          },
          // A worker that died holding this short. Its lease lapses and the
          // next worker retakes it; a lock would strand it forever.
          { status: "RENDERING", leaseExpiresAt: { lt: now } },
        ],
        // A short whose parent video has been soft-deleted must never be
        // encoded: the render it would read is on its way to being reclaimed,
        // and the operator has already said they do not want this video.
        video: { deletedAt: null },
      },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { id: true, status: true, videoId: true, video: { select: { userId: true } } },
    });

    for (const candidate of candidates) {
      const { count } = await prisma.short.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "RENDERING",
          leaseExpiresAt: new Date(Date.now() + SHORT_LEASE_SECONDS * 1000),
          attempts: { increment: 1 },
          startedAt: new Date(),
          // Cleared on every attempt so a short that fails, is retried and
          // succeeds does not keep displaying the message from the attempt
          // that failed.
          error: null,
        },
      });

      if (count === 1) {
        return {
          shortId: candidate.id,
          videoId: candidate.videoId,
          userId: candidate.video.userId,
        };
      }
    }

    return null;
  }

  /** Renews a claim's lease. Reports nothing back, unlike
   *  `JobService.heartbeat`: shorts have no cancellation flag to act on — see
   *  the `ShortStatus` comment in schema.prisma. */
  async heartbeat(shortId: string): Promise<void> {
    await prisma.short.updateMany({
      where: { id: shortId },
      data: { leaseExpiresAt: new Date(Date.now() + SHORT_LEASE_SECONDS * 1000) },
    });
  }

  /**
   * Ends a claim. The lease is cleared in every outcome — a finished short must
   * not still look claimed, and a failed one must be claimable again by the
   * next attempt, subject to `MAX_ATTEMPTS`.
   *
   * `succeeded` writes no status: `renderShort` already committed READY along
   * with the `outputPath` that makes it meaningful, in one write, so that a
   * short can never read READY with nothing to play. This only tidies the
   * lease behind it.
   */
  async release(
    shortId: string,
    outcome: "succeeded" | "failed",
    reason?: string,
  ): Promise<void> {
    if (outcome === "succeeded") {
      await prisma.short.updateMany({
        where: { id: shortId },
        data: { leaseExpiresAt: null },
      });
      return;
    }

    // Guarded on RENDERING so a late failure report cannot overwrite a short
    // that some other worker has since retaken and finished — the same "do not
    // let a stale outcome overwrite a more recent one" rule `JobService.release`
    // applies through PRE_PUBLISH_STATUSES.
    await prisma.short.updateMany({
      where: { id: shortId, status: "RENDERING" },
      data: {
        status: "FAILED",
        error: reason ?? "Short render failed",
        leaseExpiresAt: null,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Encodes one claimed short.
   *
   * Reads the parent video's finished render off local disk, cuts the stored
   * window out of it, and writes a 1080x1920 MP4 with its own rebased captions
   * burned in. One FFmpeg process, one decoder, one encoder — see
   * `buildShortArgs` for why this does not need the two-pass split a full
   * render does.
   */
  async renderShort(shortId: string, onProgress: RenderProgress = () => {}): Promise<string> {
    const short = await prisma.short.findFirst({
      where: { id: shortId },
      select: {
        id: true,
        index: true,
        startSeconds: true,
        endSeconds: true,
        status: true,
        videoId: true,
        // `status` is read only to explain a missing render: a PUBLISHED video
        // had its file reclaimed on purpose, which is a different message from a
        // render that vanished for any other reason.
        video: { select: { userId: true, status: true } },
      },
    });

    if (!short) {
      throw new NotFoundError("Short");
    }

    if (short.status !== "RENDERING") {
      throw new ConflictError(
        `Only a claimed short can be rendered. This one is ${short.status.toLowerCase()}.`,
      );
    }

    const timeline = await this.loadTimeline(short.video.userId, short.videoId);

    // `RenderJob.outputUrl` says a render exists; the disk is what decides
    // whether it still does. Checked before a temp directory is created and an
    // encoder is spawned, so the failure names the real cause rather than
    // surfacing as "ffmpeg exited with code 1".
    const renderStat = await statRenderFile(timeline.renderLocation);
    if (!renderStat) {
      // The overwhelmingly common way to reach this is publishing: publish.service
      // reclaims the local render once YouTube confirms the upload, because a
      // ~170MB file per video fills the disk and YouTube then holds the copy that
      // matters. So the operator did nothing wrong, and — importantly — cannot
      // put it right: `runPipeline` returns "video is already READY — skipped"
      // and `JobService.requeue` will not take a terminal video, so there is no
      // re-render to offer. Telling them to re-render, as this used to, sent
      // them looking for a button that does not exist and would refuse them if
      // it did.
      const published = short.video.status === "PUBLISHED";

      throw new ConflictError(
        published
          ? "This video was published, and publishing deletes the local render to " +
            "reclaim disk — so there is no file left to cut a short from. Shorts " +
            "have to be generated before a video is published."
          : "This video's render is no longer on disk, so no short can be cut " +
            "from it. Only a video that has not finished rendering can be run " +
            "again, so this one cannot be recovered.",
      );
    }

    const window: ShortWindow = {
      startSeconds: short.startSeconds,
      endSeconds: short.endSeconds,
    };
    const durationSeconds = window.endSeconds - window.startSeconds;

    const tempDir = await mkdtemp(path.join(tmpdir(), "framecast-short-"));

    try {
      // Captions for this clip alone, rebased to start at zero. `buildSrt` does
      // the word grouping and the sentence-boundary line breaks; all this side
      // supplies is a narrower alignment and a narrower line width. The line
      // width is given BOTH ways on purpose — three words is not a width, and
      // the character budget is the half that keeps a cue of long words from
      // arriving at libass wider than the safe area and coming back as a tower.
      const srtPath = path.join(tempDir, "captions.srt");
      await writeFile(
        srtPath,
        buildSrt(
          sliceAlignment(timeline.alignment, window),
          SHORT_MAX_WORDS_PER_LINE,
          SHORT_MAX_CHARS_PER_LINE,
        ),
      );

      const outputPath = path.join(tempDir, "short.mp4");
      const brand = await brandService.resolve(timeline.channelId);

      onProgress(
        `cutting ${durationSeconds.toFixed(1)}s from ${window.startSeconds.toFixed(1)}s`,
      );

      await this.runFfmpeg(
        buildShortArgs({
          // The render lives under RENDER_ROOT, and `statRenderFile` above has
          // already confined and confirmed it. Resolved the same way here.
          sourcePath: path.resolve(env.RENDER_ROOT, timeline.renderLocation),
          startSeconds: window.startSeconds,
          durationSeconds,
          srtPath,
          outputPath,
          // The channel's own caption style, adapted to a 9:16 frame — see
          // `verticalCaptionStyle` for why this is a ratio against the
          // landscape style rather than a set of absolute pixel sizes.
          captions: verticalCaptionStyle(brand.videoStyle.captions),
        }),
        durationSeconds,
        onProgress,
      );

      const outputLocation = await writeShortFile(short.id, outputPath);

      // One write, so READY and the path that makes it meaningful land
      // together. Guarded on RENDERING for the same reason `release`'s failure
      // branch is: another worker may have retaken this short after this one's
      // lease lapsed, and the loser of that race must not overwrite the winner.
      const { count } = await prisma.short.updateMany({
        where: { id: short.id, status: "RENDERING" },
        data: {
          status: "READY",
          outputPath: outputLocation,
          error: null,
          finishedAt: new Date(),
          leaseExpiresAt: null,
        },
      });

      if (count === 0) {
        throw new ConflictError("This short's status changed unexpectedly while it rendered.");
      }

      return outputLocation;
    } finally {
      // Even a one-minute clip is tens of megabytes; a leaked temp directory
      // per short fills a 40GB disk quickly.
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Spawns `ffmpeg` with an argument array — never a shell string.
   *
   * A cut-down twin of `RenderService.runFfmpeg`: no `RenderLog` writes (a
   * Short has no log relation, and its `error` column carries the tail of
   * stderr instead) and no cancellation timer (there is nothing to cancel — see
   * the `ShortStatus` comment in schema.prisma). Progress is still parsed so a
   * short reports a real percentage in the worker's log rather than going quiet
   * for the length of an encode.
   */
  private runFfmpeg(
    args: string[],
    durationSeconds: number,
    onProgress: RenderProgress,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);

      let stdoutBuffer = "";
      let lastPercent = -1;

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const [key, value] = line.split("=");
          if (key !== "out_time_ms") {
            continue;
          }
          const ms = Number(value);
          if (!Number.isFinite(ms) || durationSeconds <= 0) {
            continue;
          }
          const percent = Math.min(
            100,
            Math.max(0, Math.round((ms / 1_000_000 / durationSeconds) * 100)),
          );
          // Reported on change rather than on a timer: a short encodes in
          // seconds, so a one-second throttle would report either nothing or
          // everything depending on how fast the box is.
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(`encoding … ${percent}%`);
          }
        }
      });

      // Only the tail is kept. FFmpeg's stderr is mostly a banner, and the
      // useful part of a failure is always at the end — but an unbounded
      // buffer here would be a way for a pathological encode to grow the
      // worker's memory, which is the one thing this whole design protects.
      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_FLUSH_BYTES);
      });

      child.on("error", (error: Error) => reject(error));

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0) {
          resolve();
          return;
        }
        // Named explicitly, because the signal case is the one that matters
        // most in production: SIGKILL here is the OOM killer, and a bare
        // "exited with code null" gives nobody a clue.
        const how = signal ? `was killed by signal ${signal}` : `exited with code ${code}`;
        reject(new Error(`ffmpeg ${how}${stderrTail ? `: ${stderrTail.trim()}` : ""}`));
      });
    });
  }
}

export const shortsService = new ShortsService();
