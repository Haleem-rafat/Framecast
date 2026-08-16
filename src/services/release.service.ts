import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  PublishVisibility,
  ScheduleRunOutcome,
  ScheduleStatus,
} from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  advancePastSlots,
  describeSlots,
  firstSlotAfter,
  normaliseSlots,
  type SlotRecurrence,
  upcomingSlots,
} from "@/lib/release-time";
import { statShortFile } from "@/lib/shorts-storage";
import type {
  CreateReleaseCadenceInput,
  UpdateReleaseCadenceInput,
} from "@/schemas/release.schema";
import { publishService, type PublishService, YouTubeQuotaError } from "@/services/publish.service";

/**
 * The shorts drip: a channel's banked clips, released on a timer.
 *
 * ## What this is, and what it deliberately is not
 *
 * The operator runs three channels and wants three long videos a week and
 * three shorts a day on each. The long half is three `WEEKLY` schedules per
 * channel and already worked. The obvious way to build the short half —
 * a `DAILY` frequency on `Schedule` — is the expensive way: it would generate
 * twenty-one *fresh* videos a week per channel, for content the operator has
 * already paid to produce. The week's three long videos each yield around
 * seven clips; three sevens is exactly the twenty-one a week that three-a-day
 * spends. So the shorts half is not a production schedule at all. It is a
 * **release queue with a timer on it**, and releasing a banked clip is an
 * upload of a file that already exists. Nothing in this file calls a model.
 * Nothing in this file can spend provider money.
 *
 * `Schedule` is untouched by all of it — no new frequency, no shorts, no new
 * columns. This is a second, much cheaper worker path beside it.
 *
 * ## What it borrows from `ScheduleService`, unchanged
 *
 * The concurrency discipline, in full, because that design is right and a
 * second pattern for the same problem would be a second thing to get wrong:
 *
 *   * **Firing twice** is prevented by a conditional update whose `where`
 *     repeats the exact `nextReleaseAt` just read, with the *advance* folded
 *     into the winning write — see `claimDue`. After it lands, no caller's
 *     `where` can match that row again, because the value is gone.
 *   * **Firing in a burst after downtime** is prevented by `advancePastSlots`,
 *     which treats a slot as a moment rather than a debt.
 *   * **Firing at the wrong time twice a year** is prevented by storing
 *     wall-clock minutes plus a zone and deriving the instant — see
 *     src/lib/release-time.ts, which is built on the same
 *     `wallClockToInstant` the scheduler uses and inherits its answers for the
 *     hour DST deletes and the hour it repeats.
 *   * **A history row per occurrence**, written before anything is attempted,
 *     with a unique constraint behind the claim as a backstop.
 *
 * ## The one place it deliberately differs
 *
 * An empty queue. A `Schedule` with no topics left **pauses itself**, because a
 * schedule that cannot say what to make must stop rather than improvise. A
 * cadence with nothing banked has not failed and must not pause: it means the
 * operator has not published a long video this week, and the drip has to resume
 * by itself the moment one lands. So an empty queue writes a SKIPPED run with a
 * reason, moves `lastReleaseAt`, leaves `consecutiveFailures` alone, and the
 * cadence stays ACTIVE. See `executeClaim`.
 */

/**
 * How long a worker holds a claimed slot.
 *
 * Sized to the work, like `CLAIM_LEASE_SECONDS` in schedule.service.ts: a
 * release is one file read off local disk and one `videos.insert` — tens of
 * megabytes over a network to a provider that can hang, but not a render.
 * Five minutes comfortably outlasts an honest upload on a domestic uplink and
 * still lets the next poll retake a cadence whose worker died, rather than
 * stranding it for a full render's lease.
 *
 * The lease is *not* what prevents a double release — `nextReleaseAt` is
 * already advanced past this slot by the time it is taken. Its narrower job is
 * to stop a second worker starting the *next* slot of a cadence whose current
 * upload is still in flight, which for a six-hour gap is impossible anyway and
 * for a stuck upload would otherwise pile clips onto the channel.
 */
const CLAIM_LEASE_SECONDS = 300;

/**
 * How many consecutive failures pause a cadence.
 *
 * The same three as everywhere else here, and the case it exists for is the
 * YouTube upload quota. `videos.insert` costs about 100 units against a
 * hundred-a-day allowance that belongs to the **Google Cloud project**, not to
 * the channel — so three channels dripping nine clips a day share one bucket,
 * and when it runs out every cadence fails identically. Retrying that on every
 * slot forever would be a silent loop that publishes nothing and says nothing.
 * Pausing costs the operator a day of clips and buys them a sentence on the
 * cadence naming the real cause.
 *
 * Only *consecutive* failures count, and an empty queue is not one.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Candidates read per due-check. Same small number and same purpose as
 *  `ScheduleService.claimDue`'s: the list exists only so a lost race falls
 *  through to another row instead of waiting for the next poll. */
const CANDIDATE_BATCH = 5;

/**
 * How far down the queue one slot will look for a clip whose file is still on
 * disk.
 *
 * A short whose file has gone is not releasable, and leaving it at the head
 * would stall the whole drip on it forever — every slot, every day, until
 * somebody noticed. So a missing file marks that short FAILED (which takes it
 * out of the queue for good) and the slot moves on to the next clip rather than
 * being spent on the discovery. Bounded, because "walk the queue until
 * something works" on a cadence whose entire bank was deleted would be an
 * unbounded scan inside the worker's poll.
 */
