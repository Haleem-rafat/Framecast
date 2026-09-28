import "server-only";

import { prisma } from "@/lib/prisma";
import {
  buildSubjectPrompt,
  looksLikeModelChatter,
  normaliseSubject,
  parseSubjects,
  type ReachEvidence,
} from "@/lib/subject-prompt";
import { brandService } from "@/services/brand.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider } from "@/services/providers/types";

/**
 * The topic queue fills itself.
 *
 * ## What this replaces
 *
 * A schedule took the next topic off its queue each run, and when the queue ran
 * out it paused itself with a sentence that ended "rather than guessing what to
 * make a video about". That was a deliberate design — see the original comment
 * on `ScheduleTopic` — and the reasoning behind it was sound: a studio that
 * chooses the subject of a video the operator pays for and puts their name on
 * can get that badly wrong, and discovering it after the render is worse than
 * not having produced anything.
 *
 * It was also, in practice, the reason most of this deployment's schedules were
 * paused at any given moment, and typing topics by hand was the single thing the
 * operator most wanted gone. A feature whose failure mode is "the thing stops
 * working every few weeks until you sit down and write a list" is not a safety
 * property, it is a chore with a justification attached.
 *
 * So the queue is topped up ahead of time instead. What the original argument was
 * really protecting is kept, and kept deliberately:
 *
 *   * The topics exist **before** the run that uses them. Nothing invents a
 *     subject at the moment it needs one; a run still takes the row at the head
 *     of a list that was written days earlier.
 *   * They are **visible and overridable**. They land in the same queue the
 *     operator reads, in the same order, and `ScheduleTopic.generated` marks
 *     which ones they did not write, so deleting one they dislike is the same
 *     click it always was.
 *   * They are **the operator's own subject matter**, not a model's idea of what
 *     their channel could be about — ranked against their niche, their script
 *     style, and where there are figures, their own best and worst videos.
 *
 * ## Ranking, and why it is not "surprise me"
 *
 * The owner's measured pattern is in `REACH_RULE` (src/lib/subject-prompt.ts): a
 * recognisable subject gets about four times the views of an obscure one, and the
 * winning shape is a recognisable subject with a genuine twist. That rule is in
 * every prompt this service sends. On top of it, where the channel has collected
 * analytics, the titles of its best recent videos go in as "more like these" and
 * its worst as "unlike these" — see `readReachEvidence`, which is a plain
 * function over two tables precisely so the ranking can be tested without a
 * model.
 *
 * ## What must never happen twice
 *
 * Two workers both deciding one queue is low and both generating ten topics for
 * it. That costs a wasted model call and leaves twenty topics where the operator
 * was promised ten, in an order nobody chose. Prevented with the same
 * conditional-update-as-lock every other claim in this codebase uses, on
 * `Schedule.topicRefillLeaseExpiresAt` — a lease rather than a lock, so a worker
 * killed mid-generation does not leave a queue that can never be filled again.
 * The loser of that race does nothing at all rather than waiting: a refill is not
 * work anybody is blocked on, and the winner is about to make the queue long
 * enough for both of them.
 */

/**
 * Below this many unused topics, the queue is refilled.
 *
 * Three, not one, and the gap is the whole point. Refilling at zero would mean
 * the queue is empty at exactly the moment a run needs it, so every generation
 * failure would be a video not made — the failure mode this feature exists to
 * end, reintroduced one step later. Three leaves two spare runs' worth of
 * headroom, which at a daily cadence is two days for a provider outage to
 * resolve itself and for the backoff below to retry.
 */
export const REFILL_THRESHOLD = 3;

/**
 * How many topics one refill generates.
 *
 * Ten, which is between three and four weeks of a twice-weekly cadence and a
 * week and a half of a daily one. Larger batches are cheaper per topic — the
 * prompt and its evidence dominate the call — but a batch is also a commitment:
 * every topic in it was ranked against the analytics as they stood on the day it
 * was generated, and a queue of fifty is a queue that stops reflecting what is
 * working on the channel. Ten is small enough that the next batch has seen new
 * figures.
 */
export const REFILL_BATCH = 10;

