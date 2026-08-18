import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VideoFormat } from "@/generated/prisma/enums";
import { beatClipPath } from "@/lib/beat-storage";
import { NotFoundError, ProviderError, ValidationError } from "@/lib/errors";
import { buildConformArgs } from "@/lib/ffmpeg-command";
import { planMotionSpend, type MotionSpendPlan } from "@/lib/motion-spend";
import { prisma } from "@/lib/prisma";
import { checkManifest, clipPrompt, type Manifest } from "@/lib/render-manifest";
import { putObject } from "@/lib/storage";
import { DEFAULT_FAL_MODEL, falVideoProvider } from "@/services/providers/fal-video.provider";
import type { VideoGenerationProvider } from "@/services/providers/types";
import {
  providerCredentialService,
  type ProviderCredentialService,
} from "@/services/provider-credential.service";
import { defaultSpawner, type ProcessSpawner } from "@/services/render.service";

/**
 * The motion tier: generated video, one clip at a time.
 *
 * ## What this costs, said plainly
 *
 * This is the most expensive and by far the slowest thing in Framecast. A
 * generated still costs about five cents and arrives in seconds; a generated
 * clip is billed by the second and one measured five-second clip took **217
 * seconds** to come back. A full twelve-clip manifest is therefore something
 * like an hour and a quarter of wall time and — at the rates the spec surveyed,
 * $0.03 to $0.25 a second — somewhere between four and twenty-four dollars.
 * Everything else this app does for a video costs about $1.50 in total.
 *
 * The spec argues this tier out of v1 on exactly those numbers and it is right
 * to. It exists because the operator asked for it after reading the argument
 * twice, and the shape below is what "build it anyway" honestly requires.
 *
 * ## Why a job table and not an await
 *
 * 217 seconds is longer than any HTTP request in this app lives. So the shape
 * is `auto-publish.service.ts`'s — a row, a lease, a worker tick, a backoff —
 * rather than every other provider's `await`. `claimDue` is that file's
 * conditional-update claim, copied deliberately rather than reinvented, and the
 * stake is comparable: there a lost race publishes a video twice, here it *buys
 * a generation twice*.
 *
 * ## The two gates, and which one is the real one
 *
 * `enqueue` runs `checkManifest` and then `planMotionSpend`, and refuses on
 * either, before a single row exists. Both refuse rather than warn. The ceiling
 * is denominated in billed seconds and not in dollars because fal.ai publishes
 * no price API — see motion-spend.ts, which is where that argument lives in
 * full. By the time a `MotionClipJob` row exists, the whole video's cost has
 * been measured and accepted; nothing after that point can decide to spend more
 * than `MAX_ATTEMPTS` times what was authorised.
 *
 * ## What this deliberately does not do
 *
 * It does not touch the renderer. Clips land under `videos/{id}/beats/` as
 * `.mp4`, which `beat-storage.ts` and `planRender` already understand — the
 * extension is what selects `-stream_loop -1`, and that has been true since the
 * mixed collector. No change to `planRender`, `buildSegmentArgs`,
 * `buildAssembleArgs` or `composer.ts` is needed or made.
 *
 * It also does not stretch a clip to fill a still's slot. `MAX_CLIP_SECONDS` is
 * 5.0 and `checkManifest` enforces it, so this tier serves formats that cut at
 * four to five seconds and no others. A twelve-second slot filled by a
 * five-second generation is `-stream_loop -1` playing the same motion twice,
 * which reads as a glitch; refusing the manifest is the honest answer and it is
 * already the existing gate's answer.
 */

/**
 * How long a worker holds a claimed job.
 *
 * Five minutes, matching `auto-publish.service.ts`, and sized to the same kind
 * of work rather than to the generation: the claim covers one submit, or one
 * poll plus a download and an FFmpeg conform. The 217-second generation itself
 * happens on fal's side while this row sits SUBMITTED and unclaimed, which is
 * the entire reason the row exists.
 */
