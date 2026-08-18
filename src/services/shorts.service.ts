import "server-only";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGateway, generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import { env } from "@/config/env";
import type { ShortStatus, VideoStatus } from "@/generated/prisma/enums";
import { beatAssetPath, beatPrefix } from "@/lib/beat-storage";
import type { Alignment } from "@/lib/captions";
import { buildSrt } from "@/lib/captions";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  anchorCues,
  type AnchoredCue,
  cueWindows,
  type CueWindow,
  type ScriptCue,
} from "@/lib/script-cues";
import {
  describeSections,
  MAX_SHORT_SECONDS,
  MIN_SHORT_SECONDS,
  planShortBeatSlots,
  planShortSlots,
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
import { planStoryBeats, type StoryBeat } from "@/lib/story-beats";
import {
  describeProviderFailure,
  isRetryableProviderFailure,
  repairDoubleEncodedObject,
} from "@/lib/structured-output";
import { brandService } from "@/services/brand.service";
import { compose } from "@/services/composer";
import { MAX_ATTEMPTS } from "@/services/job.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import {
  defaultSpawner,
  type ProcessSpawner,
  type RenderProgress,
  sectionClipPath,
} from "@/services/render.service";

/**
 * Composing vertical shorts out of the footage a finished video was made from.
 *
 * ## Why the footage and not the finished file
 *
 * This used to cut a 9:16 window out of the parent's finished 16:9 render, and
 * that was a bug you could see. The assemble pass burns the landscape captions
 * INTO the render's pixels (`buildAssembleArgs`), and the centre crop a short
 * takes keeps the bottom of the frame — so every short arrived with the
 * landscape captions already in the picture, and then had its own vertical ones
 * drawn on top of them. Two sets of subtitles, and the first set could not be
 * turned off, moved or restyled, because it was not a layer. It was the image.
 *
 * The fix is to go back one step. `videos/{id}/clips/section-NNN.mp4` is the
 * footage the render itself played, it has never had text drawn on it, and it
 * is still in storage for any video that has not been published. Composing the
 * short out of those clips at 1080x1920 (`composer.ts`, the same code the full
 * render uses) gives a clip whose only captions are its own — and gives a
 * better picture besides, since each clip is centre-cropped from the SOURCE
 * rather than from a landscape frame that was already cropped for a different
 * shape and is then upscaled 1.78x.
 *
 * The alternative was keeping a caption-free master beside every render and
 * burning captions into a separate deliverable: about 170MB per video on a
 * 40GB disk, plus a second full-length encode on a 2-vCPU box, paid by every
 * video whether or not a short is ever cut from it. This way a video that has
 * no shorts costs exactly what it always did — the landscape render's argv and
 * its output are unchanged — and only a video that actually gets a short pays,
 * once, for that short.
 *
 * ## Not every video's footage is a section clip
 *
 * A generated video — `ILLUSTRATED`, `CINEMATIC` or `MIXED` — has no
 * `clips/section-NNN.mp4` at all. Its pictures are one per story *beat*, filed
 * under `beats/` as a drawn `.png` or, for a beat its script tagged `motion`, a
 * downloaded `.mp4`; a beat covers one or more consecutive sections. Asking for
 * section clips on one of those found nothing and refused every short on every
 * generated video with a message about reclaimed storage, which described a
 * state the video was never in. So the two questions this file asks about
 * footage — which files, and which of them fills each slot — are both asked per
 * *picture unit* now, and a picture unit is a section or a beat depending on
 * what collection actually put on disk (`requireFootage`).
 *
 * Nothing about composing changes with it. `planRender` opens a `.png` with
 * `-loop 1` and an `.mp4` with `-stream_loop -1` from the extension alone, so a
 * short cut from stills goes through the identical two passes a stock one does.
 *
 * ## Two halves that never run at the same time
 *
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

/**
 * The shortest a section's clip may hold the screen inside a short.
 *
 * The counterpart of `MIN_CLIP_SECONDS` in render.service.ts, and it guards the
 * same thing from the other direction: a window clipped by `MAX_SHORT_SECONDS`
 * routinely lands a fraction of a second into a section, and a 0.2s slot is
 * both a visible flicker and something `planRender` refuses outright when
 * transitions are on. `planShortSlots` merges anything under this into its
 * neighbour, so the picture simply holds a moment longer.
 */