/**
 * How long a worker holds one schedule's refill.
 *
 * Sized to the work, exactly as `CLAIM_LEASE_SECONDS` in schedule.service.ts is:
 * a refill is a handful of indexed reads and one short completion, so seconds
 * rather than the ten minutes a render takes. Ninety seconds comfortably outlasts
 * an honest attempt over a provider that is being slow, and still lets the next
 * tick retake a queue whose worker died rather than leaving it stuck.
 */
const REFILL_LEASE_SECONDS = 90;

/**
 * How long to wait after a failed refill, by consecutive failure count.
 *
 * The slow tick runs when the worker is idle, which on a quiet box is
 * continuously, so a failing refill with no gate would be a provider call every
 * few seconds — and if what is failing is an exhausted gateway budget, a few
 * thousand 402s a day in the log.
 *
 * Doubling-ish, capped at four hours, and the cap is not laziness: past that the
 * cause is not weather, and the thing that actually fixes it is an operator
 * adding a key or paying a bill. Retrying every four hours keeps the queue
 * filling itself the moment they do, without anybody having to come back and
 * press something.
 *
 * The run path ignores this entirely — see `refill`'s `ignoreBackoff`.
 */
const BACKOFF_MINUTES = [5, 15, 60, 240];

/**
 * How far back the reach evidence looks, in days.
 *
 * Thirty, matching `ANALYTICS_WINDOW_DAYS` in analytics.service.ts so the
 * "best-performing recent videos" this service feeds a model are the same ones
 * the dashboard calls best. Longer would rank against a channel that no longer
 * exists; shorter would rank against however many videos happened to go up last
 * week.
 */
const REACH_WINDOW_DAYS = 30;

/**
 * How many measured videos a channel needs before its own figures are used.
 *
 * Four. Below that, "the best two of three" is not a pattern, it is the order
 * they happened to be published in, and feeding it to a model as evidence would
 * be dressing up noise as a finding. A channel under this floor falls back to the
 * niche and the script style, and the prompt says which it is doing.
 */
const MIN_MEASURED_VIDEOS = 4;

/** How many videos the evidence is drawn from. The top and bottom of this sample
 *  become the two lists; the middle sets the retention floor below. */
const REACH_SAMPLE = 30;

/** Ceiling on each of the two lists. Enough titles for a pattern, few enough that
 *  the model is not being asked to average a page of them — and the prompt caps it
 *  at the same number, so this is about the read rather than the send. */
const EVIDENCE_PER_LIST = 5;

/**
 * How far back the "already covered" list looks.
 *
 * Bounded for the same reason easy mode bounds its own: the exclusion list handed
 * to the model has to stay short enough to read, and the query has to stay an
 * index scan.
 */
const COVERED_VIDEO_LIMIT = 40;

/** What one refill attempt did. A discriminated union rather than a nullable
 *  result, because the four "nothing happened" cases mean genuinely different
 *  things to the run path that calls this — see `ScheduleService.executeClaim`. */
export type TopicRefillOutcome =
  /** The queue was at or above the threshold. Nothing was spent. */
  | { status: "not-needed"; queued: number }
  /** Another worker holds this queue's refill lease. Nothing was spent, and the
   *  queue is about to grow without this caller doing anything. */
  | { status: "busy" }
  /** A previous attempt failed recently and the backoff has not elapsed. Only
   *  ever returned to the slow tick; the run path passes `ignoreBackoff`. */
  | { status: "deferred"; retryAt: Date }
  /** Topics were generated and appended, in the order given. */
  | { status: "filled"; scheduleId: string; added: string[] }
  /** Generation failed or came back unusable. `error` is a sentence safe to show
   *  the operator verbatim, because it ends up in `Schedule.pausedReason`. */
  | { status: "failed"; error: string; failures: number };