const CLAIM_LEASE_SECONDS = 300;

/** How many due jobs one claim looks at. Five, as everywhere else here — the
 *  list exists only so a lost race falls through to another row rather than
 *  waiting out a whole poll. */
const CANDIDATE_BATCH = 5;

/**
 * How often a generation in flight is asked about.
 *
 * Twenty seconds, against a measured 217. That is about eleven polls per clip,
 * and it means a finished clip waits at most 9% of its own generation time to
 * be noticed. Polling is free and generating is not, so the cost of being wrong
 * here is entirely one-sided.
 */
const POLL_INTERVAL_SECONDS = 20;

/**
 * How long a submitted generation may run before it is abandoned.
 *
 * Thirty minutes — roughly eight times the one generation anybody has actually
 * timed. Generous on purpose: the failure this guards against is a queue that
 * never answers, and the cost of calling a slow generation dead is buying it
 * again. A deadline that is too tight spends money; one that is too loose only
 * wastes time.
 */
const GENERATION_DEADLINE_SECONDS = 1800;

/** How many failed generations give up on a clip. Three, the same as every
 *  other queue in this codebase — and here it is also the multiplier on the
 *  worst case: a job can cost at most three times its `billedSeconds`. */
const MAX_ATTEMPTS = 3;

/** Minutes to wait after the Nth failed generation. Five, then thirty, matching
 *  `auto-publish.service.ts` — long enough that a provider having a bad
 *  half-hour is not paid for repeatedly. There is no third; `MAX_ATTEMPTS` ends
 *  it. */
const BACKOFF_MINUTES = [5, 30];

/** Stderr kept from a failed conform, so the reason travels with the error
 *  rather than needing a log line to correlate against. */
const STDERR_CAPTURE_LIMIT = 4000;

/** A conform is a few seconds of encoding on a five-second clip. A minute is
 *  well past "slow" and into "hung", and a hung FFmpeg holds the claim's lease
 *  and then the job forever. */
const CONFORM_TIMEOUT_MS = 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A job won by `claimDue`, carrying everything `executeClaim` needs so it never
 *  re-reads a row another worker may have moved underneath it. */
export interface MotionClaim {
  jobId: string;
  userId: string;
  videoId: string;
  clipId: number;
  slotIndex: number;
  model: string;
  prompt: string;
  negativePrompt: string | null;
  aspectRatio: string;
  durationSeconds: number;
  seed: number;
  billedSeconds: number;
  attempts: number;
  /** Null means "not submitted yet, and therefore not yet billed". Its presence
   *  is the single fact that decides whether this tick spends money or reads a
   *  status, so it is carried on the claim rather than re-read. */
  requestId: string | null;
  submittedAt: Date | null;
  format: VideoFormat;
}

export interface MotionTickResult {
  jobId: string;
  videoId: string;
  clipId: number;
  /**
   * `SUBMITTED` is the one that spent money. `PENDING` is a poll that found the
   * generation still running — no attempt counted, nothing billed. `STORED` is
   * a clip conformed and filed. `DEFERRED` is a failed generation that will be
   * tried again; `FAILED` has given up.
   */
  outcome: "SUBMITTED" | "PENDING" | "STORED" | "DEFERRED" | "FAILED";
  storagePath: string | null;
  reason: string | null;
}

/** What a video's motion tier has cost and how far along it is — the numbers an
 *  operator reads before authorising and after it has run. */
export interface MotionSummary {
  clips: number;
  done: number;
  failed: number;
  inFlight: number;
  /** Authorised: what the manifest was priced at, one generation per clip. */
  billedSecondsPlanned: number;
  /** Spent: `billedSeconds` times generations actually submitted, including the
   *  ones that failed. This is the number that shows what the reject rate
   *  really was on this account, which is otherwise unfalsifiable. */
  billedSecondsSubmitted: number;
}

