import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  ScheduleFrequency,
  ScheduleRunOutcome,
  ScheduleStatus,
} from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  advancePast,
  describeRecurrence,
  firstOccurrenceAfter,
  type Recurrence,
} from "@/lib/schedule-time";
import type {
  AddScheduleTopicsInput,
  CreateScheduleInput,
  UpdateScheduleInput,
} from "@/schemas/schedule.schema";
import {
  automationService,
  type AutomationService,
} from "@/services/automation.service";

/**
 * Recurring automation: the guided one-click flow, on a timer.
 *
 * ## What this is, and what it deliberately is not
 *
 * The request behind this file was "make an automation flow like Make.com or
 * n8n". Those are visual graph builders, and the temptation is to build a
 * canvas. This product has exactly one flow — a topic goes in, a video comes
 * out — so a graph editor here would offer the operator a drag-and-drop
 * interface for arranging a single possible shape. What is actually useful
 * about that idea is the part underneath the canvas: something fires on a
 * schedule, and there is a record of every time it did. That is this file.
 *
 * It owns no generation logic. `automationService.start` is the entire run —
 * the same call the Generate button makes, with the same readiness checks, the
 * same duplicate guard, the same automatic script approval, and, crucially, the
 * same hard stop before publishing. A scheduled run produces a finished video
 * waiting for review; nothing here creates a `Publication`, and nothing here
 * ever will, because the second gate is what makes it safe to let a schedule
 * spend money unattended in the first place.
 *
 * ## The four things that actually break
 *
 * Everything difficult about this feature is in `claimDue` and `executeClaim`,
 * and it is all about spending money you did not mean to:
 *
 *   1. **Firing twice.** Two workers poll the same table. Solved with the same
 *      conditional-update-as-lock `JobService.claimNext` uses, with the
 *      advance of `nextRunAt` folded into the winning write — see `claimDue`.
 *   2. **Firing in a burst after downtime.** Solved by treating an occurrence
 *      as a moment rather than a debt — see `advancePast` in
 *      src/lib/schedule-time.ts.
 *   3. **Firing at the wrong time twice a year.** Solved by storing wall-clock
 *      fields plus a zone and deriving the instant, never by adding a week of
 *      milliseconds — see src/lib/schedule-time.ts.
 *   4. **Spending on a run that cannot finish.** Solved by refusing before the
 *      first billed call, using the same onboarding checks the guided flow
 *      uses — see `executeClaim`.
 */

/**
 * How long a worker holds a claimed schedule.
 *
 * Sized to the work: a scheduled run is one Anthropic call and a few writes —
 * seconds, not the ten minutes a render takes — but it happens over a network
 * to a provider that can hang. Two minutes comfortably outlasts an honest run
 * and still lets the next poll retake a schedule whose worker died, rather than
 * leaving it stuck for a full render's lease over work that takes twenty
 * seconds. Same reasoning as `SHORT_LEASE_SECONDS` in shorts.service.ts.
 *
 * Note that the lease is *not* what prevents a double fire — `nextRunAt` is
 * already advanced past this occurrence by the time the lease is taken. Its job
 * is narrower: stop a second worker from starting the *next* occurrence of a
 * schedule whose current run is still in flight, which for a daily-ish cadence
 * is impossible anyway and for a stuck run would otherwise pile up.
 */
const CLAIM_LEASE_SECONDS = 120;

/**
 * How many consecutive failures pause a schedule.
 *
 * Deliberately the same number as `MAX_ATTEMPTS` in job.service.ts, and for the
 * same reason: past three, the failure is not weather, it is a fault — an
 * expired Anthropic key, a prompt template that no longer renders, a project
 * that has gone. Every further attempt is a billed provider call that will fail
 * the same way, once a week, until somebody notices. Pausing costs the operator
 * one delayed video and a visible reason; not pausing costs them money
 * indefinitely for nothing.
 *
 * Only *consecutive* failures count. A single bad week does not disarm a
 * schedule that has run fine for months, because any success resets the counter
 * to zero.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Candidates read per due-check. Same shape and same small number as
 *  `JobService.claimNext`: the list exists only so a lost race can fall through
 *  to another row instead of waiting for the next poll. */
const CANDIDATE_BATCH = 5;

/**
 * Placeholder outcome for a run that has begun but not reported.
 *
 * See `executeClaim` for why the history row is written *before* the model is
 * called rather than after. A worker killed mid-run leaves this behind, and it
 * reads correctly: the run started and never came back.
 */