/**
 * The channel's own best and worst recent videos, read from the figures.
 *
 * A plain exported function over `VideoAnalytic` and `Publication`, separate from
 * the service, for one reason: this is the part of the feature that decides what
 * the model is told is good, and it must be assertable by inserting rows and
 * calling it. A ranking that can only be checked by reading a prompt sent to a
 * provider is a ranking nobody checks.
 *
 * ## How the two lists are chosen
 *
 * Views first, because views are what the owner's pattern is about and what the
 * 4x figure was measured in. `Publication.title` is what is returned — the text
 * actually sent to YouTube, which is the title the views were earned under, not
 * whatever the video row says now.
 *
 * `averageViewPercent` is then used for one specific correction, and it is worth
 * stating why it is not simply averaged in. A video high on views and low on
 * retention is not a subject that worked; it is a *title* that worked, on a video
 * people left. Copying its subject is the wrong lesson, and on a channel whose
 * whole pattern is "recognisable subject" it is exactly the trap — a famous name
 * pulls the click whether or not there is anything behind it. So a top-by-views
 * video whose retention is in the bottom quarter of the sample is dropped from
 * the winners rather than promoted for its views.
 *
 * Losers are the bottom of the same sample by views, worst first, with no
 * retention correction: a video nobody watched is a video nobody watched.
 */