const MAX_QUEUE_SCAN = 5;

/** How many banked clips the detail page lists, paired with the slots they are
 *  due to go out in. Enough to cover several days at three a day without
 *  loading a bank that can run to a hundred rows. */
const QUEUE_PREVIEW = 20;

/** How many history rows the detail page shows. Same number as a schedule's,
 *  which at three a day is about a fortnight. */
const RUN_HISTORY_LIMIT = 60;

/**
 * Placeholder outcome for a release that has begun but not reported.
 *
 * Same arrangement as `ScheduleService`'s `IN_FLIGHT_REASON`, and it reads
 * correctly for a worker killed mid-upload: the release started and never came
 * back. Which is also the one case where a clip may be on YouTube with no
 * successful record of it — the `ShortPublication` row left at UPLOADING is
 * where that shows.
 */
const IN_FLIGHT_REASON =
  "The release started but the worker never reported an outcome — it was most " +
  "likely restarted or killed mid-upload.";

/** The sentence an operator reads when a slot came round and the bank was
 *  empty. Deliberately not phrased as a fault: it is the normal state of a
 *  cadence whose long videos have not produced clips yet. */
const EMPTY_QUEUE_REASON =
  "Nothing was banked when this slot came round. Shorts are cut from finished " +
  "videos, so the drip starts again by itself as soon as this channel has " +
  "rendered shorts waiting.";

export interface ReleaseQueueEntry {
  shortId: string;
  /** Position in its own video's set, 0-based — the panel shows `index + 1`. */
  index: number;
  /** The clip's own title, or null for one the model never named. The video's
   *  title is shown beside it either way, so an unnamed clip is still legible. */
  title: string | null;
  videoId: string;
  videoTitle: string;
  /** When this clip is due to go out, derived by pairing queue position with
   *  upcoming slots. Null past the preview horizon, and null while paused —
   *  a paused cadence has no upcoming slots to pair with. */
  releasesAt: Date | null;
}

export interface ReleaseRunRecord {
  id: string;
  scheduledFor: Date;
  outcome: ScheduleRunOutcome;
  reason: string | null;
  shortTitle: string | null;
  youtubeVideoId: string | null;
  shortId: string | null;
  createdAt: Date;
}

export interface ReleaseCadenceSummary {
  id: string;
  channelId: string;
  channelTitle: string;
  status: ScheduleStatus;
  pausedReason: string | null;
  slotMinutes: number[];
  timeZone: string;
  visibility: PublishVisibility;
  /** One line describing the cadence, built once here so the list, the detail
   *  page and the history all phrase it identically. */
  cadence: string;
  /** Null while paused-and-never-resumed. Meaningless while paused anyway —
   *  the UI says "paused" rather than showing a time that will not happen. */
  nextReleaseAt: Date | null;
  lastReleaseAt: Date | null;
  consecutiveFailures: number;
  /** Rendered, unpublished clips waiting on this channel. Zero is a normal
   *  number and the UI must not draw it as a fault. */
  bankedCount: number;
  /**
   * Roughly how long the bank lasts at this cadence, in days.
   *
   * The number the operator actually acts on. "Fourteen clips banked" means
   * nothing without knowing the drip spends three a day; "about four days of
   * cover" is the same fact in the units the decision is made in — whether to
   * go and record another long video this week.
   */
  daysOfCover: number;
  /** The clip the next slot will take, so the operator can see what is coming
   *  without opening the cadence. */
  nextShortTitle: string | null;
}

export interface ReleaseCadenceDetail extends ReleaseCadenceSummary {
  queue: ReleaseQueueEntry[];
  runs: ReleaseRunRecord[];
  /** True while a worker holds this cadence. Surfaced so "Pause" can explain
   *  that an upload already under way will still finish. */
  releaseInFlight: boolean;
}

/** What one due-check produced, for the worker's log. Null from `tick` means
 *  nothing was due. */
export interface ReleaseTickResult {
  cadenceId: string;
  channelTitle: string;
  scheduledFor: Date;
  outcome: ScheduleRunOutcome;
  reason: string | null;
  shortId: string | null;
  youtubeVideoId: string | null;
}

/** A cadence won by `claimDue`, carrying everything `executeClaim` needs so it
 *  never re-reads a row another process may have moved underneath it. */
interface ReleaseClaim {
  cadenceId: string;
  userId: string;
  channelId: string;
  channelTitle: string;
  visibility: PublishVisibility;
  /** The slot being released — the `nextReleaseAt` value just replaced. */
  dueAt: Date;
  /** Slots stepped over on the way here, oldest first. */
  skipped: Date[];
  skippedTotal: number;
}

/** The timing columns, in the shape src/lib/release-time.ts works in. */
function recurrenceOf(row: { slotMinutes: number[]; timeZone: string }): SlotRecurrence {
  return { slotMinutes: row.slotMinutes, timeZone: row.timeZone };
}