export class MotionService {
  constructor(
    private readonly provider: VideoGenerationProvider = falVideoProvider,
    /** The same injection shape `RenderService` and `ThumbnailService` use, and
     *  for the same reason: a test proving the conform runs must never start a
     *  real encoder. */
    private readonly spawnProcess: ProcessSpawner = defaultSpawner,
    /** `Pick`, not the whole service: this class calls exactly one method, and
     *  typing it as the full class would force every test to stub `test`,
     *  `upsert` and `list` as well. */
    private readonly credentials: Pick<
      ProviderCredentialService,
      "resolveKey"
    > = providerCredentialService,
  ) {}

  /**
   * What a manifest will cost, without committing to it.
   *
   * The screen that asks an operator to authorise this tier calls exactly this,
   * and so does `enqueue`. One function priced both, which is the only way the
   * spend somebody approved and the spend the worker performs are the same
   * spend.
   */
  plan(manifest: Manifest, ceilingSeconds?: number): MotionSpendPlan {
    return planMotionSpend(manifest, ceilingSeconds);
  }

  /**
   * Writes one job per clip, after both gates have passed.
   *
   * Order matters and is not incidental. `checkManifest` first, because a
   * manifest with a malformed prompt is cheapest to reject when it has cost
   * nothing; then the ceiling, because a well-formed manifest can still be one
   * nobody meant to buy. Only then are rows written, and a row is the first
   * artefact in this whole path that leads to a bill.
   *
   * `createMany` with `skipDuplicates` over the `(videoId, clipId)` unique
   * constraint, exactly as `AutoPublishService.enqueue` does: the only way a
   * row already exists is a retried enqueue, where re-booking must be a no-op
   * rather than a second bill. Note which one survives — the FIRST. A retry
   * must not rewrite the seed a clip was generated under.
   */
  async enqueue(
    userId: string,
    videoId: string,
    manifest: Manifest,
    options: { model?: string; ceilingSeconds?: number } = {},
  ): Promise<MotionSpendPlan> {
    const check = checkManifest(manifest);

    if (!check.ok) {
      throw new ValidationError(
        `This manifest cannot be generated: ${check.errors.join(" ")}`,
      );
    }

    const spend = this.plan(manifest, options.ceilingSeconds);

    if (!spend.withinCeiling) {
      throw new ValidationError(
        `Refusing to generate: ${spend.summary}. The ceiling is a refusal and ` +
          `not a warning, because a video model bills by the second and takes ` +
          `minutes — by the time a warning has been read the money is spent.`,
      );
    }

    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    const model = options.model ?? DEFAULT_FAL_MODEL;

    await prisma.motionClipJob.createMany({
      data: manifest.clips.map((clip, slotIndex) => ({
        userId,
        videoId,
        clipId: clip.id,
        slotIndex,
        model,
        // The style lock appended here, once, in code — see `clipPrompt`. What
        // was actually sent is stored rather than recomputed, so a later edit to
        // the look does not rewrite the history of what a clip was asked for.
        prompt: clipPrompt(manifest, clip),
        negativePrompt: manifest.negativePrompt || null,
        aspectRatio: manifest.aspectRatio,
        durationSeconds: clip.duration,
        seed: clip.seed,
        // ONE generation's worth, with no reject multiplier in it. The
        // multiplier is a fleet-level planning number and belongs in the total
        // (`planMotionSpend`); a row multiplied by it would claim this clip
        // costs 1.6 generations, which no clip does. What a row really cost is
        // this times the generations actually submitted.
        billedSeconds: Math.ceil(clip.duration),
      })),
      skipDuplicates: true,
    });

    return spend;
  }