export async function readReachEvidence(
  channelId: string | null,
  now: Date = new Date(),
): Promise<ReachEvidence> {
  if (!channelId) {
    return { winners: [], losers: [], source: "settings" };
  }

  const windowStart = new Date(now.getTime() - REACH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // The same shape `channelAnalyticsService.performanceFor` uses to build the
  // dashboard's "top videos", for the same reason: one row per publication with
  // its window totals, ordered by the figure that matters.
  const measured = await prisma.videoAnalytic.groupBy({
    by: ["publicationId"],
    where: {
      publication: { channelId, video: { deletedAt: null } },
      capturedFor: { gte: windowStart },
    },
    _sum: { views: true },
    _avg: { averageViewPercent: true },
    orderBy: { _sum: { views: "desc" } },
    take: REACH_SAMPLE,
  });

  if (measured.length < MIN_MEASURED_VIDEOS) {
    return { winners: [], losers: [], source: "settings" };
  }

  const rows = measured.map((row) => ({
    publicationId: row.publicationId,
    // `views` is a `BigInt` column; `Number` is safe at YouTube scale and is what
    // every other reader of this table does (see `toWindowTotals` in
    // channel-analytics.service.ts). `?? 0` rather than `?? 0n` because the
    // tsconfig target here predates BigInt literals.
    views: Number(row._sum.views ?? 0),
    retention: row._avg.averageViewPercent ?? 0,
  }));

  // The bottom quarter of retention across this sample. Computed from the sample
  // rather than from a fixed percentage because retention is wildly
  // format-dependent — 35% is excellent for an eight-minute explainer and poor
  // for a short — so the only honest comparison is against this channel's own
  // other videos. Zero when nothing has retention recorded, which disables the
  // correction rather than dropping every winner.
  const retentions = rows.map((row) => row.retention).sort((a, b) => a - b);
  const retentionFloor =
    retentions[retentions.length - 1] === 0
      ? 0
      : (retentions[Math.floor(retentions.length / 4)] ?? 0);

  // At most half the sample per list, capped at five. The cap is for the prompt's
  // sake; the half is correctness — on a channel with five measured videos, "the
  // top five" and "the bottom five" are the same five, and a model handed one list
  // as winners and the same list as losers has been told nothing at all.
  const perList = Math.max(1, Math.min(EVIDENCE_PER_LIST, Math.floor(rows.length / 2)));

  const winnerIds = rows
    .filter((row) => row.retention >= retentionFloor)
    .slice(0, perList)
    .map((row) => row.publicationId);

  const loserIds = rows
    .slice()
    .reverse()
    .filter((row) => !winnerIds.includes(row.publicationId))
    .slice(0, perList)
    .map((row) => row.publicationId);

  const titles = await prisma.publication.findMany({
    where: { id: { in: [...winnerIds, ...loserIds] } },
    select: { id: true, title: true },
  });

  const titleOf = new Map(titles.map((row) => [row.id, row.title]));
  const resolve = (ids: string[]): string[] =>
    ids
      .map((id) => titleOf.get(id)?.trim() ?? "")
      .filter((title) => title.length > 0);

  return {
    winners: resolve(winnerIds),
    losers: resolve(loserIds),
    source: "analytics",
  };
}

/** Everything one refill needs, read in a single query so the recipe cannot
 *  change underneath the generation. */
interface RefillContext {
  scheduleId: string;
  userId: string;
  name: string;
  channelId: string | null;
  seriesName: string | null;
  /** The script style these topics will be written with — the series' own, or the
   *  operator's default SCRIPT template. Null when neither resolves, which is an
   *  account that cannot generate anything anyway. */
  styleName: string | null;
  queued: number;
  nextPosition: number;
  failures: number;
}

export class TopicQueueService {
  /**
   * One seam, and it exists for the reason every other service's does: this file
   * bills the operator, and a test must be able to drive every path through it
   * without an API key. `Pick<…, "generateScript">` rather than the whole
   * provider because that is the only method called, and typing it wider would
   * force every test to stub synthesis and metadata to construct one.
   */
  constructor(
    private readonly generator: Pick<
      TextGenerationProvider,
      "generateScript"
    > = gatewayProvider,
  ) {}

  /**
   * Tops up one schedule's queue if it is running low.
   *
   * Called from two places, with the one difference between them named in the
   * options: `ScheduleService.executeClaim`, for a run that is about to need a
   * topic, passes `ignoreBackoff` because a schedule that is genuinely due is
   * worth one call whatever a failure four minutes ago said; the slow tick does
   * not, because it runs continuously on an idle worker.
   *
   * Never throws. Every provider failure, every unusable answer and every
   * missing precondition resolves to an outcome the caller can act on, because
   * the caller is either a worker loop that must not die or a run whose job is to
   * report what happened.
   */
  async refill(
    scheduleId: string,
    options: { ignoreBackoff?: boolean } = {},
  ): Promise<TopicRefillOutcome> {
    const now = new Date();

    // Cheap short-circuit before the lease is touched: this is an index-only
    // count on `[scheduleId, consumedAt, position]`, and it is false for almost
    // every schedule almost every tick.
    const queued = await this.countQueued(scheduleId);

    if (queued >= REFILL_THRESHOLD) {
      return { status: "not-needed", queued };
    }

    const lease = await this.takeLease(scheduleId, now, options.ignoreBackoff ?? false);

    if (lease.status !== "won") {
      return lease.outcome;
    }

    try {
      // Re-counted under the lease. The count above is a hint: between it and the
      // lease, the *other* worker's refill may have completed, in which case
      // there is nothing to do and the point of the lease was to discover that
      // rather than to generate a second batch.
      const context = await this.readContext(scheduleId);

      if (!context) {
        // Deleted between the count and the lease. Nothing to refill and nothing
        // to report — there is no schedule left to report it on.
        return { status: "not-needed", queued: 0 };
      }

      if (context.queued >= REFILL_THRESHOLD) {
        return { status: "not-needed", queued: context.queued };
      }

      return await this.generateInto(context, now);
    } finally {
      await this.releaseLease(scheduleId);
    }
  }

  /**
   * The slow tick: finds one schedule whose queue is low and refills it.
   *
   * One per call, exactly as `ScheduleService.tick` claims one schedule per call
   * and for the same reason — the worker's loop is shared with renders, and a
   * tick that refilled every low queue in a burst would hold it for the length of
   * several provider calls. The next tick takes the next one.
   *
   * Only ACTIVE, undeleted schedules. A paused schedule is not going to consume
   * anything, so generating for it would spend money on a queue nobody asked to
   * be filled; it gets its refill from the run path when the operator resumes it.
   */
  async tick(): Promise<TopicRefillOutcome | null> {
    const now = new Date();

    const candidates = await prisma.schedule.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        OR: [
          { topicRefillNextAttemptAt: null },
          { topicRefillNextAttemptAt: { lte: now } },
        ],
      },
      // Most imminent first: a queue needed tomorrow morning outranks one needed
      // next month. Nulls last is Prisma's default for `asc`, which is the right
      // way round — a schedule with no next occurrence is the least urgent thing
      // here.
      orderBy: { nextRunAt: "asc" },
      // Bounded for the same reason `CANDIDATE_BATCH` in schedule.service.ts is:
      // the list exists only so one low queue can be found without a second
      // round trip, and the next tick is ten seconds away. A deployment with more
      // than fifty active schedules refills the fifty most imminent first, which
      // is the right order to refill them in anyway.
      take: 50,
      select: {
        id: true,
        _count: { select: { topics: { where: { consumedAt: null } } } },
      },
    });

    const low = candidates.find(
      (candidate) => candidate._count.topics < REFILL_THRESHOLD,
    );

    if (!low) {
      return null;
    }

    return this.refill(low.id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async countQueued(scheduleId: string): Promise<number> {
    return prisma.scheduleTopic.count({
      where: { scheduleId, consumedAt: null },
    });
  }

  /**
   * Wins the right to refill this queue, or says why not.
   *
   * The conditional update *is* the lock, same as `ScheduleService.claimDue`:
   * `updateMany` has no `LIMIT`, so a read-then-write would let two workers both
   * believe the lease was free. The `where` repeats the exact state that makes a
   * refill permissible, so only one caller can match it.
   *
   * The two reasons for refusal are told apart by a follow-up read rather than
   * guessed at, because they mean opposite things upstream: `busy` means the queue
   * is about to be filled by somebody else and a due run should skip rather than
   * pause, while `deferred` means nothing is happening for a while yet.
   */
  private async takeLease(
    scheduleId: string,
    now: Date,
    ignoreBackoff: boolean,
  ): Promise<{ status: "won" } | { status: "refused"; outcome: TopicRefillOutcome }> {
    const free = [
      { topicRefillLeaseExpiresAt: null },
      { topicRefillLeaseExpiresAt: { lt: now } },
    ];

    const backoffElapsed = [
      { topicRefillNextAttemptAt: null },
      { topicRefillNextAttemptAt: { lte: now } },
    ];

    const { count } = await prisma.schedule.updateMany({
      where: {
        id: scheduleId,
        deletedAt: null,
        // Two `OR`s cannot both be keys of one object, so they are ANDed
        // explicitly. Without the second, a due run and a tick would apply the
        // same backoff and a rate limit at 08:59 would cost the 09:00 video.
        AND: ignoreBackoff
          ? [{ OR: free }]
          : [{ OR: free }, { OR: backoffElapsed }],
      },
      data: {
        topicRefillLeaseExpiresAt: new Date(
          now.getTime() + REFILL_LEASE_SECONDS * 1000,
        ),
      },
    });

    if (count === 1) {
      return { status: "won" };
    }

    const row = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: { topicRefillLeaseExpiresAt: true, topicRefillNextAttemptAt: true },
    });

    const held =
      row?.topicRefillLeaseExpiresAt !== null &&
      row?.topicRefillLeaseExpiresAt !== undefined &&
      row.topicRefillLeaseExpiresAt > now;

    if (held) {
      return { status: "refused", outcome: { status: "busy" } };
    }

    return {
      status: "refused",
      outcome: {
        status: "deferred",
        retryAt: row?.topicRefillNextAttemptAt ?? now,
      },
    };
  }

  private async releaseLease(scheduleId: string): Promise<void> {
    try {
      await prisma.schedule.updateMany({
        where: { id: scheduleId },
        data: { topicRefillLeaseExpiresAt: null },
      });
    } catch (error) {
      // Best-effort, and never allowed to throw out of `refill`'s `finally`: a
      // failure here would replace a real outcome — possibly a successful fill —
      // with a database error nobody can act on, and the lease expires by itself
      // ninety seconds later anyway. Same reasoning as
      // `ScheduleService.releaseClaim`.
      console.error(
        `Could not release the topic-refill lease on schedule ${scheduleId}:`,
        error,
      );
    }
  }

  /** Everything the generation needs, in one read. Held as a snapshot for the
   *  same reason `ScheduleClaim` is: the recipe used has to be the one that was
   *  true when the refill started. */
  private async readContext(scheduleId: string): Promise<RefillContext | null> {
    const row = await prisma.schedule.findFirst({
      where: { id: scheduleId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        name: true,
        topicRefillFailures: true,
        project: { select: { channelId: true } },
        series: {
          select: { name: true, promptTemplate: { select: { name: true } } },
        },
      },
    });

    if (!row) {
      return null;
    }

    const [queued, last, fallbackStyle] = await Promise.all([
      this.countQueued(scheduleId),
      prisma.scheduleTopic.findFirst({
        where: { scheduleId },
        orderBy: { position: "desc" },
        select: { position: true },
      }),
      // Only reached for a standalone schedule. A series names its own script
      // style, which is the one its episodes are written with, so using the
      // account default there would describe the wrong kind of video to the
      // model.
      row.series
        ? Promise.resolve(null)
        : prisma.promptTemplate.findFirst({
            where: {
              userId: row.userId,
              category: "SCRIPT",
              isDefault: true,
              deletedAt: null,
            },
            select: { name: true },
          }),
    ]);

    return {
      scheduleId: row.id,
      userId: row.userId,
      name: row.name,
      channelId: row.project.channelId,
      seriesName: row.series?.name ?? null,
      styleName: row.series?.promptTemplate.name ?? fallbackStyle?.name ?? null,
      queued,
      // Positions continue from the highest already stored rather than from the
      // count of unconsumed rows — the same rule `addTopics` follows, so a
      // generated batch never lands ahead of a topic the operator wrote earlier
      // and has been waiting on.
      nextPosition: (last?.position ?? -1) + 1,
      failures: row.topicRefillFailures,
    };
  }

  /** The billed part. Everything above it is free, and everything it can throw
   *  is turned into a `failed` outcome rather than an exception. */
  private async generateInto(
    context: RefillContext,
    now: Date,
  ): Promise<TopicRefillOutcome> {
    const wanted = REFILL_BATCH;

    let result: Awaited<ReturnType<TextGenerationProvider["generateScript"]>> | null =
      null;

    try {
      const [brand, reach, avoid] = await Promise.all([
        brandService.resolve(context.channelId),
        readReachEvidence(context.channelId, now),
        this.collectAvoidList(context.scheduleId, context.channelId, context.userId),
      ]);

      const apiKey =
        (await providerCredentialService.resolveKey(context.userId, "ANTHROPIC")) ??
        undefined;

      result = await this.generator.generateScript({
        prompt: buildSubjectPrompt({
          count: wanted,
          niche: brand.niche,
          tone: brand.tone,
          // Named "explainer" only as a last resort. An account with no default
          // SCRIPT template cannot generate a video at all, so this branch is
          // reached by a schedule that will be refused by its own readiness check
          // moments later; describing the style as unknown to the model is better
          // than refusing to fill a queue over it.
          styleName: context.styleName ?? "narrated explainer",
          avoid,
          reach,
        }),
        apiKey,
      });

      const added = this.dedupe(parseSubjects(result.content), avoid, wanted);

      if (added.length === 0) {
        return await this.recordFailure(
          context,
          now,
          "the model answered with nothing usable.",
          result,
        );
      }

      await prisma.scheduleTopic.createMany({
        data: added.map((topic, index) => ({
          scheduleId: context.scheduleId,
          position: context.nextPosition + index,
          topic,
          generated: true,
        })),
      });

      await prisma.schedule.updateMany({
        where: { id: context.scheduleId },
        data: { topicRefillFailures: 0, topicRefillNextAttemptAt: null },
      });

      await prisma.providerUsage.create({
        data: {
          provider: result.provider,
          operation: "topic.refill",
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          succeeded: true,
        },
      });

      // Names the topics, not the count. "10 topics added" is a number the
      // operator cannot check; the list is the thing that lets them look at what
      // the studio chose on their behalf and say no to it.
      await prisma.activityLog.create({
        data: {
          userId: context.userId,
          action: "schedule.topics.refill",
          entityType: "Schedule",
          entityId: context.scheduleId,
          message:
            `Queued ${added.length} generated topic${added.length === 1 ? "" : "s"} ` +
            `for "${context.seriesName ?? context.name}": ${added.join("; ")}`,
          metadata: {
            topics: added,
            queuedBefore: context.queued,
            reachSource: reach.source,
            winners: reach.winners,
          },
        },
      });

      return { status: "filled", scheduleId: context.scheduleId, added };
    } catch (error) {
      return await this.recordFailure(
        context,
        now,
        messageOf(error),
        result,
      );
    }
  }

  /**
   * Records a failed attempt and sets the backoff.
   *
   * The `ProviderUsage` row is written with whatever the provider was actually
   * paid for, not zeros — the same rule `ScriptService` follows. A call that
   * resolved and then produced nothing usable cost real money, and recording it
   * as free would make real spend invisible on the cost page. Zeros are correct
   * only when the provider threw before returning, which is the one case
   * `result` is still null.
   */
  private async recordFailure(
    context: RefillContext,
    now: Date,
    reason: string,
    result: Awaited<ReturnType<TextGenerationProvider["generateScript"]>> | null,
  ): Promise<TopicRefillOutcome> {
    const failures = context.failures + 1;
    const wait = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] ?? 240;

    try {
      await prisma.schedule.updateMany({
        where: { id: context.scheduleId },
        data: {
          topicRefillFailures: failures,
          topicRefillNextAttemptAt: new Date(now.getTime() + wait * 60 * 1000),
        },
      });

      await prisma.providerUsage.create({
        data: {
          provider: result?.provider ?? "ANTHROPIC",
          operation: "topic.refill",
          model: result?.model ?? null,
          inputTokens: result?.inputTokens ?? 0,
          outputTokens: result?.outputTokens ?? 0,
          costUsd: result?.costUsd ?? 0,
          // Null rather than 0 when nothing was ever called: a zero here would
          // claim a request that took no time, where null says there was no
          // request.
          latencyMs: result?.latencyMs ?? null,
          succeeded: false,
        },
      });

      await prisma.activityLog.create({
        data: {
          userId: context.userId,
          level: "WARN",
          action: "schedule.topics.refill",
          entityType: "Schedule",
          entityId: context.scheduleId,
          message:
            `Could not generate topics for "${context.seriesName ?? context.name}": ` +
            `${reason} Retrying in ${wait} minutes.`,
          metadata: { failures, retryInMinutes: wait },
        },
      });
    } catch (error) {
      // The bookkeeping failing must not turn a reported failure into a thrown
      // one: the caller may be a due run that has to write an outcome either way.
      console.error(
        `Could not record a failed topic refill for schedule ${context.scheduleId}:`,
        error,
      );
    }

    return { status: "failed", error: reason, failures };
  }

  /**
   * Everything this schedule must not suggest again.
   *
   * Three sources, and all three are needed. The schedule's own topics — queued
   * *and* consumed — because a subject already made is the most annoying possible
   * suggestion, and a subject already waiting would be the same video twice. And
   * the channel's video titles and topics, because a schedule that is one of two
   * on a channel would otherwise re-cover what the other one made.
   *
   * The list goes into the prompt, and the model is also checked against it
   * afterwards in `dedupe` — a prompt is a request, not a constraint.
   */
  private async collectAvoidList(
    scheduleId: string,
    channelId: string | null,
    userId: string,
  ): Promise<string[]> {
    const [own, videos] = await Promise.all([
      prisma.scheduleTopic.findMany({
        where: { scheduleId },
        orderBy: { position: "desc" },
        take: COVERED_VIDEO_LIMIT,
        select: { topic: true },
      }),
      channelId
        ? prisma.video.findMany({
            where: { userId, deletedAt: null, project: { channelId } },
            orderBy: { createdAt: "desc" },
            take: COVERED_VIDEO_LIMIT,
            select: { title: true, topic: true },
          })
        : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const avoid: string[] = [];

    for (const entry of [
      ...own.map((row) => row.topic),
      ...videos.flatMap((video) => [video.topic ?? "", video.title]),
    ]) {
      const text = entry.trim();
      const key = normaliseSubject(text);

      if (text.length === 0 || key.length === 0 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      avoid.push(text);
    }

    return avoid;
  }

  /**
   * Drops anything the model repeated, from the avoid-list or from itself.
   *
   * Case- and punctuation-insensitive on normalised text, because a model handed
   * "do not suggest X" will cheerfully answer "X." — and because the whole
   * promise of this feature is that nobody has to read the queue to check it for
   * repeats.
   */
  private dedupe(
    subjects: string[],
    avoid: readonly string[],
    limit: number,
  ): string[] {
    const seen = new Set(avoid.map(normaliseSubject));
    const kept: string[] = [];

    for (const subject of subjects) {
      if (kept.length >= limit) break;

      const key = normaliseSubject(subject);

      // Dropped here rather than in `parseSubjects`, so easy mode's picker keeps
      // the exact tolerance it has always had. The queue cannot afford it: nobody
      // reads this list before a run takes the head of it, so "I'd be happy to
      // help with that!" would become a rendered video on a real channel.
      if (key.length === 0 || seen.has(key) || looksLikeModelChatter(subject)) {
        continue;
      }

      seen.add(key);
      kept.push(subject);
    }

    return kept;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const topicQueueService = new TopicQueueService();