const MIN_SLOT_SECONDS = 1;

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
  /** The same cues `windows` was built from, index-aligned with it. Carried
   *  alongside because `planStoryBeats` groups *cues*, not windows, and a
   *  beat-collected video's picture plan is that grouping. */
  anchored: AnchoredCue[];
  sections: string;
  alignment: Alignment;
  narrationSeconds: number;
  /** The narration MP3's storage path. A short reads a WINDOW of it — the same
   *  file the full render reads from beginning to end. */
  narrationPath: string;
  channelId: string | null;
  /** Only so missing footage can say *why* it is missing. A PUBLISHED video's
   *  clips were reclaimed on purpose; any other video's went missing. */
  videoStatus: VideoStatus;
}

/**
 * The pictures a short plays, and what one of them counts as.
 *
 * Two shapes behind one type, because everything downstream of the guard treats
 * them identically: `paths[slot.sectionIndex]` is the file to fetch either way,
 * and `planRender` decides whether to open it with `-loop 1` or `-stream_loop`
 * from its extension alone. The only thing the caller has to branch on is which
 * planner turns its window into slots.
 */
interface ShortFootage {
  /** One storage path per picture unit, in play order — a section clip per
   *  section, or a beat's still-or-clip per beat. */
  paths: string[];
  /** The beats those paths belong to, or null for a section-collected video.
   *  Non-null is the signal to plan slots over beats rather than sections; it
   *  is not merely informational. */
  beats: StoryBeat[] | null;
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
        format: true,
        project: { select: { channelId: true } },
        voiceOver: { select: { durationSeconds: true, audioUrl: true } },
        script: { select: { activeVersion: { select: { content: true, cues: true } } } },
        // Not the render's `outputUrl` any more — nothing here reads that file.
        // Only that a render SUCCEEDED, which is what says the footage, the
        // narration and the alignment below all agree with each other and with
        // a video the operator has actually watched.
        renderJobs: {
          where: { status: "SUCCEEDED", outputUrl: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // READY or PUBLISHED, and PUBLISHED matters because a live video is the one
    // an operator is most likely to want clips from. Whether one can still be
    // made is a separate question — see `requireFootage`, which is where
    // publishing's reclaim is felt.
    if (video.status !== "READY" && video.status !== "PUBLISHED") {
      throw new ConflictError(
        `Shorts are cut out of a finished video. This one is ${video.status.toLowerCase()}.`,
      );
    }

    // A short IS a vertical video, so there is nothing to cut: the parent
    // already is the thing this feature makes. Refused here rather than in the
    // panel alone, because `generate` spends a model call and deletes the
    // existing set before it writes a new one.
    if (video.format === "VERTICAL") {
      throw new ConflictError(
        "This video is already a vertical short — there is nothing to cut a " +
          "short out of. Publish it as it is, or make a full-length video if " +
          "you want clips from it.",
      );
    }

    if (video.renderJobs.length === 0) {
      throw new ConflictError("This video has no completed render to cut shorts from.");
    }

    const narrationSeconds = video.voiceOver?.durationSeconds;
    const narrationPath = video.voiceOver?.audioUrl;
    if (narrationSeconds == null || !narrationPath) {
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
      anchored,
      sections: describeSections(anchored, windows, content),
      alignment,
      narrationSeconds,
      narrationPath,
      videoStatus: video.status,
      channelId: video.project?.channelId ?? null,
    };
  }

  /**
   * The pictures a short is composed out of, or a `ConflictError` naming why
   * they are not there.
   *
   * This replaces the old `statRenderFile` check, and it is the same guard
   * moved one step upstream: what a short needs on disk is no longer the
   * finished render but the footage that render played. Both `generate` and
   * `renderShort` call it, and `generate` calls it BEFORE the model call and
   * before it deletes the operator's existing set — the sequence that once
   * destroyed three good shorts to arrive at a message we could have given
   * first.
   *
   * Which of the two shapes a video has is decided by what is on disk, exactly
   * as `RenderService.render` decides it and for the same reason: a channel's
   * `footageStyle` can be changed at any time, including after this video's
   * footage was collected, and what a short must be composed from is the
   * footage this video actually has rather than the footage the channel would
   * collect today. Anything under `beats/` means beats; nothing there means
   * sections, which is every stock video ever rendered.
   */
  private async requireFootage(
    videoId: string,
    timeline: VideoTimeline,
  ): Promise<ShortFootage> {
    // Both kinds, because a MIXED video's motion slots are `.mp4` filed under
    // the same prefix as its stills (see `beatClipPath`). The prefix is what
    // makes this answerable at all: `kind: "IMAGE"` under `videos/{id}/` would
    // also match every thumbnail the video has ever had.
    const beatAssets = await prisma.asset.findMany({
      where: {
        kind: { in: ["IMAGE", "VIDEO"] },
        deletedAt: null,
        storagePath: { startsWith: beatPrefix(videoId) },
      },
      select: { storagePath: true },
    });

    if (beatAssets.length === 0) {
      const paths = await this.requireSectionClips(
        videoId,
        timeline.windows.length,
        timeline.videoStatus,
      );

      return { paths, beats: null };
    }

    const present = new Set(beatAssets.map((asset) => asset.storagePath));

    return this.requireBeatPictures(videoId, timeline, present);
  }

  /**
   * The beat pictures a generated video's short is composed out of.
   *
   * Re-derived here rather than read from a stored plan, exactly as
   * `RenderService.render` re-derives it: `planStoryBeats` is pure over the
   * anchored cues and the narration's length, both of which collection also
   * had, so the beats a short cuts across are the beats collection drew. A
   * stored grouping is the one thing that could drift from the script and put
   * a picture under words it was not drawn for.
   *
   * Every beat is required, not merely some — the same rule the section half
   * applies, for the same reason. A hole would compose fine and play the wrong
   * picture under the wrong words from that beat onward.
   *
   * Note what this deliberately does NOT say when a beat is missing.
   * Publishing cannot be the cause: `reclaimClipStorage` filters on the
   * `videos/{id}/clips/` prefix as well as on `kind: "VIDEO"`, so it never
   * reaches `beats/` — not even a MIXED video's stock beats, which match the
   * kind but not the prefix. The prefix is the only thing sparing them, which
   * is one edit away from being false, so it is written down here rather than
   * left to be rediscovered. A missing beat means collection never drew it,
   * and collecting again is a real remedy — unlike a reclaimed clip, which is
   * gone for good and whose message must not be borrowed for this.
   */
  private async requireBeatPictures(
    videoId: string,
    timeline: VideoTimeline,
    present: ReadonlySet<string>,
  ): Promise<ShortFootage> {
    const beats = planStoryBeats(timeline.anchored, timeline.narrationSeconds);
    const paths = beats.map((_beat, index) => beatAssetPath(present, videoId, index));
    const missing = paths
      .map((assetPath, index) => ({ assetPath, index }))
      .filter((entry) => entry.assetPath === null)
      .map((entry) => entry.index + 1);

    if (missing.length > 0) {
      throw new ConflictError(
        `No picture for beat(s) ${missing.join(", ")} of ${paths.length}, so no ` +
          "short can be composed from this video. Collect footage again — it " +
          "redraws only the beats that have none — and generate the shorts " +
          "after that.",
      );
    }

    return {
      paths: paths.filter((assetPath): assetPath is string => assetPath !== null),
      beats,
    };
  }

  /**
   * The section clips a stock-footage video's short is composed out of.
   *
   * Every section is required, not merely some. A short is a contiguous run of
   * sections, and a run with a hole in it would compose fine and play the
   * wrong footage under the wrong words from the hole onward — the same
   * failure `RenderService.render` refuses a partially-collected video for.
   */
  private async requireSectionClips(
    videoId: string,
    sectionCount: number,
    videoStatus: VideoStatus,
  ): Promise<string[]> {
    const wanted = Array.from({ length: sectionCount }, (_unused, index) =>
      sectionClipPath(videoId, index),
    );

    const present = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { in: wanted },
      },
      select: { storagePath: true },
    });

    if (present.length === wanted.length) {
      return wanted;
    }

    // Publishing is the overwhelmingly common way to get here:
    // `publish.service.ts` reclaims `videos/{id}/clips/` once YouTube confirms
    // the upload, because the clips are dead weight on a 40GB disk from that
    // moment on. The operator did nothing wrong and — as with the render —
    // cannot put it right, so the message says when shorts have to be made
    // rather than suggesting a recovery that does not exist.
    throw new ConflictError(
      videoStatus === "PUBLISHED"
        ? "This video was published, and publishing reclaims the footage it was " +
          "composed from — so there is nothing left to build a short out of. " +
          "Shorts have to be generated before a video is published."
        : "This video's footage is no longer in storage, so no short can be " +
          "composed from it. Only a video that has not finished rendering can " +
          "be run again, so this one cannot be recovered.",
    );
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

    // The footage has to exist before anything here is destructive, because
    // everything after this line is: the model call costs money, and the write
    // below hard-deletes the video's existing shorts to replace them.
    //
    // This was found the expensive way. An operator published a video — which
    // reclaims its storage on purpose — and then pressed Generate. The three
    // READY shorts they already had were deleted, three replacements were
    // created, and all three failed two seconds later against files that no
    // longer existed. Every individual step behaved as designed; the sequence
    // destroyed good work to arrive at a message we could have given first.
    //
    // Checked here rather than only in `renderShort`, which also checks: by the
    // time the worker gets there the deletion has already happened.
    await this.requireFootage(videoId, timeline);

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
   * Composes one claimed short.
   *
   * Downloads the section clips the parent video's window plays, normalises
   * each into a 1080x1920 frame, joins them, mixes the narration window under
   * the same music bed the parent used, and burns the clip's own rebased
   * captions in. Exactly the pipeline a full render runs (`composer.ts`), on a
   * minute of material instead of nine.
   *
   * What it deliberately does NOT read is the parent's finished MP4. That file
   * has the landscape captions burned into it — see this class's own doc
   * comment for the two-caption bug that came of cropping it.
   *
   * Memory is unchanged from the single-pass version it replaces: the two-pass
   * split exists precisely so that no more than one decoder and one encoder are
   * ever open at once, whatever the clip count (see ffmpeg-command.ts). A short
   * spans a handful of sections, so this is a handful of short encodes plus one
   * assemble, all sequential, all bounded by the same `-threads` caps.
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
        // The owner alone: `loadTimeline` below re-reads the video anyway, and
        // it is what carries the status the footage guard explains itself with.
        video: { select: { userId: true } },
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

    // Checked before a temp directory is created and an encoder is spawned, so
    // the failure names the real cause rather than surfacing as "ffmpeg exited
    // with code 1" against a clip path that does not exist.
    const footage = await this.requireFootage(short.videoId, timeline);

    const window: ShortWindow = {
      startSeconds: short.startSeconds,
      endSeconds: short.endSeconds,
    };
    const durationSeconds = window.endSeconds - window.startSeconds;
    const brand = await brandService.resolve(timeline.channelId);
    const style = brand.videoStyle;

    // The same floor the full render applies, for the same reason: a slot has
    // to outlast the crossfade it donates its tail to or `planRender` refuses
    // the plan. Derived from the style rather than hard-coded so raising the
    // transition duration cannot quietly invalidate it.
    const minClipSeconds = Math.max(
      MIN_SLOT_SECONDS,
      style.transitions.enabled ? style.transitions.durationSeconds * 2 : 0,
    );
    // One slot per picture unit the window covers — sections for a stock video,
    // beats for a generated one. The merge logic is the same either way (see
    // `planShortBeatSlots`); only what a slot counts differs, and `footage`
    // already decided that by looking at what is on disk.
    const slots = footage.beats
      ? planShortBeatSlots(timeline.windows, footage.beats, window, minClipSeconds)
      : planShortSlots(timeline.windows, window, minClipSeconds);

    if (slots.length === 0) {
      // Not reachable from a window `planShortWindow` produced — it only ever
      // returns a range inside the narration — but a Short row is durable and
      // its script's cues are not, so a re-anchoring that moved every section
      // clear of this window must fail with a sentence rather than an empty
      // concat list.
      throw new ConflictError(
        "None of this script's sections fall inside this short's window any " +
          "more, so there is no footage to compose it from. Generate the set " +
          "again.",
      );
    }

    const tempDir = await mkdtemp(path.join(tmpdir(), "framecast-short-"));

    try {
      onProgress(
        `composing ${durationSeconds.toFixed(1)}s from ${slots.length} ` +
          `${footage.beats ? "beat(s)" : "section(s)"} starting at ` +
          `${window.startSeconds.toFixed(1)}s`,
      );

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

      const narrationPath = path.join(
        tempDir,
        `narration${path.extname(timeline.narrationPath) || ".mp3"}`,
      );
      await writeFile(narrationPath, await getObject(timeline.narrationPath));

      const clipPaths: string[] = [];
      for (const [index, slot] of slots.entries()) {
        const sourcePath = footage.paths[slot.sectionIndex];
        // The source's own extension, not a hard-coded `.mp4`, and it is
        // load-bearing rather than tidiness: `planRender` asks
        // `isStillImagePath` of every path it is given and opens a `.png` with
        // `-loop 1` instead of `-stream_loop -1`. A beat's still copied to
        // `clip-0.mp4` would be opened as video and produce a single frame
        // holding a twenty-second slot — a short that is one still frame and
        // then black.
        const clipPath = path.join(
          tempDir,
          `clip-${index}${path.extname(sourcePath) || ".mp4"}`,
        );
        await writeFile(clipPath, await getObject(sourcePath));
        clipPaths.push(clipPath);
      }

      // The bed the parent video was rendered with, reused rather than
      // re-searched: `MusicService.collect` would return this same asset for a
      // video that already has one, and going through it would let a video
      // whose track was deleted quietly fetch a DIFFERENT one — so a short
      // would have music its own parent does not. Absent is fine; the mix
      // simply has no bed, exactly as the render's does not.
      const musicAsset = await prisma.asset.findFirst({
        where: {
          kind: "MUSIC",
          deletedAt: null,
          storagePath: { startsWith: `videos/${short.videoId}/` },
        },
        orderBy: { createdAt: "desc" },
        select: { storagePath: true },
      });

      let musicPath: string | undefined;
      if (musicAsset) {
        musicPath = path.join(tempDir, "music.mp3");
        await writeFile(musicPath, await getObject(musicAsset.storagePath));
      }

      const outputPath = path.join(tempDir, "short.mp4");

      await compose(
        {
          tempDir,
          clipPaths,
          clipSeconds: slots.map((slot) => slot.seconds),
          style,
          format: "VERTICAL",
          audioPath: narrationPath,
          // The window is a run of sentences out of the middle of the
          // narration, so the mix starts there. The SRT above is rebased to
          // zero by `sliceAlignment` for exactly the same reason.
          audioStartSeconds: window.startSeconds,
          durationSeconds,
          srtPath,
          // The channel's own caption style, adapted to a 9:16 frame — see
          // `verticalCaptionStyle` for why this is a ratio against the
          // landscape style rather than a set of absolute pixel sizes. The
          // geometry is unchanged by this rewrite: same margins, same marginV
          // floor, same boost, same line widths.
          captions: verticalCaptionStyle(style.captions),
          musicPath,
          outputPath,
        },
        {
          runFfmpeg: (args, runDurationSeconds, report) =>
            this.runFfmpeg(args, runDurationSeconds, report),
          onProgress,
        },
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
    /** null for the runs whose length is fixed and short — the per-section
     *  segments, the crossfade stubs, the effects track. Same convention
     *  `RenderService.runFfmpeg` uses, and the reason is the same: 0 would
     *  divide by zero and report a finished-looking percentage. */
    durationSeconds: number | null,
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
          if (!Number.isFinite(ms) || durationSeconds === null || durationSeconds <= 0) {
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