/** Prisma's unique-constraint violation, recognised without importing the
 *  runtime error class. Same helper, same reasoning, as schedule.service.ts. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReleaseService {
  /**
   * `Pick`, not the whole `PublishService`, for the same reason `ScheduleService`
   * takes a `Pick<AutomationService>`: this service calls exactly one of its
   * methods, and typing the parameter as the full class would force every test
   * to stub the publish path, the thumbnail path and the reclaims as well.
   * Injected at all so a test can drive a whole tick — claim, queue, file
   * guard, history — against a fake upload instead of calling YouTube.
   */
  constructor(
    private readonly publisher: Pick<PublishService, "publishShort"> = publishService,
  ) {}

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  async list(userId: string): Promise<ReleaseCadenceSummary[]> {
    const rows = await prisma.releaseCadence.findMany({
      where: { userId },
      orderBy: [{ status: "asc" }, { nextReleaseAt: "asc" }, { createdAt: "asc" }],
      include: { channel: { select: { title: true } } },
    });

    // One count and one head-of-queue read per cadence rather than one query
    // with a join, because the queue's ordering crosses two tables (oldest
    // video, then index within it) and there is no aggregate that expresses
    // "the first row of that ordering, per cadence". The list is a handful of
    // rows — one per connected channel — so this is a handful of indexed
    // queries, run in parallel.
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  async get(userId: string, id: string): Promise<ReleaseCadenceDetail> {
    const row = await prisma.releaseCadence.findFirst({
      where: { id, userId },
      include: { channel: { select: { title: true } } },
    });

    if (!row) {
      throw new NotFoundError("Release cadence");
    }

    const [summary, queue, runs] = await Promise.all([
      this.toSummary(row),
      this.listQueue(userId, row, QUEUE_PREVIEW),
      prisma.releaseRun.findMany({
        where: { cadenceId: id },
        orderBy: { scheduledFor: "desc" },
        take: RUN_HISTORY_LIMIT,
        select: {
          id: true,
          scheduledFor: true,
          outcome: true,
          reason: true,
          shortTitle: true,
          youtubeVideoId: true,
          shortId: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ...summary,
      queue,
      runs,
      releaseInFlight: row.claimExpiresAt !== null && row.claimExpiresAt > new Date(),
    };
  }

  private async toSummary(row: {
    id: string;
    userId: string;
    channelId: string;
    channel: { title: string };
    status: ScheduleStatus;
    pausedReason: string | null;
    slotMinutes: number[];
    timeZone: string;
    visibility: PublishVisibility;
    nextReleaseAt: Date | null;
    lastReleaseAt: Date | null;
    consecutiveFailures: number;
  }): Promise<ReleaseCadenceSummary> {
    const where = this.bankedShortsWhere(row.userId, row.channelId);

    const [bankedCount, head] = await Promise.all([
      prisma.short.count({ where }),
      prisma.short.findFirst({
        where,
        orderBy: this.queueOrder(),
        select: { title: true, index: true, video: { select: { title: true } } },
      }),
    ]);

    const perDay = Math.max(normaliseSlots(row.slotMinutes).length, 1);

    return {
      id: row.id,
      channelId: row.channelId,
      channelTitle: row.channel.title,
      status: row.status,
      pausedReason: row.pausedReason,
      slotMinutes: row.slotMinutes,
      timeZone: row.timeZone,
      visibility: row.visibility,
      cadence: describeSlots(recurrenceOf(row)),
      nextReleaseAt: row.nextReleaseAt,
      lastReleaseAt: row.lastReleaseAt,
      consecutiveFailures: row.consecutiveFailures,
      bankedCount,
      // Floored, never rounded up: "about two days of cover" when there is one
      // and a half is the direction that gets a video recorded in time.
      daysOfCover: Math.floor(bankedCount / perDay),
      nextShortTitle: head
        ? (head.title ?? `${head.video.title} — Short ${head.index + 1}`)
        : null,
    };
  }

  /**
   * The queue, in the order it will be spent, paired with the slots that will
   * spend it.
   *
   * The pairing is the whole point of showing a queue at all. A list of banked
   * clips answers "what have I got"; a list that says *when each one goes out*
   * answers "is Thursday covered", which is the question an operator opens this
   * page with. It is a projection, not a promise — a clip generated tomorrow
   * lands ahead of nothing, but a video finished tomorrow adds clips behind
   * these, and a slot that finds a missing file skips one along. Both are fine:
   * the projection is exactly right for the ordering as it stands now.
   */
  private async listQueue(
    userId: string,
    cadence: {
      channelId: string;
      slotMinutes: number[];
      timeZone: string;
      status: ScheduleStatus;
      nextReleaseAt: Date | null;
    },
    take: number,
  ): Promise<ReleaseQueueEntry[]> {
    const shorts = await prisma.short.findMany({
      where: this.bankedShortsWhere(userId, cadence.channelId),
      orderBy: this.queueOrder(),
      take,
      select: {
        id: true,
        index: true,
        title: true,
        video: { select: { id: true, title: true } },
      },
    });

    // A paused cadence has no upcoming slots, so its queue is listed with no
    // times rather than with times that will not happen — the same rule the
    // summary follows for `nextReleaseAt`.
    const slots =
      cadence.status === "ACTIVE" && cadence.nextReleaseAt && shorts.length > 0
        ? [
            cadence.nextReleaseAt,
            ...upcomingSlots(recurrenceOf(cadence), cadence.nextReleaseAt, shorts.length - 1),
          ]
        : [];

    return shorts.map((short, position) => ({
      shortId: short.id,
      index: short.index,
      title: short.title,
      videoId: short.video.id,
      videoTitle: short.video.title,
      releasesAt: slots[position] ?? null,
    }));
  }

  /**
   * What is releasable, and it is the same predicate the batch publish path
   * uses (`publishableShortsWhere` in publish.service.ts) with the channel
   * added.
   *
   * Rendered (`READY` with an `outputPath` — belt and braces, since
   * `renderShort` writes both in one update), and unclaimed: any
   * `ShortPublication` row at all takes a clip out of the queue, FAILED
   * included, because publishing is one-shot and a failed attempt may already
   * have left the clip on YouTube.
   */
  private bankedShortsWhere(userId: string, channelId: string): Prisma.ShortWhereInput {
    return {
      status: "READY",
      outputPath: { not: null },
      publication: { is: null },
      video: {
        userId,
        deletedAt: null,
        project: { channelId, deletedAt: null },
        // A clip of an episode goes out on that show's channel or it does not
        // go out.
        //
        // The channel above comes through the project, which is how the
        // renderer and `PublishService` resolve it. A series keeps its own copy
        // and every series screen shows *that* — so for a row where the two
        // disagree, this cadence would otherwise drip a children's show's clips
        // onto a personal finance channel, on a timer, days after anyone looked
        // at it. `PublishService.resolvePublishTarget` refuses the parent video
        // outright in the same state; this is the same refusal on the path that
        // has no operator in front of it at all.
        //
        // The clips are not lost: they stay banked, and go out on the next slot
        // after the disagreement is resolved — which is the point, since
        // resolving it is a decision only the operator can make.
        OR: [{ seriesId: null }, { series: { channelId } }],
      },
    };
  }

  /**
   * Oldest source video first, then position within that video.
   *
   * Both halves matter. Ordering by the *video* rather than by the short's own
   * `createdAt` keeps a video's clips together and in sequence, which is what
   * makes the drip read as a series rather than a shuffle; ordering by `index`
   * within it means clip 1 goes out before clip 7, as the model numbered them.
   * Oldest-first because a bank that released newest-first would leave the
   * first video's clips at the bottom forever, going stale.
   */
  private queueOrder(): Prisma.ShortOrderByWithRelationInput[] {
    return [{ video: { createdAt: "asc" } }, { index: "asc" }];
  }

  // -------------------------------------------------------------------------
  // Operator actions
  // -------------------------------------------------------------------------

  async create(
    userId: string,
    input: CreateReleaseCadenceInput,
  ): Promise<{ id: string }> {
    await this.assertUsableChannel(userId, input.channelId);

    const existing = await prisma.releaseCadence.findUnique({
      where: { channelId: input.channelId },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        "This channel already has a release cadence. Edit that one rather than adding a second — two cadences would race for the same queue of shorts.",
      );
    }

    const recurrence = { slotMinutes: input.slotMinutes, timeZone: input.timeZone };

    // The first release is the next time one of these times comes round, never
    // "now". An operator setting up 08:00/14:00/20:00 at 14:05 must not have a
    // clip appear on their channel the moment they press Save — they were
    // describing a cadence, not asking for something immediately.
    const nextReleaseAt = firstSlotAfter(recurrence, new Date());

    return prisma.releaseCadence.create({
      data: {
        userId,
        channelId: input.channelId,
        slotMinutes: input.slotMinutes,
        timeZone: input.timeZone,
        visibility: input.visibility,
        nextReleaseAt,
      },
      select: { id: true },
    });
  }

  async update(
    userId: string,
    id: string,
    input: UpdateReleaseCadenceInput,
  ): Promise<void> {
    const existing = await this.requireOwned(userId, id);

    // `nextReleaseAt` is recomputed only when the *timing* changed. Doing it
    // unconditionally would mean switching a cadence from public to unlisted at
    // 07:59 pushes that morning's release to 14:00 — a destructive side effect
    // of an edit that had nothing to do with time.
    const timingChanged =
      existing.timeZone !== input.timeZone ||
      normaliseSlots(existing.slotMinutes).join(",") !==
        normaliseSlots(input.slotMinutes).join(",");

    await prisma.releaseCadence.update({
      where: { id },
      data: {
        slotMinutes: input.slotMinutes,
        timeZone: input.timeZone,
        visibility: input.visibility,
        ...(timingChanged && existing.status === "ACTIVE"
          ? {
              nextReleaseAt: firstSlotAfter(
                { slotMinutes: input.slotMinutes, timeZone: input.timeZone },
                new Date(),
              ),
            }
          : {}),
      },
    });
  }

  /**
   * Stops the drip, immediately.
   *
   * "Immediately" is exact: `claimDue` reads `status: "ACTIVE"`, so the very
   * next due-check ignores this row. What pausing cannot do is recall an upload
   * already in flight — that release has a lease and its bytes may already be
   * with YouTube, and there is no unpublish path from this app. The detail page
   * reports `releaseInFlight` so the operator is told this rather than left
   * wondering why a clip appeared after they pressed Pause.
   */
  async pause(userId: string, id: string, reason?: string): Promise<void> {
    await this.requireOwned(userId, id);

    await prisma.releaseCadence.updateMany({
      where: { id, userId },
      data: { status: "PAUSED", pausedReason: reason ?? null },
    });
  }

  /**
   * Restarts a paused cadence from the next future slot.
   *
   * Never from the stored `nextReleaseAt`: that is a slot in the past, and
   * resuming a cadence paused a week ago would release a clip the moment the
   * worker next polled — at whatever time of day that happened to be, which is
   * precisely what the slots exist to prevent.
   *
   * Deliberately *not* refused for an empty queue, unlike `ScheduleService.resume`.
   * A schedule resumed with no topics would pause itself again on its first
   * occurrence, so refusing saves the operator a confusing round trip. A cadence
   * with nothing banked simply skips until something is, which is the correct
   * behaviour and not a round trip at all — and an operator who has just fixed
   * a quota problem should not have to wait for a render to finish before they
   * can turn their channel back on.
   */
  async resume(userId: string, id: string): Promise<void> {
    const existing = await this.requireOwned(userId, id);

    await prisma.releaseCadence.updateMany({
      where: { id, userId },
      data: {
        status: "ACTIVE",
        pausedReason: null,
        // A cadence that paused itself after repeated failures gets a clean
        // slate: the operator resuming it is asserting they fixed the cause,
        // and leaving the counter at three would pause it again on the next
        // single failure.
        consecutiveFailures: 0,
        nextReleaseAt: firstSlotAfter(recurrenceOf(existing), new Date()),
      },
    });
  }

  /** Hard delete, and it takes the history with it — see `ReleaseCadence`'s own
   *  comment for why this row cannot be soft-deleted. Nothing about the banked
   *  shorts changes: they stay READY and unpublished, and a new cadence on the
   *  same channel finds exactly the same queue. */
  async remove(userId: string, id: string): Promise<void> {
    await this.requireOwned(userId, id);

    await prisma.releaseCadence.deleteMany({ where: { id, userId } });
  }

  // -------------------------------------------------------------------------
  // The worker path
  // -------------------------------------------------------------------------

  /**
   * One due-check. Claims at most one slot and releases it; returns null when
   * nothing was due.
   *
   * **At most one, and this is also the answer to per-channel stagger.** Three
   * channels all set to 08:00 would otherwise queue three uploads at the same
   * instant on a 2-vCPU box that is also rendering — three tens-of-megabytes
   * buffers on top of whatever the render loop is holding. Because a tick wins
   * exactly one cadence and returns, three due cadences are released on three
   * successive ticks, one upload at a time, seconds apart.
   *
   * Serialising here rather than staggering the operator's chosen times when a
   * cadence is created, which was the alternative. Staggering defaults is
   * defeated by the operator typing the same three times into all three
   * cadences, which is exactly what somebody running three channels off one
   * content calendar will do — it protects the box only while nobody exercises
   * the form. Serialising the tick holds regardless of what times are chosen,
   * needs no explanation on the form, and costs a release that loses the draw
   * one poll interval, against slots hours apart.
   *
   * The tick is also cheap enough to sit in the render worker's loop: one
   * indexed query that almost always returns nothing.
   */
  async tick(): Promise<ReleaseTickResult | null> {
    const claim = await this.claimDue();

    if (!claim) {
      return null;
    }

    return this.executeClaim(claim);
  }

  /**
   * Wins exactly one due cadence, advancing it past this slot in the same
   * write.
   *
   * ## Why this cannot release twice
   *
   * The same shape as `ScheduleService.claimDue`, for the same reason: Prisma's
   * `updateMany` has no `LIMIT`, so an unconditional "claim the oldest due
   * cadence" would let two callers both match and both believe they won.
   * Instead: read a short list of candidates, then try to win each with an
   * update whose `where` repeats the exact state just read — here, the exact
   * `nextReleaseAt` value. The conditional update *is* the lock; the read above
   * it is only a hint.
   *
   * The part that makes it airtight is what the winning write does: it sets
   * `nextReleaseAt` to the next future slot **in the same statement that wins
   * the row**. After that write, no caller's `where: { nextReleaseAt: dueAt }`
   * can ever match this row again, because the value is gone. There is no
   * window between "won" and "advanced" for a second tick to slip through,
   * which there would be if the advance were a second statement — and on this
   * path that window would mean the same clip uploaded to the same channel
   * twice, with no way to take either copy down from here.
   *
   * ## Why this cannot release in a burst
   *
   * `advancePastSlots` walks the cadence forward until it is genuinely in the
   * future rather than adding six hours to the slot that just fired. A worker
   * that has been down for two days therefore releases one clip and records the
   * rest as missed — not six clips in ninety seconds onto a channel whose
   * audience is asleep.
   */
  async claimDue(): Promise<ReleaseClaim | null> {
    const now = new Date();

    const candidates = await prisma.releaseCadence.findMany({
      where: {
        status: "ACTIVE",
        nextReleaseAt: { lte: now },
        // A cadence whose previous release is still in flight, or whose worker
        // died holding it. The lapsed case is why this is a lease and not a
        // lock: nothing else would ever clear a dead worker's claim.
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
      },
      orderBy: { nextReleaseAt: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        channelId: true,
        slotMinutes: true,
        timeZone: true,
        visibility: true,
        nextReleaseAt: true,
        channel: { select: { title: true } },
      },
    });

    for (const candidate of candidates) {
      const dueAt = candidate.nextReleaseAt;

      // Cannot happen — `nextReleaseAt: { lte: now }` excludes nulls — but the
      // column is nullable and the compiler is right to insist.
      if (!dueAt) {
        continue;
      }

      let advanced;

      try {
        advanced = advancePastSlots(recurrenceOf(candidate), dueAt, now);
      } catch (error) {
        // A cadence that cannot be advanced is a corrupt row — an empty
        // `slotMinutes`, a zone that has stopped resolving. Pausing it is the
        // only safe response: leaving it ACTIVE means every future poll
        // re-reads it, re-throws, and logs the same error forever.
        await this.pauseCorruptCadence(candidate.id, messageOf(error));
        continue;
      }

      const { count } = await prisma.releaseCadence.updateMany({
        where: {
          id: candidate.id,
          status: "ACTIVE",
          // The lock. Only one caller can still match this exact value.
          nextReleaseAt: dueAt,
          OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        },
        data: {
          nextReleaseAt: advanced.nextReleaseAt,
          claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
          // Moved even for a slot that releases nothing: this records that the
          // due-check looked, which is the question the operator is asking when
          // no short appeared.
          lastReleaseAt: now,
        },
      });

      if (count === 1) {
        return {
          cadenceId: candidate.id,
          userId: candidate.userId,
          channelId: candidate.channelId,
          channelTitle: candidate.channel.title,
          visibility: candidate.visibility,
          dueAt,
          skipped: advanced.skipped,
          skippedTotal: advanced.skippedTotal,
        };
      }
    }

    return null;
  }

  /**
   * Releases one claimed slot, and writes down what happened either way.
   *
   * The order of operations is the safety argument, and it is
   * `ScheduleService.executeClaim`'s with the money removed and the
   * irreversibility put in its place — nothing here can be un-uploaded, so
   * every cheap reason to refuse is checked before a byte moves:
   *
   *   1. Missed slots are recorded (free, and explains a gap in history).
   *   2. The history row for *this* slot is inserted, before anything else. Its
   *      unique constraint on `[cadenceId, scheduledFor]` is the backstop
   *      behind `claimDue`'s lock: if two ticks somehow both believed this slot
   *      was theirs, the second fails here, before YouTube is called.
   *   3. The channel still has to be connected.
   *   4. A releasable clip has to exist — banked, and with its file still on
   *      disk. An empty bank is a skip and not a failure.
   *   5. Only then, the upload.
   *
   * The lease is released in `finally` regardless of which of those refused,
   * because a cadence left holding one is a cadence that skips its next slot
   * too.
   */
  async executeClaim(claim: ReleaseClaim): Promise<ReleaseTickResult | null> {
    try {
      await this.recordMissedSlots(claim);

      const runId = await this.openRunRecord(claim);

      if (!runId) {
        // Another tick already owns this slot. Nothing was uploaded.
        return null;
      }

      const blocked = await this.findBlockingReason(claim);

      if (blocked) {
        return this.finishRun(claim, runId, {
          outcome: "SKIPPED",
          reason: blocked.reason,
          pauseWith: blocked.pause ? blocked.reason : null,
        });
      }

      const next = await this.takeReleasable(claim);

      if (!next) {
        // The empty queue, and the one place this service deliberately parts
        // company with `ScheduleService`: recorded, and explicitly *not* a
        // failure. `consecutiveFailures` is untouched and the cadence stays
        // ACTIVE, so the drip restarts by itself the moment a video banks some
        // clips. See this class's own doc comment.
        return this.finishRun(claim, runId, {
          outcome: "SKIPPED",
          reason: EMPTY_QUEUE_REASON,
        });
      }

      return await this.releaseShort(claim, runId, next);
    } finally {
      await this.releaseClaim(claim.cadenceId);
    }
  }

  /**
   * The upload, and the only place this file touches YouTube.
   *
   * `publishService.publishShort` is the whole of it: it takes the one-shot
   * claim on `ShortPublication` before a byte is sent, resolves the channel's
   * language, category and audience declaration from its brand, and — the part
   * that matters here — hands back a spent quota as a `YouTubeQuotaError`
   * without burning the clip's single attempt, so a cadence that meets the
   * daily limit keeps its bank intact for tomorrow.
   */
  private async releaseShort(
    claim: ReleaseClaim,
    runId: string,
    short: { id: string; title: string },
  ): Promise<ReleaseTickResult> {
    try {
      const result = await this.publisher.publishShort(claim.userId, short.id, {
        visibility: claim.visibility,
      });

      return await this.finishRun(claim, runId, {
        outcome: "SUCCEEDED",
        reason: null,
        shortId: short.id,
        shortTitle: result.title,
        youtubeVideoId: result.youtubeVideoId,
        resetFailures: true,
      });
    } catch (error) {
      // A failed release must not kill the cadence. The failure is recorded,
      // the already-advanced `nextReleaseAt` stands, and the cadence stays
      // ACTIVE — one refused upload is not a reason to stop a channel. The
      // consecutive-failure counter is what eventually pauses one that is
      // broken rather than unlucky.
      const reason =
        error instanceof YouTubeQuotaError
          ? // Named explicitly, because this is the failure an operator would
            // otherwise misdiagnose. The allowance belongs to the Google Cloud
            // project this app is registered under, so it is *shared by every
            // channel* — the operator will be looking at one channel's history
            // wondering what is wrong with that channel, and the answer is that
            // nine uploads a day across three of them ran one bucket dry.
            `${messageOf(error)} This allowance is shared by every channel this ` +
            `studio publishes to, not counted per channel, so the other cadences ` +
            `will be failing the same way.`
          : messageOf(error);

      const failures = await this.countFailure(claim.cadenceId);

      const pauseWith =
        failures >= MAX_CONSECUTIVE_FAILURES
          ? `Paused after ${failures} releases in a row failed. The last said: ${reason}`
          : null;

      return this.finishRun(claim, runId, {
        outcome: "FAILED",
        reason,
        shortId: short.id,
        shortTitle: short.title,
        pauseWith,
      });
    }
  }

  /**
   * The head of the queue whose file is actually on disk.
   *
   * Publishing a video reclaims its render to keep a 40GB disk from filling
   * (see `reclaimRenderStorage` in publish.service.ts), and an operator tidying
   * `RENDER_ROOT` by hand can do the same to a clip. A short whose bytes are
   * gone is not releasable — and, left at the head, would stall the entire drip
   * on it forever, silently, one slot at a time.
   *
   * So a missing file marks that short FAILED, which is what it is and what
   * takes it out of `bankedShortsWhere` for good, and the scan moves on. The
   * slot is not spent on the discovery: the clip behind it goes out on time.
   * Bounded by `MAX_QUEUE_SCAN` so a cadence whose whole bank was deleted does
   * not turn one poll into an unbounded walk.
   *
   * `statShortFile` rather than opening the file: this is a guard, the upload a
   * moment later is what actually reads the bytes, and a `stat` is what the
   * rest of this codebase uses to ask the same question (see `statRenderFile`
   * in render-storage.ts and its call sites).
   */
  private async takeReleasable(
    claim: ReleaseClaim,
  ): Promise<{ id: string; title: string } | null> {
    const candidates = await prisma.short.findMany({
      where: this.bankedShortsWhere(claim.userId, claim.channelId),
      orderBy: this.queueOrder(),
      take: MAX_QUEUE_SCAN,
      select: {
        id: true,
        index: true,
        title: true,
        outputPath: true,
        video: { select: { title: true } },
      },
    });

    for (const candidate of candidates) {
      const present =
        candidate.outputPath !== null &&
        (await statShortFile(candidate.outputPath).catch(() => null)) !== null;

      if (present) {
        return {
          id: candidate.id,
          title: candidate.title ?? `${candidate.video.title} — Short ${candidate.index + 1}`,
        };
      }

      await prisma.short
        .updateMany({
          // Re-checked in the `where` so this cannot overwrite a short another
          // process has meanwhile moved out of READY.
          where: { id: candidate.id, status: "READY" },
          data: {
            status: "FAILED",
            error:
              "The rendered clip is no longer on disk, so it cannot be released. " +
              "Regenerate this video's shorts to cut it again.",
          },
        })
        .catch(() => {
          // Best-effort. Failing to record it means the next slot scans past it
          // again, which costs a `stat` — the release itself is unaffected.
        });
    }

    return null;
  }

  /**
   * Writes one history row per slot that passed while nothing was running.
   *
   * `skipDuplicates` rather than a pre-check, exactly as `ScheduleService` does
   * it: these rows are keyed by `[cadenceId, scheduledFor]`, and the only way
   * one already exists is a retry after a partial failure, where re-recording
   * is a no-op rather than an error worth surfacing.
   */
  private async recordMissedSlots(claim: ReleaseClaim): Promise<void> {
    if (claim.skipped.length === 0) {
      return;
    }

    const truncated = claim.skippedTotal > claim.skipped.length;

    await prisma.releaseRun.createMany({
      skipDuplicates: true,
      data: claim.skipped.map((scheduledFor, index) => ({
        cadenceId: claim.cadenceId,
        scheduledFor,
        outcome: "MISSED" as const,
        reason:
          index === 0 && truncated
            ? `Nothing was running when this slot came round. ${claim.skippedTotal} slots were missed in total; only the first ${claim.skipped.length} are listed.`
            : "Nothing was running when this slot came round, so it was passed over rather than released late.",
      })),
    });
  }

  /**
   * Claims this slot in history before anything is uploaded.
   *
   * Returns null when the row already exists, which means another tick owns
   * this slot — see `executeClaim` for why that check has to be an insert
   * rather than a read.
   */
  private async openRunRecord(claim: ReleaseClaim): Promise<string | null> {
    try {
      const row = await prisma.releaseRun.create({
        data: {
          cadenceId: claim.cadenceId,
          scheduledFor: claim.dueAt,
          outcome: "FAILED",
          reason: IN_FLIGHT_REASON,
        },
        select: { id: true },
      });

      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        console.error(
          `Release cadence ${claim.cadenceId} was claimed twice for ${claim.dueAt.toISOString()}; ` +
            "the second release withdrew before uploading anything.",
        );
        return null;
      }

      throw error;
    }
  }

  /**
   * Everything that makes this release impossible, checked before the upload.
   *
   * Short, because a drip has far less that can go wrong than a schedule does:
   * there is no provider readiness to check (nothing here calls a model) and no
   * project to be archived. What is left is the channel — the OAuth grant this
   * upload needs — and a channel that has gone is not something a cadence
   * recovers from on its own, so it pauses rather than skipping forever.
   */
  private async findBlockingReason(
    claim: ReleaseClaim,
  ): Promise<{ reason: string; pause: boolean } | null> {
    const channel = await prisma.channel.findFirst({
      where: { id: claim.channelId, userId: claim.userId },
      select: { deletedAt: true, isActive: true, title: true },
    });

    if (!channel || channel.deletedAt !== null) {
      return {
        reason:
          "The channel this cadence releases to has been disconnected, so there " +
          "is nowhere to publish. Reconnect it and resume the cadence to start it again.",
        pause: true,
      };
    }

    if (!channel.isActive) {
      return {
        reason: `The channel "${channel.title}" is not active, so nothing was released into this slot.`,
        pause: false,
      };
    }

    return null;
  }

  /** Bumps and reads back the consecutive-failure count in one statement, so
   *  two failures landing together cannot both read the same old value. */
  private async countFailure(cadenceId: string): Promise<number> {
    const row = await prisma.releaseCadence.update({
      where: { id: cadenceId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true },
    });

    return row.consecutiveFailures;
  }

  /** Writes the outcome onto the row `openRunRecord` reserved, and applies
   *  whatever that outcome means for the cadence itself. */
  private async finishRun(
    claim: ReleaseClaim,
    runId: string,
    outcome: {
      outcome: ScheduleRunOutcome;
      reason: string | null;
      shortId?: string;
      shortTitle?: string;
      youtubeVideoId?: string;
      pauseWith?: string | null;
      resetFailures?: boolean;
    },
  ): Promise<ReleaseTickResult> {
    await prisma.releaseRun.update({
      where: { id: runId },
      data: {
        outcome: outcome.outcome,
        reason: outcome.reason,
        shortId: outcome.shortId ?? null,
        shortTitle: outcome.shortTitle ?? null,
        youtubeVideoId: outcome.youtubeVideoId ?? null,
      },
    });

    if (outcome.pauseWith) {
      await prisma.releaseCadence.updateMany({
        where: { id: claim.cadenceId },
        data: { status: "PAUSED", pausedReason: outcome.pauseWith },
      });
    } else if (outcome.resetFailures) {
      await prisma.releaseCadence.updateMany({
        where: { id: claim.cadenceId },
        data: { consecutiveFailures: 0 },
      });
    }

    return {
      cadenceId: claim.cadenceId,
      channelTitle: claim.channelTitle,
      scheduledFor: claim.dueAt,
      outcome: outcome.outcome,
      reason: outcome.reason,
      shortId: outcome.shortId ?? null,
      youtubeVideoId: outcome.youtubeVideoId ?? null,
    };
  }

  /** Drops the lease. Best-effort and never allowed to throw out of
   *  `executeClaim`'s `finally`: a failure here would replace a real, already
   *  recorded outcome with a database error the operator cannot act on, and the
   *  lease expires by itself five minutes later anyway. */
  private async releaseClaim(cadenceId: string): Promise<void> {
    try {
      await prisma.releaseCadence.updateMany({
        where: { id: cadenceId },
        data: { claimExpiresAt: null },
      });
    } catch (error) {
      console.error(`Could not release the claim on release cadence ${cadenceId}:`, error);
    }
  }

  private async pauseCorruptCadence(cadenceId: string, reason: string): Promise<void> {
    try {
      await prisma.releaseCadence.updateMany({
        where: { id: cadenceId },
        data: {
          status: "PAUSED",
          pausedReason: `This cadence's release times could not be worked out, so it was paused: ${reason}`,
          nextReleaseAt: null,
        },
      });
    } catch (error) {
      console.error(`Could not pause the unschedulable release cadence ${cadenceId}:`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Shared guards
  // -------------------------------------------------------------------------

  /** Every read and write in this service goes through here or an equivalent
   *  `userId` predicate. A cadence publishes to the owner's YouTube channel;
   *  addressing one by id must never be enough. */
  private async requireOwned(userId: string, id: string) {
    const cadence = await prisma.releaseCadence.findFirst({
      where: { id, userId },
      select: {
        id: true,
        status: true,
        channelId: true,
        slotMinutes: true,
        timeZone: true,
      },
    });

    if (!cadence) {
      throw new NotFoundError("Release cadence");
    }

    return cadence;
  }

  private async assertUsableChannel(userId: string, channelId: string): Promise<void> {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }
  }
}

export const releaseService = new ReleaseService();