const IN_FLIGHT_REASON =
  "The run started but the worker never reported an outcome — it was most " +
  "likely restarted or killed mid-run.";

export interface ScheduleTopicRecord {
  id: string;
  position: number;
  topic: string;
  consumedAt: Date | null;
}

export interface ScheduleRunRecord {
  id: string;
  scheduledFor: Date;
  outcome: ScheduleRunOutcome;
  reason: string | null;
  topic: string | null;
  videoId: string | null;
  createdAt: Date;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  status: ScheduleStatus;
  pausedReason: string | null;
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timeZone: string;
  /** One line of prose describing the cadence, built once here so the list, the
   *  detail page and the history all phrase it identically. */
  cadence: string;
  projectId: string;
  projectName: string;
  /** Null while paused-and-never-resumed. Meaningless while paused anyway —
   *  the UI says "paused" rather than showing a time that will not happen. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  /** Topics still waiting. Zero is the number that matters: a schedule with an
   *  empty queue pauses itself on its next occurrence. */
  queuedTopicCount: number;
  /** The topic the next run will take, so the operator can see what is coming
   *  without opening the schedule. */
  nextTopic: string | null;
}

export interface ScheduleDetail extends ScheduleSummary {
  variables: Record<string, string>;
  topics: ScheduleTopicRecord[];
  runs: ScheduleRunRecord[];
  /** True while a worker holds this schedule. Surfaced so "Pause" can explain
   *  that a run already under way will still finish. */
  runInFlight: boolean;
}

/** What one due-check produced, for the worker's log. Null from `tick` means
 *  nothing was due. */
export interface ScheduleTickResult {
  scheduleId: string;
  scheduleName: string;
  scheduledFor: Date;
  outcome: ScheduleRunOutcome;
  reason: string | null;
  videoId: string | null;
}

/** A schedule won by `claimDue`, carrying everything `executeClaim` needs so it
 *  never re-reads a row that another process may have moved underneath it. */
interface ScheduleClaim {
  scheduleId: string;
  userId: string;
  projectId: string;
  name: string;
  /** The occurrence being run — the `nextRunAt` value that was just replaced. */
  dueAt: Date;
  variables: Record<string, string>;
  /** Occurrences stepped over on the way here, oldest first. */
  skipped: Date[];
  skippedTotal: number;
}

/** The recurrence columns, in the shape src/lib/schedule-time.ts works in. */
function recurrenceOf(row: {
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timeZone: string;
}): Recurrence {
  return {
    frequency: row.frequency,
    dayOfWeek: row.dayOfWeek,
    dayOfMonth: row.dayOfMonth,
    hour: row.hour,
    minute: row.minute,
    timeZone: row.timeZone,
  };
}

/**
 * Narrows a `Json` column back to the string map it was written from.
 *
 * Defensive rather than paranoid: the column is written only through
 * `createScheduleSchema`, but it is a `Json` column on a database an operator
 * can reach with a SQL client, and a non-string value reaching
 * `renderTemplate` would be a type error thrown deep inside a worker at 09:00
 * on a Monday. Anything unexpected is dropped, which degrades the run to using
 * the template's own defaults rather than failing it.
 */
function readVariables(value: Prisma.JsonValue): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
}

/** Whether two recurrences describe the same moments. Used by `update` to
 *  decide whether `nextRunAt` has to be recomputed — see there for why editing
 *  a schedule's name must not move its next run. */
function sameRecurrence(a: Recurrence, b: Recurrence): boolean {
  return (
    a.frequency === b.frequency &&
    a.dayOfWeek === b.dayOfWeek &&
    a.dayOfMonth === b.dayOfMonth &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.timeZone === b.timeZone
  );
}

/** Prisma's unique-constraint violation, recognised without importing the
 *  runtime error class (which pulls the whole client into this module's type
 *  surface for one `instanceof`). */
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

