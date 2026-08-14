import "server-only";

import type { Alignment } from "@/lib/captions";
import { ConflictError, NotFoundError, ProviderError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { anchorCues, cueWindows, type ScriptCue, sectionDurations } from "@/lib/script-cues";
import { statRenderFile } from "@/lib/render-storage";
import { getObject, putObject, storagePath } from "@/lib/storage";
import type { TransitionStyle } from "@/lib/video-style";
import { brandService } from "@/services/brand.service";
import { MAX_ATTEMPTS } from "@/services/job.service";
import {
  pexelsProvider,
  pixabayProvider,
} from "@/services/providers/stock-footage.provider";
import type {
  StockClip,
  StockFootageProvider,
  StockFootageSource,
} from "@/services/providers/types";
import type { VideoStatus } from "@/generated/prisma/enums";

/**
 * The shortest slot any clip may hold the screen for.
 *
 * A copy of `MIN_CLIP_SECONDS` in render.service.ts, which is not exported.
 * Copying a constant is normally the wrong answer; here the alternative is
 * worse. This service exists to show an operator where each section lands in
 * the finished video, and `sectionDurations` takes the floor as an argument —
 * so a timeline computed with a *different* floor would draw section
 * boundaries that are subtly not the ones FFmpeg was given, which is exactly
 * the "looks fine, is wrong" failure the render pipeline's own comments keep
 * warning about. Duplicating the number with a test that pins it (see
 * timeline.service.test.ts) at least makes a future divergence a failing test
 * rather than a silently mistimed picture. If render.service.ts ever changes
 * its floor, this must move with it.
 */
const MIN_CLIP_SECONDS = 1;

/**
 * How many clips an *uncued* video may play. The same copy-with-a-reason as
 * `MIN_CLIP_SECONDS` above: `MAX_RENDER_CLIPS` is private to render.service.ts,
 * and a pool timeline that showed thirteen blocks when the render only ever
 * plays twelve would be describing a video that does not exist.
 */
const MAX_POOL_CLIPS = 12;

/** How many candidates a footage search asks each provider for. Wide enough
 *  that duration/size filtering (stock-footage.provider.ts drops anything
 *  outside its band) still leaves a page worth choosing from, small enough
 *  that a swap costs one ordinary search against Pexels' 200-an-hour quota. */
const SEARCH_CANDIDATE_COUNT = 12;

/** Pixabay's hard cap on search terms, applied to the one query both sources
 *  share — same rule footage.service.ts applies for the same reason. */
const QUERY_MAX_LENGTH = 100;

/** The path FootageService stores section `index`'s clip at, and therefore the
 *  path render.service.ts reads it back from. Zero-padded to three digits so
 *  the sequence sorts lexicographically. Repeated here rather than imported
 *  because it is private to both of those services; the format is pinned by a
 *  test for the same reason the constants above are. */
export function sectionClipPath(videoId: string, index: number): string {
  return storagePath(videoId, "clips", `section-${String(index).padStart(3, "0")}.mp4`);
}

const SECTION_CLIP_PATTERN = /\/clips\/section-(\d+)\.mp4$/;

export interface TimelineClip {
  /** PEXELS / PIXABAY. Null for a clip stored before the column existed. */
  provider: string | null;
  externalId: string | null;
  sizeBytes: number | null;
  /**
   * Other sections playing this exact clip. FootageService fills a section
   * that found nothing of its own by copying its nearest neighbour's footage
   * (see `nearestAssignedIndex`), so a repeat here is not a bug — it is the
   * fallback showing through, and it is the strongest available signal that a
   * section's picture was never matched to its own words.
   */
  alsoUsedBySections: number[];
}

export interface TimelineSection {
  index: number;
  /** The stock-footage search query this section's clip was chosen for. */
  cue: string;
  /** The narration spoken across this section, verbatim. */
  narration: string;
  /** Where this section begins in the finished render. */
  startSeconds: number;
  durationSeconds: number;
  clip: TimelineClip | null;
  /**
   * Cues that no longer anchor anywhere in the current script, whose narration
   * this section therefore absorbed. `anchorCues` runs each section to the
   * start of the *next surviving* one, so an orphan does not leave a hole —
   * it silently lengthens its predecessor, and that predecessor's single clip
   * now plays under words it was never chosen for.
   */
  absorbedOrphanCues: string[];
}

/** A block of an uncued video's timeline: one pooled clip, an equal share. */
export interface TimelineBlock {
  index: number;
  startSeconds: number;
  durationSeconds: number;
  /** How much of this block is actually seen. See `planPoolBlocks`. */
  visibleSeconds: number;
  clip: TimelineClip;
}

export type TimelineMode = "sections" | "pool" | "empty";

export interface RerunAvailability {
  available: boolean;
  /** Which control on the Pipeline tab does it — never a new entry point. */
  control: "run" | "retry" | null;
  /** Said to the operator verbatim. */
  reason: string;
}

export interface VideoTimeline {
  videoId: string;
  status: VideoStatus;
  mode: TimelineMode;
  /** The narration's length, which is also the finished render's: the
   *  assemble pass cuts the output at exactly this (`-t`). Null before
   *  narration exists, in which case there is no timeline at all. */
  durationSeconds: number | null;
  sections: TimelineSection[];
  blocks: TimelineBlock[];
  /** Playable render, or null when there is no successful render on disk. */
  renderUrl: string | null;
  /** Cues in the active script that anchor nowhere. Reported at the video
   *  level too because an orphan *before* the first surviving cue belongs to
   *  no section at all. */
  orphanedCueCount: number;
  /** True once publishing has deleted this video's clips (see
   *  `reclaimClipStorage` in publish.service.ts). */
  clipsReclaimed: boolean;
  /** Cues exist and some — but not all — sections have a clip. render.service
   *  refuses this outright rather than shipping a mistimed video. */
  footageIncomplete: boolean;
  rerun: RerunAvailability;
  /** Why footage cannot be swapped right now, or null when it can. */
  swapBlockedReason: string | null;
  /** Why there is no timeline, when `mode` is "empty". */
  emptyReason: string | null;
}

export interface FootageOption {
  source: StockFootageSource;
  externalId: string;
  url: string;
  width: number;
  height: number;
  durationSeconds: number;
  /** Set when this exact clip already plays under another section of this
   *  video, so an operator does not repeat a picture without meaning to. */
  alreadyUsedBySection: number | null;
}

/**
 * The floor render.service.ts hands `sectionDurations`.
 *
 * Derived from the style rather than hard-coded, exactly as render.service.ts
 * derives it: a slot has to outlast the crossfade it donates its tail to, and
 * the doubling is what keeps the slot something a viewer sees rather than one
 * continuous dissolve. Reading it off the same `TransitionStyle` the render
 * resolves means raising the transition duration moves both together.
 */
export function minClipSecondsFor(transitions: TransitionStyle): number {
  return Math.max(
    MIN_CLIP_SECONDS,
    transitions.enabled ? transitions.durationSeconds * 2 : 0,
  );
}

export interface SectionPlan {
  index: number;
  cue: string;
  narration: string;
  startSeconds: number;
  durationSeconds: number;
  absorbedOrphanCues: string[];
}

export interface SectionPlanResult {
  sections: SectionPlan[];
  orphanedCueCount: number;
  /** Orphans that anchor before any surviving cue, so no section absorbed
   *  them — their narration plays under whatever the *first* section shows. */
  leadingOrphanCues: string[];
}

/**
 * Where each script section lands in the finished video.
 *
 * This is the one piece of arithmetic that has to be right, so it is worth
 * saying exactly why these numbers are the render's own and not a second,
 * parallel guess at them.
 *
 * `render.service.ts` computes the length of each clip's slot as
 *
 *     sectionDurations(
 *       cueWindows(anchorCues(cues, content.trim()).anchored, alignment)
 *         .map((window) => window.startSeconds),
 *       durationSeconds,
 *       minClipSeconds,
 *     )
 *
 * and this function calls the identical expression on the identical inputs —
 * the active version's `cues` and `content`, the alignment ElevenLabs
 * returned, `VoiceOver.durationSeconds`, and the floor derived from the same
 * channel's `TransitionStyle`. Nothing here re-derives timing a second way;
 * every second below comes out of `src/lib/script-cues.ts`.
 *
 * The `.trim()` is load-bearing and is the invariant the whole model rests on:
 * `voiceover.service.ts` sends `content.trim()` to ElevenLabs verbatim, so the
 * alignment's character indices *are* indices into the trimmed content.
 * Anchoring against the untrimmed string shifts every offset by whatever
 * leading whitespace the content happens to carry, and each shifted character
 * is a tenth of a second of drift between this timeline and the video.
 *
 * Turning slot *lengths* into on-screen *positions* is a plain running sum,
 * and that is exact rather than approximate — a fact that is not obvious,
 * because the render interleaves crossfade stubs between the segments. Walk
 * `planRender` in ffmpeg-command.ts with an overlap of `v`: every segment but
 * the last is generated `v` longer than its slot, the concat demuxer then
 * drops `v` from the head of every entry after the first and `v` from the tail
 * of every entry before the last, and a `v`-long stub is played at each
 * boundary. Slot `0` therefore plays `d0`, then a stub of `v`, then slot `1`
 * plays `d1 - v`, and so on: the k-th section's picture begins at exactly
 * `d0 + ... + d(k-1)`, with the crossfade into it straddling that instant. A
 * boundary whose stub failed to build is identical in length — render.service
 * gives that segment its tail back instead (`outpoint: undefined`), which is
 * the same `v` of screen time as a hard cut rather than a dissolve — so the
 * positions below hold whether or not every transition encoded.
 *
 * And the total is exact too: `sectionDurations` pins both ends and only ever
 * moves boundaries between them, so the slots sum to `durationSeconds`, which
 * is precisely what the assemble pass cuts the output to.
 *
 * Pure and exported so all of the above can be tested without a database, a
 * storage root, or a fake FFmpeg in the way — the same reason
 * `sectionDurations` itself lives in `lib/`.
 */
export function planSections(args: {
  cues: ScriptCue[];
  /** The active version's `content`, exactly as stored. Trimmed here. */
  content: string;
  alignment: Alignment;
  durationSeconds: number;
  minClipSeconds: number;
}): SectionPlanResult {
  const { cues, alignment, durationSeconds, minClipSeconds } = args;
  const content = args.content.trim();

  const { anchored, orphaned } = anchorCues(cues, content);

  if (anchored.length === 0) {
    return {
      sections: [],
      orphanedCueCount: orphaned.length,
      leadingOrphanCues: orphaned.map((cue) => cue.cue),
    };
  }

  const windows = cueWindows(anchored, alignment);
  const durations = sectionDurations(
    windows.map((window) => window.startSeconds),
    durationSeconds,
    minClipSeconds,
  );

  // Which surviving section swallowed each orphan's narration.
  //
  // `anchorCues` pushes the caller's own cue objects into `orphaned`, so
  // identity is enough to replay its partition of the input in order — no
  // second copy of its ordered-indexOf search, which would be free to drift
  // from the real one. Everything before the first survivor belongs to no
  // section: `sectionDurations` stretches the first slot back to 0, so those
  // words play under section one's clip without lengthening it.
  const orphanedSet = new Set<ScriptCue>(orphaned);
  const absorbed: string[][] = anchored.map(() => []);
  const leadingOrphanCues: string[] = [];
  let survivorIndex = -1;

  for (const cue of cues) {
    if (!orphanedSet.has(cue)) {
      survivorIndex++;
      continue;
    }

    if (survivorIndex < 0) {
      leadingOrphanCues.push(cue.cue);
      continue;
    }

    absorbed[survivorIndex].push(cue.cue);
  }

  let elapsed = 0;
  const sections = anchored.map((entry, index) => {
    const startSeconds = elapsed;
    elapsed += durations[index];

    return {
      index,
      cue: entry.cue,
      // The same slice `script.service.ts`'s `saveEdit` re-anchors from, so
      // the text shown under a section is the text its cue was matched to.
      narration: content.slice(entry.startChar, entry.endChar).trim(),
      startSeconds,
      durationSeconds: durations[index],
      absorbedOrphanCues: absorbed[index],
    };
  });

  return { sections, orphanedCueCount: orphaned.length, leadingOrphanCues };
}

/**
 * An uncued video's timeline: an equal share of the narration per pooled clip.
 *
 * Mirrors render.service.ts's `else` branch, clamp and all, and the clamp is
 * the reason `visibleSeconds` exists. Where a cued video's slots are pinned to
 * sum to the narration exactly, these are `max(minClipSeconds, duration /
 * count)` each — so a narration too short to give every clip the floor
 * produces slots that overshoot, and the assemble pass's `-t durationSeconds`
 * simply cuts the tail off. Blocks past the end are therefore never seen, and
 * the last surviving one is seen only in part. Drawing them at full width
 * would show an operator a minute of video that does not exist.
 */
export function planPoolBlocks(args: {
  clipCount: number;
  durationSeconds: number;
  minClipSeconds: number;
}): { startSeconds: number; durationSeconds: number; visibleSeconds: number }[] {
  const { clipCount, durationSeconds, minClipSeconds } = args;
  const share = Math.max(minClipSeconds, durationSeconds / Math.max(1, clipCount));

  return Array.from({ length: clipCount }, (_unused, index) => {
    const startSeconds = share * index;

    return {
      startSeconds,
      durationSeconds: share,
      visibleSeconds: Math.max(0, Math.min(share, durationSeconds - startSeconds)),
    };
  });
}

/**
 * Whether this video can be rendered again, and through which existing
 * control — never a new one.
 *
 * Two independent gates decide this, and both have to pass, which is why this
 * cannot be inferred from `status` alone:
 *
 *   - `JobService.requeue` accepts only an idle `QUEUED` video, a `FAILED` one
 *     with attempts left, or a `GENERATING`/`RENDERING` one whose worker died
 *     (a lapsed lease). Everything else it refuses outright.
 *   - `runPipeline` skips the render stage entirely for a video that is
 *     already `READY` ("video is already READY — skipped"), so even a video
 *     that could be re-queued would not re-encode.
 *
 * The consequence worth stating plainly, because the timeline UI has to say it
 * out loud: **a finished (`READY`) or published video cannot be re-rendered
 * from this app at all.** Not "not yet" — there is no entry point, and
 * inventing one is out of scope here. The useful window for an edit is a video
 * that has footage but has not successfully rendered yet: one that failed, one
 * waiting in the queue, or one a dead worker stranded.
 */
export function rerunAvailability(video: {
  status: VideoStatus;
  attempts: number;
  leaseExpiresAt: Date | null;
}, now: Date): RerunAvailability {
  const { status, attempts, leaseExpiresAt } = video;

  if (status === "DRAFT") {
    return {
      available: false,
      control: null,
      reason: "This video has not been approved yet, so nothing has rendered.",
    };
  }

  if (status === "QUEUED") {
    return {
      available: true,
      control: "run",
      reason: "Queued — the next run picks up any change made here.",
    };
  }

  if (status === "GENERATING" || status === "RENDERING") {
    // A live lease means a worker is holding this video *right now* and may
    // be part-way through downloading its clips. Anything written underneath
    // it lands in an unpredictable half of the render.
    if (leaseExpiresAt !== null && leaseExpiresAt > now) {
      return {
        available: false,
        control: null,
        reason:
          "A worker is rendering this video right now. Wait for it to finish, or cancel " +
          "it from the Pipeline tab, before changing anything.",
      };
    }

    return {
      available: true,
      control: "run",
      reason:
        "This video was stranded by a worker that stopped. Run it again from the " +
        "Pipeline tab and it re-renders from where it left off.",
    };
  }

  if (status === "FAILED") {
    if (attempts >= MAX_ATTEMPTS) {
      return {
        available: false,
        control: null,
        reason:
          `This video has failed ${attempts} times, the maximum the queue allows. ` +
          "It will not run again until the underlying problem is fixed.",
      };
    }

    return {
      available: true,
      control: "retry",
      reason: "Retry on the Pipeline tab re-renders this video with the change.",
    };
  }

  if (status === "PUBLISHED") {
    return {
      available: false,
      control: null,
      reason:
        "This video is on YouTube and its source clips were deleted after upload. " +
        "Nothing here can change it.",
    };
  }

  return {
    available: false,
    control: null,
    reason:
      "This video has already rendered. The pipeline skips the render stage for a " +
      "finished video, so there is no way to re-render it from here — the timeline " +
      "below is a view of what was made, not an editor for it.",
  };
}

/** Round-robins two providers' results, Pexels first each round — the same
 *  alternation footage.service.ts uses so one provider's stock look never
 *  dominates the choices offered. */
function alternate(pexels: StockClip[], pixabay: StockClip[]): StockClip[] {
  const merged: StockClip[] = [];

  for (let i = 0; i < Math.max(pexels.length, pixabay.length); i++) {
    if (i < pexels.length) merged.push(pexels[i]);
    if (i < pixabay.length) merged.push(pixabay[i]);
  }

  return merged;
}

/**
 * Downloads a clip the *provider* named.
 *
 * Deliberately private to a URL that came out of a `StockFootageProvider`
 * search in this same process, never one posted by the browser. `swapFootage`
 * re-runs the operator's own search server-side and matches on `externalId`
 * for exactly this reason: a `url` parameter taken from a client would make
 * this a server-side request forgery primitive pointed at whatever the caller
 * liked, and no amount of host allow-listing is as simple to be sure of as
 * never accepting the URL in the first place.
 *
 * Not reused from footage.service.ts because its `fetchClip` is module-private
 * and its injectable `ClipDownloader` seam has no accessor — there is no way
 * to reach the real one from outside. The search clients are what matter and
 * those *are* reused (`pexelsProvider` / `pixabayProvider` above); this is one
 * `fetch` of a URL those clients returned.
 */
async function downloadClip(clip: StockClip): Promise<Buffer> {
  let response: Response;

  try {
    response = await fetch(clip.url);
  } catch (cause) {
    throw new ProviderError(
      clip.source,
      `Could not download clip ${clip.externalId} from ${clip.source}.`,
      true,
      { cause },
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      clip.source,
      `Downloading clip ${clip.externalId} from ${clip.source} failed with ` +
        `status ${response.status} ${response.statusText}.`,
      response.status === 429 || response.status >= 500,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

export interface FootageProviders {
  PEXELS: StockFootageProvider;
  PIXABAY: StockFootageProvider;
}

export class TimelineService {
  constructor(
    /** Same injection shape footage.service.ts uses, so a test can observe
     *  what was searched for without a live Pexels account. */
    private readonly providers: FootageProviders = {
      PEXELS: pexelsProvider,
      PIXABAY: pixabayProvider,
    },
    private readonly download: (clip: StockClip) => Promise<Buffer> = downloadClip,
  ) {}

  /**
   * Everything the timeline view shows for one video.
   *
   * Scoped through `video: { userId, deletedAt: null }` at every step, as the
   * studio services are: none of these rows carry a `userId` of their own, and
   * `Asset` does not even carry a `videoId` — its storage prefix is the
   * scoping key (see the comment on the model in schema.prisma).
   */
  async get(userId: string, videoId: string): Promise<VideoTimeline> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        attempts: true,
        leaseExpiresAt: true,
        project: { select: { channelId: true } },
        voiceOver: { select: { durationSeconds: true } },
        // Only the active version, for the reason render.service.ts and
        // footage.service.ts both give: an edit that moves a section boundary
        // makes every earlier version's cues meaningless, and the surviving
        // ones are re-anchored onto whichever version is active.
        script: { select: { activeVersion: { select: { content: true, cues: true } } } },
        renderJobs: {
          where: { status: "SUCCEEDED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { outputUrl: true },
        },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const rerun = rerunAvailability(video, new Date());

    // The player points at this app's own streaming route, resolved from the
    // video id server-side — never a storage path handed to the browser. The
    // `stat` is what tells a published video (whose render was reclaimed)
    // apart from one that still has a file to play.
    const outputUrl = video.renderJobs[0]?.outputUrl ?? null;
    const renderUrl =
      outputUrl && (await statRenderFile(outputUrl).catch(() => null))
        ? `/api/videos/${videoId}/file`
        : null;

    const durationSeconds = video.voiceOver?.durationSeconds ?? null;

    const clips = await this.loadClips(videoId);
    // Publishing deletes the objects and soft-deletes the rows together (see
    // `reclaimClipStorage`), so "published and no live clip rows" is the one
    // reliable reading of that state — there is nothing left to look at.
    const clipsReclaimed = video.status === "PUBLISHED" && clips.all.length === 0;

    const empty = (emptyReason: string): VideoTimeline => ({
      videoId,
      status: video.status,
      mode: "empty",
      durationSeconds,
      sections: [],
      blocks: [],
      renderUrl,
      orphanedCueCount: 0,
      clipsReclaimed,
      footageIncomplete: false,
      rerun,
      swapBlockedReason: rerun.available ? null : rerun.reason,
      emptyReason,
    });

    if (durationSeconds === null) {
      return empty(
        "This video has no narration yet. Section timings are read off the narration's " +
          "own alignment, so there is nothing to lay out until it exists.",
      );
    }

    const activeVersion = video.script?.activeVersion ?? null;
    const rawCues = activeVersion?.cues;
    const cues = Array.isArray(rawCues) ? (rawCues as unknown as ScriptCue[]) : [];

    // Same three-tier fallback render.service.ts applies. Cues, but no clip of
    // theirs on disk, means this video's footage is the old topic-level pool —
    // the render treats it exactly like a video with no cues at all, and so
    // must this timeline, or it would draw section boundaries the finished
    // video does not have.
    const hasCues = cues.length > 0 && activeVersion !== null;
    const cued = clips.bySection.size > 0;

    if (!hasCues || (!cued && clips.all.length > 0)) {
      return this.poolTimeline({
        video,
        videoId,
        durationSeconds,
        clips,
        renderUrl,
        rerun,
        clipsReclaimed,
        empty,
      });
    }

    const alignment = await this.loadAlignment(videoId);

    if (!alignment) {
      return empty(
        "This video's narration alignment is missing, and it is what every section " +
          "timing is derived from. Re-generating the narration writes it again.",
      );
    }

    const brand = await brandService.resolve(video.project?.channelId ?? null);
    const plan = planSections({
      cues,
      content: activeVersion.content,
      alignment,
      durationSeconds,
      minClipSeconds: minClipSecondsFor(brand.videoStyle.transitions),
    });

    if (plan.sections.length === 0) {
      return empty(
        `None of this script's ${cues.length} b-roll cues still match its text, so the ` +
          "render has no sections to cut to. Re-generating the script writes fresh cues.",
      );
    }

    const sections: TimelineSection[] = plan.sections.map((section) => ({
      ...section,
      clip: clips.bySection.get(section.index) ?? null,
    }));

    const withClip = sections.filter((section) => section.clip !== null).length;

    return {
      videoId,
      status: video.status,
      mode: "sections",
      durationSeconds,
      sections,
      blocks: [],
      renderUrl,
      orphanedCueCount: plan.orphanedCueCount,
      clipsReclaimed,
      // Some sections with footage and some without is the one arrangement
      // render.service.ts refuses outright — every later section would slide
      // forward into the gap and play against the wrong words.
      footageIncomplete: withClip > 0 && withClip !== sections.length,
      rerun,
      swapBlockedReason: this.swapBlockedReason(rerun, clipsReclaimed),
      emptyReason: null,
    };
  }

  /**
   * Searches for footage to put under one section.
   *
   * Both providers, alternated, exactly as collection does — this is the same
   * `pexelsProvider` / `pixabayProvider` pair `FootageService` composes, so a
   * clip offered here is one collection could equally have chosen (same
   * duration band, same size ceiling, same 1080p-or-better rendition rule).
   * Writing a second search client would have meant a picker that offers
   * clips the renderer would then refuse.
   *
   * `allSettled`, not `all`: one source being down should narrow the choices,
   * not empty them. Only both failing is a real failure worth reporting.
   */
  async searchFootage(
    userId: string,
    videoId: string,
    query: string,
  ): Promise<FootageOption[]> {
    await this.requireVideo(userId, videoId);

    const trimmed = query.trim().slice(0, QUERY_MAX_LENGTH);

    if (!trimmed) {
      throw new ConflictError("Enter something to search for.");
    }

    const [pexels, pixabay] = await Promise.allSettled([
      this.providers.PEXELS.search(trimmed, SEARCH_CANDIDATE_COUNT),
      this.providers.PIXABAY.search(trimmed, SEARCH_CANDIDATE_COUNT),
    ]);

    if (pexels.status === "rejected" && pixabay.status === "rejected") {
      throw pexels.reason;
    }

    const clips = alternate(
      pexels.status === "fulfilled" ? pexels.value : [],
      pixabay.status === "fulfilled" ? pixabay.value : [],
    );

    const { bySection } = await this.loadClips(videoId);
    const sectionOf = new Map<string, number>();
    for (const [index, clip] of bySection) {
      if (clip.externalId) {
        // First wins: with a reused clip the lowest index is the section that
        // actually searched for it, which is the more useful one to name.
        if (!sectionOf.has(clip.externalId)) sectionOf.set(clip.externalId, index);
      }
    }

    const seen = new Set<string>();

    return clips
      .filter((clip) => {
        // Both sources can surface the same footage; a picker showing one
        // clip twice reads as a bug.
        const key = `${clip.source}:${clip.externalId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((clip) => ({
        source: clip.source,
        externalId: clip.externalId,
        url: clip.url,
        width: clip.width,
        height: clip.height,
        durationSeconds: clip.durationSeconds,
        alreadyUsedBySection: sectionOf.get(clip.externalId) ?? null,
      }));
  }

  /**
   * Replaces the clip that plays under one section.
   *
   * The whole edit is: put different bytes at
   * `videos/{videoId}/clips/section-NNN.mp4` and update the `Asset` row that
   * names them. That is the entire representation of "which clip plays under
   * which section" — `render.service.ts` maps section `i` to exactly that path
   * and downloads whatever is there — so nothing else has to be stored, and no
   * schema change is needed to make the choice survive. It survives a second
   * *collection* too: `collectPerCue` skips any section whose path already has
   * a live `Asset`, so a later `collect()` leaves an operator's choice alone
   * rather than overwriting it with a fresh search result.
   *
   * Two refusals, both structural rather than cautious:
   *
   *   - The section must already have a clip. render.service.ts treats "some
   *     sections present, some not" as unrenderable, and rightly: it would
   *     play the picture seconds ahead of the words from the gap onward. A
   *     video whose footage is the old topic-level pool has *no* section
   *     paths, so writing one would take it from "renders as a pool" to
   *     "refuses to render at all" — a swap must never do that.
   *   - The video must still have a render ahead of it (see
   *     `rerunAvailability`). Storing a choice that no pipeline will ever read
   *     is a control that looks like an edit and silently does nothing.
   *
   * The chosen clip is re-found by re-running the operator's own search rather
   * than trusting a URL from the browser — see `downloadClip`.
   */
  async swapFootage(
    userId: string,
    videoId: string,
    args: { sectionIndex: number; source: StockFootageSource; externalId: string; query: string },
  ): Promise<{ provider: StockFootageSource; externalId: string; sizeBytes: number }> {
    const { sectionIndex, source, externalId } = args;
    const video = await this.requireVideo(userId, videoId);

    const rerun = rerunAvailability(video, new Date());
    if (!rerun.available) {
      throw new ConflictError(rerun.reason);
    }

    const path = sectionClipPath(videoId, sectionIndex);
    const existing = await prisma.asset.findFirst({
      where: { kind: "VIDEO", deletedAt: null, storagePath: path },
      select: { id: true },
    });

    if (!existing) {
      throw new ConflictError(
        `Section ${sectionIndex + 1} has no footage of its own to replace. Run footage ` +
          "collection from the Pipeline tab first — swapping a clip into a video whose " +
          "footage is a shared topic pool would leave it unable to render at all.",
      );
    }

    const query = args.query.trim().slice(0, QUERY_MAX_LENGTH);
    if (!query) {
      throw new ConflictError("Enter something to search for.");
    }

    const results = await this.providers[source].search(query, SEARCH_CANDIDATE_COUNT);
    const clip = results.find((candidate) => candidate.externalId === externalId);

    if (!clip) {
      throw new ConflictError(
        `That clip is no longer among ${source}'s results for "${query}". Search again ` +
          "and pick from what it returns now.",
      );
    }

    const buffer = await this.download(clip);

    // Storage first, row second, and the ordering matters for the same reason
    // it does in publish.service.ts's reclaim: if this dies between the two,
    // the row still describes a real object at that path — the new one — and
    // only its provenance columns are stale. The reverse would leave a row
    // naming footage that was never written.
    await putObject(path, buffer, "video/mp4");

    await prisma.asset.update({
      where: { id: existing.id },
      data: {
        provider: clip.source,
        externalId: clip.externalId,
        sizeBytes: BigInt(buffer.byteLength),
        mimeType: "video/mp4",
      },
    });

    return {
      provider: clip.source,
      externalId: clip.externalId,
      sizeBytes: buffer.byteLength,
    };
  }

  /** Ownership, and the columns `rerunAvailability` needs. A video belonging
   *  to someone else must look exactly like one that does not exist. */
  private async requireVideo(userId: string, videoId: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true, attempts: true, leaseExpiresAt: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    return video;
  }

  /**
   * Every clip this video still has, keyed by the section it plays under.
   *
   * Scoped by storage prefix because `Asset` carries no `videoId` — the same
   * `videos/{videoId}/clips/` narrowing `reclaimClipStorage` uses, which is
   * tighter than render.service.ts's `videos/{videoId}/` and cannot reach
   * narration, music or alignment rows sharing the prefix. Ordered by path,
   * not `createdAt`: play order for an uncued video is lexicographic by path,
   * so this is the order the render itself would use.
   */
  private async loadClips(videoId: string) {
    const assets = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/clips/` },
      },
      orderBy: { storagePath: "asc" },
      select: { storagePath: true, provider: true, externalId: true, sizeBytes: true },
    });

    // One clip can legitimately fill several sections: FootageService copies
    // the nearest assigned section's footage when a section's own search finds
    // nothing. Collecting the repeats here is what lets the view say so.
    const sectionsByExternalId = new Map<string, number[]>();
    for (const asset of assets) {
      const match = SECTION_CLIP_PATTERN.exec(asset.storagePath);
      if (!match || !asset.externalId) continue;
      const list = sectionsByExternalId.get(asset.externalId) ?? [];
      list.push(Number(match[1]));
      sectionsByExternalId.set(asset.externalId, list);
    }

    const bySection = new Map<number, TimelineClip>();
    const all = assets.map((asset) => {
      const match = SECTION_CLIP_PATTERN.exec(asset.storagePath);
      const index = match ? Number(match[1]) : null;
      const shared = asset.externalId
        ? (sectionsByExternalId.get(asset.externalId) ?? []).filter(
            (other) => other !== index,
          )
        : [];

      const clip: TimelineClip = {
        provider: asset.provider,
        externalId: asset.externalId,
        // `sizeBytes` is a BigInt column; it crosses to a client component
        // through a server action, and BigInt is not serialisable there.
        sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
        alsoUsedBySections: shared,
      };

      if (index !== null) {
        bySection.set(index, clip);
      }

      return clip;
    });

    return { all, bySection };
  }

  /**
   * The character-level alignment ElevenLabs returned, which is the only
   * record of when each character is actually spoken.
   *
   * Found the same way render.service.ts finds it — the most recent live
   * `SUBTITLE` asset under this video's prefix, rather than by reconstructing
   * `captions/alignment.json`, so a video whose alignment was ever stored
   * somewhere else still resolves. Never throws: a missing or unparseable
   * alignment is a named state the view explains, not a page failure.
   */
  private async loadAlignment(videoId: string): Promise<Alignment | null> {
    const asset = await prisma.asset.findFirst({
      where: {
        kind: "SUBTITLE",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/` },
      },
      orderBy: { createdAt: "desc" },
      select: { storagePath: true },
    });

    if (!asset) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        (await getObject(asset.storagePath)).toString("utf-8"),
      ) as Alignment;

      // A truncated or half-written alignment would otherwise reach
      // `cueWindows` and produce `undefined` start times, i.e. NaN section
      // boundaries drawn as an empty strip with no explanation.
      if (
        !Array.isArray(parsed?.characters) ||
        !Array.isArray(parsed?.characterStartTimesSeconds) ||
        !Array.isArray(parsed?.characterEndTimesSeconds) ||
        parsed.characters.length === 0
      ) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  /** The pool timeline: no cues, or cues whose sections were never collected
   *  for. Assembled here rather than inline in `get` only to keep that method
   *  readable — every number in it comes from `planPoolBlocks`. */
  private poolTimeline(args: {
    video: { status: VideoStatus };
    videoId: string;
    durationSeconds: number;
    clips: { all: TimelineClip[]; bySection: Map<number, TimelineClip> };
    renderUrl: string | null;
    rerun: RerunAvailability;
    clipsReclaimed: boolean;
    empty: (reason: string) => VideoTimeline;
  }): VideoTimeline {
    const { video, videoId, durationSeconds, clips, renderUrl, rerun, clipsReclaimed } = args;

    if (clips.all.length === 0) {
      return args.empty(
        clipsReclaimed
          ? "This video's clips were deleted after it was published — publishing reclaims " +
              "them once YouTube has the upload. The video itself is unchanged."
          : "No footage has been collected for this video yet, and it has no b-roll cues " +
              "to lay out either.",
      );
    }

    const pooled = clips.all.slice(0, MAX_POOL_CLIPS);
    const timings = planPoolBlocks({
      clipCount: pooled.length,
      durationSeconds,
      // A pool video's blocks are clamped, never re-cut, so the floor only
      // matters when the narration is too short to go round — the same
      // `MIN_CLIP_SECONDS` render.service.ts clamps with.
      minClipSeconds: MIN_CLIP_SECONDS,
    });

    return {
      videoId,
      status: video.status,
      mode: "pool",
      durationSeconds,
      sections: [],
      blocks: pooled.map((clip, index) => ({ index, ...timings[index], clip })),
      renderUrl,
      orphanedCueCount: 0,
      clipsReclaimed,
      footageIncomplete: false,
      rerun,
      // There are no per-section clips to replace, and writing one would take
      // the video from "renders as a pool" to "refuses to render".
      swapBlockedReason:
        "This video's footage is a shared topic pool rather than one clip per section, " +
        "so there is no single section's clip to swap.",
      emptyReason: null,
    };
  }

  private swapBlockedReason(
    rerun: RerunAvailability,
    clipsReclaimed: boolean,
  ): string | null {
    if (clipsReclaimed) {
      return "This video's clips were deleted after it was published. There is nothing to replace.";
    }

    return rerun.available ? null : rerun.reason;
  }
}

export const timelineService = new TimelineService();