  /**
   * Wins exactly one due job.
   *
   * The same shape as `AutoPublishService.claimDue`, for the same reason:
   * Prisma's `updateMany` has no `LIMIT`, so an unconditional "claim the oldest
   * due job" would let two callers both match and both believe they won. Read a
   * short list, then try to win each with an update whose `where` repeats the
   * exact state just read. The conditional update *is* the lock; the read is a
   * hint.
   *
   * Both WAITING and SUBMITTED rows are claimable, and they mean opposite
   * things: a WAITING row is about to be paid for, a SUBMITTED row already has
   * been and is only being asked about. A lapsed CLAIMED row goes back into the
   * running with `attempts` untouched — a worker that died mid-call is not a
   * generation that was refused.
   */
  async claimDue(now: Date = new Date()): Promise<MotionClaim | null> {
    const candidates = await prisma.motionClipJob.findMany({
      where: {
        runAfter: { lte: now },
        video: { deletedAt: null },
        OR: [
          { status: "WAITING" },
          { status: "SUBMITTED" },
          { status: "CLAIMED", leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { runAfter: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        videoId: true,
        clipId: true,
        slotIndex: true,
        model: true,
        prompt: true,
        negativePrompt: true,
        aspectRatio: true,
        durationSeconds: true,
        seed: true,
        billedSeconds: true,
        attempts: true,
        requestId: true,
        submittedAt: true,
        status: true,
        video: { select: { format: true } },
      },
    });

    for (const candidate of candidates) {
      const { count } = await prisma.motionClipJob.updateMany({
        where: {
          id: candidate.id,
          // The lock. Repeats the exact status just read, so only one caller can
          // still match. A lapsed CLAIMED row is retaken by the same pair of
          // conditions that found it — without the lease check a second worker
          // could take a job whose first worker is still mid-submit, and a
          // duplicated submit here is a duplicated bill.
          status: candidate.status,
          ...(candidate.status === "CLAIMED" ? { leaseExpiresAt: { lt: now } } : {}),
        },
        data: {
          status: "CLAIMED",
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
        },
      });

      if (count === 0) continue;

      return {
        jobId: candidate.id,
        userId: candidate.userId,
        videoId: candidate.videoId,
        clipId: candidate.clipId,
        slotIndex: candidate.slotIndex,
        model: candidate.model,
        prompt: candidate.prompt,
        negativePrompt: candidate.negativePrompt,
        aspectRatio: candidate.aspectRatio,
        durationSeconds: candidate.durationSeconds,
        seed: candidate.seed,
        billedSeconds: candidate.billedSeconds,
        attempts: candidate.attempts,
        requestId: candidate.requestId,
        submittedAt: candidate.submittedAt,
        format: candidate.video.format,
      };
    }

    return null;
  }

  /**
   * Runs one claimed job: either it starts a generation or it asks about one.
   *
   * Which of the two is decided entirely by `requestId`, and that field is the
   * most consequential one in the table. A row that lost it would be submitted
   * again, and a duplicate submit is a duplicate bill — so the id is written in
   * the same update that moves the row to SUBMITTED, immediately on return from
   * `submit`. That leaves a window exactly one database write wide in which a
   * worker that dies has paid for a generation nobody can collect. It cannot be
   * closed from this side: fal's queue API offers no idempotency key to submit
   * under, so there is no way to ask "did I already start this one". What bounds
   * it instead is `MAX_ATTEMPTS` — a job can cost at most three generations,
   * whatever goes wrong.
   */
  async executeClaim(
    claim: MotionClaim,
    now: Date = new Date(),
  ): Promise<MotionTickResult> {
    const base = { jobId: claim.jobId, videoId: claim.videoId, clipId: claim.clipId };

    const apiKey = await this.credentials.resolveKey(claim.userId, this.provider.provider);

    if (!apiKey) {
      // Not a backoff. No number of retries produces a credential, and a job
      // quietly retrying every half hour against a provider the operator never
      // configured is a queue that looks busy and is doing nothing.
      return this.fail(
        base,
        `No ${this.provider.provider} credential is stored for this account, so ` +
          `nothing can be generated. Add one on the providers screen and re-queue.`,
      );
    }

    if (!claim.requestId) {
      return this.submitGeneration(claim, base, apiKey, now);
    }

    return this.collectGeneration(claim, base, apiKey, claim.requestId, now);
  }

  /** One due-check. At most one job per tick, which is also what keeps a worker
   *  coming back after an outage from firing twelve generations at once. */
  async tick(): Promise<MotionTickResult | null> {
    const claim = await this.claimDue();

    return claim ? this.executeClaim(claim) : null;
  }

  /**
   * Re-rolls one clip under a new seed.
   *
   * This is what the seed column is *for*, and it is worth being precise about
   * why it is a separate method rather than a retry. An automatic retry keeps
   * the seed, because it is recovering from a socket or a 5xx and wants the same
   * clip it was always trying to make. A re-roll changes the seed, because the
   * clip arrived intact and was simply bad. Same row, opposite intentions —
   * collapsing them would mean either that a network blip silently changed a
   * shot the operator had approved, or that asking for a different take gave
   * back the identical one.
   *
   * The other eleven clips are untouched, which is the whole economic argument
   * for storing seeds at all.
   */
  async reroll(
    userId: string,
    videoId: string,
    clipId: number,
    seed: number,
    now: Date = new Date(),
  ): Promise<void> {
    const { count } = await prisma.motionClipJob.updateMany({
      where: { userId, videoId, clipId },
      data: {
        seed,
        status: "WAITING",
        // Cleared together: a re-roll is a new generation, so the old queue id
        // must not be polled and the old failure must not be shown against it.
        requestId: null,
        submittedAt: null,
        storagePath: null,
        error: null,
        attempts: 0,
        leaseExpiresAt: null,
        runAfter: now,
      },
    });

    if (count === 0) {
      throw new NotFoundError("Motion clip");
    }
  }

  /** What this video's motion tier was authorised for and what it has actually
   *  submitted. The gap between the two is the reject rate, measured rather
   *  than assumed — see `MotionSummary.billedSecondsSubmitted`. */
  async summary(videoId: string): Promise<MotionSummary> {
    const jobs = await prisma.motionClipJob.findMany({
      where: { videoId },
      select: { status: true, billedSeconds: true, attempts: true, requestId: true },
    });

    return {
      clips: jobs.length,
      done: jobs.filter((job) => job.status === "DONE").length,
      failed: jobs.filter((job) => job.status === "FAILED").length,
      inFlight: jobs.filter((job) => job.status === "SUBMITTED").length,
      billedSecondsPlanned: jobs.reduce((sum, job) => sum + job.billedSeconds, 0),
      billedSecondsSubmitted: jobs.reduce(
        // `attempts` counts generations that FAILED; the one in flight or
        // finished is the extra. A row that has never been submitted has
        // neither, and contributes nothing.
        (sum, job) =>
          sum +
          job.billedSeconds *
            (job.attempts + (job.requestId || job.status === "DONE" ? 1 : 0)),
        0,
      ),
    };
  }

  /** The call that starts a bill. Everything before it in this file is free. */
  private async submitGeneration(
    claim: MotionClaim,
    base: Pick<MotionTickResult, "jobId" | "videoId" | "clipId">,
    apiKey: string,
    now: Date,
  ): Promise<MotionTickResult> {
    let requestId: string;

    try {
      requestId = await this.provider.submit({
        apiKey,
        model: claim.model,
        prompt: claim.prompt,
        negativePrompt: claim.negativePrompt ?? undefined,
        aspectRatio: claim.aspectRatio,
        durationSeconds: claim.durationSeconds,
        seed: claim.seed,
      });
    } catch (error) {
      return this.afterFailedGeneration(claim, base, error, now);
    }

    await prisma.motionClipJob.update({
      where: { id: claim.jobId },
      data: {
        status: "SUBMITTED",
        requestId,
        submittedAt: now,
        leaseExpiresAt: null,
        error: null,
        runAfter: new Date(now.getTime() + POLL_INTERVAL_SECONDS * 1000),
      },
    });

    return { ...base, outcome: "SUBMITTED", storagePath: null, reason: null };
  }

  /** Asks about a generation already paid for, and stores it if it is ready. */
  private async collectGeneration(
    claim: MotionClaim,
    base: Pick<MotionTickResult, "jobId" | "videoId" | "clipId">,
    apiKey: string,
    requestId: string,
    now: Date,
  ): Promise<MotionTickResult> {
    let state: Awaited<ReturnType<VideoGenerationProvider["checkStatus"]>>;

    try {
      state = await this.provider.checkStatus(claim.model, requestId, apiKey);
    } catch (error) {
      // A poll that could not be made says nothing about the generation, which
      // is still running and still paid for. Backing off and polling again is
      // right; counting an attempt would eventually abandon a healthy clip that
      // was only unreachable.
      return this.deferPoll(claim, base, messageOf(error), now);
    }

    if (state.state === "PENDING") {
      const elapsedMs = now.getTime() - (claim.submittedAt?.getTime() ?? now.getTime());

      if (elapsedMs > GENERATION_DEADLINE_SECONDS * 1000) {
        return this.afterFailedGeneration(
          claim,
          base,
          new Error(
            `The generation was still running ${Math.round(elapsedMs / 1000)}s ` +
              `after it was submitted, past the ${GENERATION_DEADLINE_SECONDS}s ` +
              `deadline, and has been abandoned.`,
          ),
          now,
        );
      }

      return this.deferPoll(claim, base, state.detail, now);
    }

    if (state.state === "FAILED") {
      return this.afterFailedGeneration(
        claim,
        base,
        new Error(state.detail ?? "fal.ai reported the generation as failed."),
        now,
      );
    }

    const startedAt = Date.now();
    let storagePath: string;

    try {
      storagePath = await this.storeClip(claim, requestId, apiKey);
    } catch (error) {
      await this.recordUsage(claim, false, Date.now() - startedAt);

      return this.afterFailedGeneration(claim, base, error, now, { usageWritten: true });
    }

    await this.recordUsage(claim, true, Date.now() - startedAt);

    await prisma.motionClipJob.update({
      where: { id: claim.jobId },
      data: {
        status: "DONE",
        storagePath,
        leaseExpiresAt: null,
        error: null,
      },
    });

    return { ...base, outcome: "STORED", storagePath, reason: null };
  }

  /**
   * Downloads a finished generation, conforms it, and files it as an Asset.
   *
   * The conform is not optional and not a nicety. The one clip anybody has
   * measured came back 720x1280 at about 16fps, against a pipeline that runs at
   * 30fps and 1080x1920. Written as it arrives, it is a timeline entry moving at
   * a different rate from every other entry — see `buildConformArgs`.
   *
   * The path is `beatClipPath`, which is to say the same prefix and the same
   * naming the mixed collector already uses. That is what makes this play with
   * no renderer change at all: `planRender` reads the extension and picks
   * `-stream_loop -1`, exactly as it does for a stock clip.
   */
  private async storeClip(
    claim: MotionClaim,
    requestId: string,
    apiKey: string,
  ): Promise<string> {
    const clip = await this.provider.fetchResult(claim.model, requestId, apiKey);

    if (clip.seed !== null && clip.seed !== claim.seed) {
      // Non-retryable, and worth failing over rather than shrugging at: a
      // provider that did not honour the seed cannot re-roll one clip at a
      // time, which removes the only thing that makes this tier affordable to
      // iterate on. Better to find out on clip one than on clip twelve.
      throw new ProviderError(
        this.provider.provider,
        `The provider generated seed ${clip.seed} for a clip requested with ` +
          `seed ${claim.seed}. A seed it does not honour means one bad clip ` +
          `cannot be re-rolled without changing every other clip.`,
        false,
      );
    }

    const directory = await mkdtemp(join(tmpdir(), "framecast-motion-"));

    try {
      const sourcePath = join(directory, "generated.mp4");
      const outputPath = join(directory, "conformed.mp4");

      await writeFile(sourcePath, clip.data);
      await this.runFfmpeg(buildConformArgs({ sourcePath, outputPath, format: claim.format }));

      const conformed = await readFile(outputPath);
      const path = beatClipPath(claim.videoId, claim.slotIndex);

      await putObject(path, conformed, "video/mp4");

      await prisma.asset.create({
        data: {
          kind: "VIDEO",
          storagePath: path,
          mimeType: "video/mp4",
          sizeBytes: BigInt(conformed.byteLength),
          provider: this.provider.provider,
          model: claim.model,
          prompt: claim.prompt,
          // The queue id, so a clip in the finished video can be traced back to
          // the generation that was billed for it.
          externalId: requestId,
        },
      });

      return path;
    } finally {
      // A leaked temp dir per clip fills the worker's disk, and this one holds
      // two copies of a video file.
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * One `ProviderUsage` row per terminal generation — the failures too.
   *
   * Recording only the successes would make `billedSeconds`' 1.6x reject
   * multiplier unfalsifiable: the rejects are precisely the seconds the
   * multiplier exists to account for, and they are billed. A usage table that
   * omitted them would say this tier costs 60% less than it does.
   *
   * `costUsd` is **zero**, and that is the harder of the two choices here.
   *
   * There is no price endpoint on fal.ai, so the only dollar figure this app
   * could write is `DISPLAY_USD_PER_BILLED_SECOND` times the seconds — a
   * constant an operator typed, multiplied by a real number. Every other row in
   * this table carries a cost the provider actually reported. One guess mixed
   * into that column does not make the motion tier legible, it makes every
   * total computed from the column a guess, and nothing in the row says which
   * kind it is. That is the same reasoning `GeneratedImage.costUsd` already
   * records for an unpriced model: suspiciously free beats plausibly wrong.
   *
   * The real number is not lost, it is just kept where it is honest —
   * `MotionClipJob.billedSeconds`, summed by `MotionService.summary`, in the
   * unit the provider actually bills. The dollars are shown beside it as a
   * clearly-labelled estimate at the moment an operator authorises the spend
   * (`planMotionSpend`), which is when a rough figure is useful and where being
   * approximate is stated rather than implied.
   *
   * The token columns stay zero because this provider bills seconds, not
   * tokens, and inventing a token count to fill them would be worse than an
   * honest nothing.
   */
  private async recordUsage(
    claim: MotionClaim,
    succeeded: boolean,
    latencyMs: number,
  ): Promise<void> {
    await prisma.providerUsage
      .create({
        data: {
          provider: this.provider.provider,
          operation: "motion.generate",
          model: claim.model,
          succeeded,
          latencyMs,
        },
      })
      .catch(() => {
        // Best-effort bookkeeping; it must never mask the real outcome of a
        // generation that has already been paid for.
      });
  }

  /** A poll that found nothing yet. No attempt, no bill, just a later
   *  `runAfter` — this is the ordinary case eleven times out of twelve. */
  private async deferPoll(
    claim: MotionClaim,
    base: Pick<MotionTickResult, "jobId" | "videoId" | "clipId">,
    reason: string | null,
    now: Date,
  ): Promise<MotionTickResult> {
    await prisma.motionClipJob.update({
      where: { id: claim.jobId },
      data: {
        status: "SUBMITTED",
        leaseExpiresAt: null,
        runAfter: new Date(now.getTime() + POLL_INTERVAL_SECONDS * 1000),
        error: reason,
      },
    });

    return { ...base, outcome: "PENDING", storagePath: null, reason };
  }

  /**
   * A generation that will not be finished: back off and try again, or give up.
   *
   * `requestId` is cleared, which is what makes the next attempt a fresh submit
   * rather than another poll of a dead id. The seed is NOT cleared — a retry is
   * still trying to make the same clip, and changing what it asks for behind the
   * operator's back is `reroll`'s job and nobody else's.
   *
   * A refusal the provider called non-retryable ends the job now. Three attempts
   * over thirty-five minutes would produce the same sentence three times and
   * pay for it twice more.
   */
  private async afterFailedGeneration(
    claim: MotionClaim,
    base: Pick<MotionTickResult, "jobId" | "videoId" | "clipId">,
    error: unknown,
    now: Date,
    options: { usageWritten?: boolean } = {},
  ): Promise<MotionTickResult> {
    const reason = messageOf(error);

    // A submit that never reached the provider bills nothing, so it is not a
    // generation and does not belong in the usage table. Anything that got as
    // far as a request id did.
    if (!options.usageWritten && claim.requestId) {
      await this.recordUsage(claim, false, 0);
    }

    const permanent = error instanceof ProviderError && !error.retryable;
    const attempts = claim.attempts + 1;

    if (permanent || attempts >= MAX_ATTEMPTS) {
      await prisma.motionClipJob.update({
        where: { id: claim.jobId },
        data: {
          status: "FAILED",
          attempts,
          requestId: null,
          submittedAt: null,
          leaseExpiresAt: null,
          error: reason,
        },
      });

      return { ...base, outcome: "FAILED", storagePath: null, reason };
    }

    await prisma.motionClipJob.update({
      where: { id: claim.jobId },
      data: {
        status: "WAITING",
        attempts,
        requestId: null,
        submittedAt: null,
        leaseExpiresAt: null,
        runAfter: new Date(now.getTime() + BACKOFF_MINUTES[attempts - 1] * 60 * 1000),
        error: reason,
      },
    });

    return { ...base, outcome: "DEFERRED", storagePath: null, reason };
  }

  /** A failure no retry can fix, recorded without counting an attempt against a
   *  generation that never happened. */
  private async fail(
    base: Pick<MotionTickResult, "jobId" | "videoId" | "clipId">,
    reason: string,
  ): Promise<MotionTickResult> {
    await prisma.motionClipJob.update({
      where: { id: base.jobId },
      data: { status: "FAILED", leaseExpiresAt: null, error: reason },
    });

    return { ...base, outcome: "FAILED", storagePath: null, reason };
  }

  /**
   * Runs one conform. Same discipline as `ThumbnailService.runFfmpeg`, and for
   * the same three reasons: stderr is captured because FFmpeg says why it failed
   * there and nowhere else, both pipes are drained because an unread pipe
   * deadlocks the writer, and the child gets a deadline because a hung encoder
   * strands the job rather than merely slowing it.
   */
  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess("ffmpeg", args);

      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CONFORM_TIMEOUT_MS);

      const reason = () => (stderr.trim() ? `: ${stderr.trim()}` : "");

      // `settled` guards the pair rather than trusting Node to emit only one of
      // them: a spawn that fails still closes.
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      child.stdout.on("data", () => {});

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_CAPTURE_LIMIT) {
          stderr = stderr.slice(-STDERR_CAPTURE_LIMIT);
        }
      });

      child.on("error", (error: Error) => {
        finish(new Error(`ffmpeg could not be started: ${error.message}${reason()}`));
      });

      child.on("close", (code: number | null) => {
        if (timedOut) {
          finish(
            new Error(
              `ffmpeg did not finish conforming the generated clip within ` +
                `${CONFORM_TIMEOUT_MS}ms and was killed${reason()}`,
            ),
          );
        } else if (code === 0) {
          finish();
        } else {
          finish(new Error(`ffmpeg exited with code ${code}${reason()}`));
        }
      });
    });
  }
}

export const motionService = new MotionService();