export class ScheduleService {
  /**
   * `Pick`, not the whole `AutomationService`, for the same reason that class
   * takes a `Pick<ScriptService>`: this service calls exactly two of its
   * methods, and typing the parameter as the full class would force every test
   * to stub `getRun` as well. Injected at all so a test can drive a whole tick
   * — claim, readiness, topic, history — against a fake run instead of billing
   * a real Anthropic call on every assertion.
   */
  constructor(
    private readonly automation: Pick<
      AutomationService,
      "start" | "getSetup"
    > = automationService,
  ) {}

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  async list(userId: string): Promise<ScheduleSummary[]> {
    const rows = await prisma.schedule.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ status: "asc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
      include: {
        project: { select: { name: true } },
        // The whole queue is never loaded for a list: only the head, which is
        // the one topic worth showing, plus a count.
        topics: {
          where: { consumedAt: null },
          orderBy: { position: "asc" },
          take: 1,
          select: { topic: true },
        },
        _count: { select: { topics: { where: { consumedAt: null } } } },
      },
    });

    return rows.map((row) => this.toSummary(row));
  }

  async get(userId: string, id: string): Promise<ScheduleDetail> {
    const row = await prisma.schedule.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        project: { select: { name: true } },
        topics: {
          where: { consumedAt: null },
          orderBy: { position: "asc" },
          take: 1,
          select: { topic: true },
        },
        _count: { select: { topics: { where: { consumedAt: null } } } },
      },
    });

    if (!row) {
      throw new NotFoundError("Schedule");
    }

    const [topics, runs] = await Promise.all([
      prisma.scheduleTopic.findMany({
        where: { scheduleId: id },
        orderBy: [{ consumedAt: { sort: "asc", nulls: "first" } }, { position: "asc" }],
        select: { id: true, position: true, topic: true, consumedAt: true },
      }),
      prisma.scheduleRun.findMany({
        where: { scheduleId: id },
        orderBy: { scheduledFor: "desc" },
        take: 50,
        select: {
          id: true,
          scheduledFor: true,
          outcome: true,
          reason: true,
          topic: true,
          videoId: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ...this.toSummary(row),
      variables: readVariables(row.variables),
      topics,
      runs,
      runInFlight: row.claimExpiresAt !== null && row.claimExpiresAt > new Date(),
    };
  }

  private toSummary(row: {
    id: string;
    name: string;
    status: ScheduleStatus;
    pausedReason: string | null;
    frequency: ScheduleFrequency;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    hour: number;
    minute: number;
    timeZone: string;
    projectId: string;
    project: { name: string };
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    consecutiveFailures: number;
    topics: { topic: string }[];
    _count: { topics: number };
  }): ScheduleSummary {
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      pausedReason: row.pausedReason,
      frequency: row.frequency,
      dayOfWeek: row.dayOfWeek,
      dayOfMonth: row.dayOfMonth,
      hour: row.hour,
      minute: row.minute,
      timeZone: row.timeZone,
      cadence: describeRecurrence(recurrenceOf(row)),
      projectId: row.projectId,
      projectName: row.project.name,
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      consecutiveFailures: row.consecutiveFailures,
      queuedTopicCount: row._count.topics,
      nextTopic: row.topics[0]?.topic ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Operator actions
  // -------------------------------------------------------------------------

  async create(userId: string, input: CreateScheduleInput): Promise<{ id: string }> {
    await this.assertUsableProject(userId, input.projectId);
    await this.assertVariablesAnswerThePrompt(userId, input.variables);

    const recurrence = recurrenceOf(input);

    // The first run is the next time this pattern comes round, never "now". An
    // operator setting up a Monday schedule on a Monday afternoon must not be
    // billed for a video the instant they press Save — they were describing a
    // cadence, not asking for something immediately.
    const nextRunAt = firstOccurrenceAfter(recurrence, new Date());

    const schedule = await prisma.schedule.create({
      data: {
        userId,
        projectId: input.projectId,
        name: input.name,
        frequency: input.frequency,
        dayOfWeek: input.frequency === "WEEKLY" ? input.dayOfWeek : null,
        dayOfMonth: input.frequency === "MONTHLY" ? input.dayOfMonth : null,
        hour: input.hour,
        minute: input.minute,
        timeZone: input.timeZone,
        variables: input.variables,
        nextRunAt,
        topics: {
          create: input.topics.map((topic, index) => ({ position: index, topic })),
        },
      },
      select: { id: true },
    });

    return schedule;
  }

  async update(userId: string, id: string, input: UpdateScheduleInput): Promise<void> {
    const existing = await this.requireOwned(userId, id);
    await this.assertUsableProject(userId, input.projectId);
    await this.assertVariablesAnswerThePrompt(userId, input.variables);

    const recurrence = recurrenceOf(input);

    // `nextRunAt` is recomputed only when the *timing* changed. Recomputing
    // unconditionally would mean renaming a schedule at 08:59 on a Monday
    // pushes that morning's run to next week — a destructive side effect of an
    // edit that had nothing to do with time.
    const timingChanged = !sameRecurrence(recurrenceOf(existing), recurrence);

    await prisma.schedule.update({
      where: { id },
      data: {
        projectId: input.projectId,
        name: input.name,
        frequency: input.frequency,
        dayOfWeek: input.frequency === "WEEKLY" ? input.dayOfWeek : null,
        dayOfMonth: input.frequency === "MONTHLY" ? input.dayOfMonth : null,
        hour: input.hour,
        minute: input.minute,
        timeZone: input.timeZone,
        variables: input.variables,
        ...(timingChanged && existing.status === "ACTIVE"
          ? { nextRunAt: firstOccurrenceAfter(recurrence, new Date()) }
          : {}),
      },
    });
  }

  /**
   * Stops the schedule, immediately.
   *
   * "Immediately" is exact: `claimDue` reads `status: "ACTIVE"`, so the very
   * next due-check ignores this row. What pausing cannot do is recall a run
   * already in flight — that run has a lease, has probably already been billed
   * for a script, and killing it halfway would leave a video with a paid-for
   * script and no narration. The detail page reports `runInFlight` so the
   * operator is told this rather than left wondering why a video appeared after
   * they pressed Pause.
   */
  async pause(userId: string, id: string, reason?: string): Promise<void> {
    await this.requireOwned(userId, id);

    await prisma.schedule.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "PAUSED", pausedReason: reason ?? null },
    });
  }

  /**
   * Restarts a paused schedule from the next future occurrence.
   *
   * Never from the stored `nextRunAt`: that is an occurrence in the past, and
   * resuming a schedule paused three weeks ago would fire a video the moment
   * the worker next polled. Resuming means "carry on from here", not "catch up
   * on what I paused".
   */
  async resume(userId: string, id: string): Promise<void> {
    const existing = await this.requireOwned(userId, id);

    // Resuming into an empty queue would pause the schedule again on its first
    // occurrence, which is a confusing round trip. Refused up front instead,
    // naming the thing that has to change.
    const queued = await prisma.scheduleTopic.count({
      where: { scheduleId: id, consumedAt: null },
    });

    if (queued === 0) {
      throw new ConflictError(
        "This schedule has no topics left to run. Add at least one before resuming it.",
      );
    }

    await prisma.schedule.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        status: "ACTIVE",
        pausedReason: null,
        // A schedule that paused itself after repeated failures gets a clean
        // slate: the operator resuming it is asserting they fixed the cause,
        // and leaving the counter at three would pause it again on the next
        // single failure.
        consecutiveFailures: 0,
        nextRunAt: firstOccurrenceAfter(recurrenceOf(existing), new Date()),
      },
    });
  }

  /** Soft delete, matching every other user-owned entity. The run history goes
   *  with it only when the row is eventually hard-deleted; until then the
   *  schedule simply stops being due and stops being listed. */
  async remove(userId: string, id: string): Promise<void> {
    await this.requireOwned(userId, id);

    await prisma.schedule.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date(), status: "PAUSED", nextRunAt: null },
    });
  }

  /**
   * Appends to the queue.
   *
   * Positions continue from the highest already stored rather than from the
   * count of unconsumed rows, so appending never lands a new topic ahead of one
   * the operator wrote earlier and has been waiting on.
   */
  async addTopics(
    userId: string,
    id: string,
    input: AddScheduleTopicsInput,
  ): Promise<{ added: number }> {
    await this.requireOwned(userId, id);

    const last = await prisma.scheduleTopic.findFirst({
      where: { scheduleId: id },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const base = (last?.position ?? -1) + 1;

    await prisma.scheduleTopic.createMany({
      data: input.topics.map((topic, index) => ({
        scheduleId: id,
        position: base + index,
        topic,
      })),
    });

    return { added: input.topics.length };
  }

  /** Removes a topic that has not been used yet. A consumed one is history —
   *  it names a video that exists — so deleting it is refused rather than
   *  silently rewriting what happened. */
  async removeTopic(userId: string, id: string, topicId: string): Promise<void> {
    await this.requireOwned(userId, id);

    const { count } = await prisma.scheduleTopic.deleteMany({
      where: { id: topicId, scheduleId: id, consumedAt: null },
    });

    if (count === 0) {
      throw new ConflictError(
        "That topic is not in the queue any more — it has either been removed or already used.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // The worker path
  // -------------------------------------------------------------------------

  /**
   * One due-check. Claims at most one schedule and runs it; returns null when
   * nothing was due.
   *
   * At most one on purpose. The worker's poll loop is shared with videos and
   * shorts, and a tick that drained every due schedule in a burst would hold
   * the loop for the length of several Anthropic calls while a queued video sat
   * waiting. The next poll picks up the next due schedule, which for a weekly
   * cadence is a wait of seconds against an interval of days.
   */
  async tick(): Promise<ScheduleTickResult | null> {
    const claim = await this.claimDue();

    if (!claim) {
      return null;
    }

    return this.executeClaim(claim);
  }

  /**
   * Wins exactly one due schedule, advancing it past this occurrence in the
   * same write.
   *
   * ## Why this cannot fire twice
   *
   * Same shape as `JobService.claimNext`, for the same reason: Prisma's
   * `updateMany` has no `LIMIT`, so an unconditional "claim the oldest due
   * schedule" would let two callers both match and both believe they won.
   * Instead: read a short list of candidates, then try to win each with an
   * update whose `where` repeats the exact state just read — here, the exact
   * `nextRunAt` value. The conditional update *is* the lock, and the read above
   * it is only a hint.
   *
   * The part specific to schedules is what the winning write does: it sets
   * `nextRunAt` to the next future occurrence in the same statement that wins
   * the row. That is what makes a second claim of the same occurrence
   * impossible rather than merely unlikely — after the first write, no caller's
   * `where: { nextRunAt: dueAt }` can ever match this row again, because that
   * value is gone. There is no window between "won" and "advanced" for a second
   * tick to slip through, which there would be if the advance were a second
   * statement, or worse, computed after the run finished.
   *
   * ## Why this cannot fire in a burst
   *
   * The new `nextRunAt` comes from `advancePast`, which walks the recurrence
   * forward until it is genuinely in the future rather than adding one interval
   * to the occurrence that just fired. A worker that has been down for three
   * weeks therefore produces one video and records two missed occurrences — not
   * three videos in three minutes. See src/lib/schedule-time.ts.
   */
  async claimDue(): Promise<ScheduleClaim | null> {
    const now = new Date();

    const candidates = await prisma.schedule.findMany({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        nextRunAt: { lte: now },
        // A schedule whose previous run is still in flight, or whose worker
        // died holding it. The lapsed case is why this is a lease and not a
        // lock: nothing else would ever clear a dead worker's claim.
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
      },
      orderBy: { nextRunAt: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        projectId: true,
        name: true,
        frequency: true,
        dayOfWeek: true,
        dayOfMonth: true,
        hour: true,
        minute: true,
        timeZone: true,
        variables: true,
        nextRunAt: true,
      },
    });

    for (const candidate of candidates) {
      const dueAt = candidate.nextRunAt;

      // Cannot happen — `nextRunAt: { lte: now }` excludes nulls — but the
      // column is nullable and the compiler is right to insist.
      if (!dueAt) {
        continue;
      }

      let advanced;

      try {
        advanced = advancePast(recurrenceOf(candidate), dueAt, now);
      } catch (error) {
        // A recurrence that cannot be advanced is a corrupt row (a WEEKLY
        // schedule with no `dayOfWeek`, a zone that has stopped resolving).
        // Pausing it is the only safe response: leaving it ACTIVE means every
        // future poll re-reads it, re-throws, and logs the same error forever.
        await this.pauseCorruptSchedule(candidate.id, messageOf(error));
        continue;
      }

      const { count } = await prisma.schedule.updateMany({
        where: {
          id: candidate.id,
          deletedAt: null,
          status: "ACTIVE",
          // The lock. Only one caller can still match this exact value.
          nextRunAt: dueAt,
          OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }],
        },
        data: {
          nextRunAt: advanced.nextRunAt,
          claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
          // Moved even for a run that goes on to skip: this records that the
          // due-check looked, which is the question the operator is asking when
          // no video appeared.
          lastRunAt: now,
        },
      });

      if (count === 1) {
        return {
          scheduleId: candidate.id,
          userId: candidate.userId,
          projectId: candidate.projectId,
          name: candidate.name,
          dueAt,
          variables: readVariables(candidate.variables),
          skipped: advanced.skipped,
          skippedTotal: advanced.skippedTotal,
        };
      }
    }

    return null;
  }

  /**
   * Runs one claimed occurrence, and writes down what happened either way.
   *
   * The order of operations here is the whole safety argument, so it is worth
   * stating plainly. Nothing that costs money happens until every cheap reason
   * to refuse has been checked:
   *
   *   1. Missed occurrences are recorded (free, and explains a gap in history).
   *   2. The history row for *this* occurrence is inserted, before anything
   *      else. Its unique constraint on `[scheduleId, scheduledFor]` is the
   *      backstop behind `claimDue`'s lock — if two ticks somehow both believed
   *      this occurrence was theirs, the second one fails here, before a
   *      provider is called. It carries a placeholder outcome that a
   *      worker killed mid-run leaves behind truthfully.
   *   3. Readiness — the same `onboardingService` checks the Generate button
   *      uses, reached through `automationService.getSetup`. A missing
   *      ElevenLabs key means the run would be billed for a script and then die
   *      at narration.
   *   4. The project still has to be usable.
   *   5. A topic has to be available.
   *   6. Only then, `automationService.start`.
   *
   * The claim's lease is released in `finally` regardless of which of those
   * refused, because a schedule left holding a lease is a schedule that skips
   * its next occurrence too.
   */
  async executeClaim(claim: ScheduleClaim): Promise<ScheduleTickResult | null> {
    try {
      await this.recordMissedOccurrences(claim);

      const runId = await this.openRunRecord(claim);

      if (!runId) {
        // Another tick already owns this occurrence. Nothing was spent.
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

      const topic = await this.takeNextTopic(claim.scheduleId);

      if (!topic) {
        const reason =
          "The topic queue is empty. Nothing here invents a subject, so the " +
          "schedule paused itself rather than guessing what to make a video about.";

        return this.finishRun(claim, runId, {
          outcome: "SKIPPED",
          reason,
          pauseWith: reason,
        });
      }

      return await this.runTopic(claim, runId, topic);
    } finally {
      await this.releaseClaim(claim.scheduleId);
    }
  }

  /**
   * The billed part, and the only place this file touches the pipeline.
   *
   * `automationService.start` is the identical call the Generate button makes:
   * it creates the video, writes the script, approves it, and leaves it queued
   * for the render worker. It stops there. Nothing in this file, and nothing in
   * that method, creates a `Publication` or moves a video toward `PUBLISHED` —
   * a scheduled run ends at a finished video waiting for the operator's own
   * publish click, which is the property that makes unattended spending
   * acceptable at all.
   */
  private async runTopic(
    claim: ScheduleClaim,
    runId: string,
    topic: { id: string; topic: string },
  ): Promise<ScheduleTickResult> {
    try {
      const result = await this.automation.start(claim.userId, {
        projectId: claim.projectId,
        topic: topic.topic,
        variables: claim.variables,
      });

      return await this.finishRun(claim, runId, {
        outcome: "SUCCEEDED",
        reason: null,
        topic: topic.topic,
        videoId: result.videoId,
        resetFailures: true,
      });
    } catch (error) {
      // A failed run must not kill the schedule. The failure is recorded, the
      // already-advanced `nextRunAt` stands, and the schedule remains ACTIVE —
      // one bad Monday is not a reason to stop producing videos. The
      // consecutive-failure counter is what eventually stops a schedule that is
      // broken rather than unlucky; see `MAX_CONSECUTIVE_FAILURES`.
      const reason = messageOf(error);
      const failures = await this.countFailure(claim.scheduleId);

      const pauseWith =
        failures >= MAX_CONSECUTIVE_FAILURES
          ? `Paused after ${failures} runs in a row failed. The last said: ${reason}`
          : null;

      return this.finishRun(claim, runId, {
        outcome: "FAILED",
        reason,
        topic: topic.topic,
        pauseWith,
      });
    }
  }

  /**
   * Writes one history row per occurrence that passed while nothing was
   * running.
   *
   * `skipDuplicates` rather than a pre-check: these rows are keyed by
   * `[scheduleId, scheduledFor]`, and the only way one already exists is a
   * retry after a partial failure, in which case re-recording it is a no-op
   * rather than an error worth surfacing.
   */
  private async recordMissedOccurrences(claim: ScheduleClaim): Promise<void> {
    if (claim.skipped.length === 0) {
      return;
    }

    const truncated = claim.skippedTotal > claim.skipped.length;

    await prisma.scheduleRun.createMany({
      skipDuplicates: true,
      data: claim.skipped.map((scheduledFor, index) => ({
        scheduleId: claim.scheduleId,
        scheduledFor,
        outcome: "MISSED" as const,
        reason:
          index === 0 && truncated
            ? `Nothing was running when this occurrence came due. ${claim.skippedTotal} occurrences were missed in total; only the first ${claim.skipped.length} are listed.`
            : "Nothing was running when this occurrence came due, so it was passed over rather than produced late.",
      })),
    });
  }

  /**
   * Claims this occurrence in history before anything is spent.
   *
   * Returns null when the row already exists, which means another tick owns
   * this occurrence — see `executeClaim`'s own comment for why that check has
   * to be an insert rather than a read.
   */
  private async openRunRecord(claim: ScheduleClaim): Promise<string | null> {
    try {
      const row = await prisma.scheduleRun.create({
        data: {
          scheduleId: claim.scheduleId,
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
          `Schedule ${claim.scheduleId} was claimed twice for ${claim.dueAt.toISOString()}; ` +
            "the second run withdrew before spending anything.",
        );
        return null;
      }

      throw error;
    }
  }

  /**
   * Everything that makes this run pointless or impossible, checked before the
   * first billed call.
   *
   * The readiness half is `automationService.getSetup`, which is
   * `onboardingService.getChecklist` filtered to the four preconditions the
   * guided flow refuses without. Reused rather than restated so a schedule and
   * the Generate button can never disagree about what "ready" means.
   *
   * `pause: true` marks a reason the schedule cannot recover from on its own. A
   * missing ElevenLabs key resolves itself the moment the operator adds one, so
   * that schedule stays active and simply skips; a deleted project never comes
   * back, so that one stops.
   */
  private async findBlockingReason(
    claim: ScheduleClaim,
  ): Promise<{ reason: string; pause: boolean } | null> {
    const setup = await this.automation.getSetup(claim.userId);

    if (setup.blockers.length > 0) {
      return {
        reason:
          "Skipped without spending anything — this account is not ready to " +
          `generate a video: ${setup.blockers
            .map((blocker) => blocker.title.toLowerCase())
            .join(", ")}.`,
        pause: false,
      };
    }

    const project = await prisma.project.findFirst({
      where: { id: claim.projectId, userId: claim.userId },
      select: { deletedAt: true, status: true, name: true },
    });

    if (!project || project.deletedAt !== null) {
      return {
        reason:
          "The project this schedule produces into has been deleted, so there " +
          "is nowhere to put a video. Point the schedule at another project to " +
          "start it again.",
        pause: true,
      };
    }

    if (project.status === "ARCHIVED") {
      return {
        reason: `The project "${project.name}" is archived, and an archived project takes no new videos.`,
        pause: false,
      };
    }

    return null;
  }

  /**
   * Takes the next topic off the queue, atomically.
   *
   * The conditional update is the same pattern as everywhere else here: reading
   * the head and then marking it would let a concurrent removal (or, in
   * principle, a second tick) hand the same topic out twice.
   *
   * The topic is consumed *before* the model is called, and stays consumed if
   * the run then fails. That is the deliberate direction to err in.
   * `automationService.start` can fail after the script has been generated and
   * billed — the video survives in DRAFT with a paid-for script — so putting
   * the topic back would have next week's run generate a second script for a
   * subject that already has one, at full price. The topic is copied onto the
   * history row instead, so a failed run names exactly what it was about and
   * the operator can re-queue it in one click if they want to.
   */
  private async takeNextTopic(
    scheduleId: string,
  ): Promise<{ id: string; topic: string } | null> {
    const head = await prisma.scheduleTopic.findFirst({
      where: { scheduleId, consumedAt: null },
      orderBy: { position: "asc" },
      select: { id: true, topic: true },
    });

    if (!head) {
      return null;
    }

    const { count } = await prisma.scheduleTopic.updateMany({
      where: { id: head.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    return count === 1 ? head : null;
  }

  /** Bumps and reads back the consecutive-failure count in one statement, so
   *  two failures landing together cannot both read the same old value. */
  private async countFailure(scheduleId: string): Promise<number> {
    const row = await prisma.schedule.update({
      where: { id: scheduleId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true },
    });

    return row.consecutiveFailures;
  }

  /** Writes the outcome onto the row `openRunRecord` reserved, and applies
   *  whatever that outcome means for the schedule itself. */
  private async finishRun(
    claim: ScheduleClaim,
    runId: string,
    outcome: {
      outcome: ScheduleRunOutcome;
      reason: string | null;
      topic?: string;
      videoId?: string;
      pauseWith?: string | null;
      resetFailures?: boolean;
    },
  ): Promise<ScheduleTickResult> {
    await prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        outcome: outcome.outcome,
        reason: outcome.reason,
        topic: outcome.topic ?? null,
        videoId: outcome.videoId ?? null,
      },
    });

    if (outcome.pauseWith) {
      await prisma.schedule.updateMany({
        where: { id: claim.scheduleId },
        data: { status: "PAUSED", pausedReason: outcome.pauseWith },
      });
    } else if (outcome.resetFailures) {
      await prisma.schedule.updateMany({
        where: { id: claim.scheduleId },
        data: { consecutiveFailures: 0 },
      });
    }

    return {
      scheduleId: claim.scheduleId,
      scheduleName: claim.name,
      scheduledFor: claim.dueAt,
      outcome: outcome.outcome,
      reason: outcome.reason,
      videoId: outcome.videoId ?? null,
    };
  }

  /** Drops the lease. Best-effort and never allowed to throw out of
   *  `executeClaim`'s `finally`: a failure here would replace a real, already
   *  recorded outcome with a database error the operator cannot act on, and the
   *  lease expires by itself two minutes later anyway. */
  private async releaseClaim(scheduleId: string): Promise<void> {
    try {
      await prisma.schedule.updateMany({
        where: { id: scheduleId },
        data: { claimExpiresAt: null },
      });
    } catch (error) {
      console.error(`Could not release the claim on schedule ${scheduleId}:`, error);
    }
  }

  private async pauseCorruptSchedule(scheduleId: string, reason: string): Promise<void> {
    try {
      await prisma.schedule.updateMany({
        where: { id: scheduleId },
        data: {
          status: "PAUSED",
          pausedReason: `This schedule's timing could not be worked out, so it was paused: ${reason}`,
          nextRunAt: null,
        },
      });
    } catch (error) {
      console.error(`Could not pause the unschedulable schedule ${scheduleId}:`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Shared guards
  // -------------------------------------------------------------------------

  /** Every read and write in this service goes through here or an equivalent
   *  `userId` predicate. A schedule spends the owner's money; addressing one by
   *  id must never be enough. */
  private async requireOwned(userId: string, id: string) {
    const schedule = await prisma.schedule.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        frequency: true,
        dayOfWeek: true,
        dayOfMonth: true,
        hour: true,
        minute: true,
        timeZone: true,
      },
    });

    if (!schedule) {
      throw new NotFoundError("Schedule");
    }

    return schedule;
  }

  private async assertUsableProject(userId: string, projectId: string): Promise<void> {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null, status: "ACTIVE" },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }
  }

  /**
   * Refuses a schedule whose answers would fail at 09:00 on a Monday.
   *
   * The same reconciliation `automationService.start` performs, run at save
   * time instead of at run time. Without it, a required variable left blank is
   * discovered by a worker a week later, recorded as a failure, and repeated
   * twice more before the schedule pauses itself — three billed-nothing runs
   * and a fortnight lost to a mistake the form could have caught immediately.
   *
   * Deliberately only checks what is checkable now. The operator can edit their
   * prompt template afterwards and introduce a required variable this schedule
   * has no answer for; that failure is unavoidable here and is what the
   * failure counter and the run history exist for.
   */
  private async assertVariablesAnswerThePrompt(
    userId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const setup = await this.automation.getSetup(userId);

    if (!setup.prompt) {
      // Reported as a blocker by `getSetup` itself, and the create form is
      // gated on the same call, so this is the hand-crafted-payload path.
      throw new ConflictError(
        "You need a default SCRIPT prompt before a schedule has anything to generate from.",
      );
    }

    const declared = setup.prompt.duration
      ? [...setup.prompt.fields, setup.prompt.duration]
      : setup.prompt.fields;

    const missing = declared
      .filter(
        (field) =>
          field.required && !field.defaultValue && !(variables[field.key] ?? "").trim(),
      )
      .map((field) => field.label);

    if (missing.length > 0) {
      throw new ValidationError(
        `Your script prompt needs ${missing.length === 1 ? "an answer" : "answers"} for: ${missing.join(", ")}.`,
      );
    }
  }
}

export const scheduleService = new ScheduleService();
