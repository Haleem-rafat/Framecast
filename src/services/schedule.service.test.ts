import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  advancePast,
  firstOccurrenceAfter,
  nextOccurrence,
  wallClockToInstant,
  type Recurrence,
} from "@/lib/schedule-time";
import { AutomationService } from "@/services/automation.service";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScheduleService } from "@/services/schedule.service";
import { ScriptService } from "@/services/script.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same discipline as script.service.test.ts and automation.service.test.ts:
// these run against a real, shared Postgres database that also holds the
// operator's real data, so every test gets its own throwaway User
// (src/test/fixtures.ts) and never touches a real project or credential.
//
// ProviderUsage is the one table that escapes that cascade — the rows
// scriptService.generate writes have no userId of their own — so this run's
// rows are tagged through the fake provider's `model` string and swept by it.
const RUN = randomUUID().slice(0, 8);
const FAKE_MODEL = `test-schedule-model-${RUN}`;

// A tick is a claim, a readiness check, a topic claim, a run and two history
// writes — a dozen sequential round trips to a remote database, and the
// concurrency tests do that several times over.
vi.setConfig({ testTimeout: 40_000 });

const SCRIPT = "A schedule is a button somebody else presses for you.";

/**
 * Recurrence tests need no database at all — src/lib/schedule-time.ts is pure —
 * and that is deliberate: the DST behaviour is the part of this feature most
 * likely to be wrong and least likely to be noticed, so it must be assertable
 * without a network.
 */
function weekly(timeZone: string, dayOfWeek: number, hour: number, minute = 0): Recurrence {
  return { frequency: "WEEKLY", dayOfWeek, dayOfMonth: null, hour, minute, timeZone };
}

function monthly(timeZone: string, dayOfMonth: number, hour: number): Recurrence {
  return { frequency: "MONTHLY", dayOfWeek: null, dayOfMonth, hour, minute: 0, timeZone };
}

/** How a clock in `timeZone` reads at `instant`, as "YYYY-MM-DD HH:MM". The
 *  assertions below are about wall clocks, so they are written in wall clocks
 *  rather than in offsets the reader has to hold in their head. */
function localReading(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return `${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
}

const HOURS = 60 * 60 * 1000;

describe("schedule-time — timezones and DST", () => {
  it("keeps 09:00 meaning 09:00 across a spring-forward transition", () => {
    // Europe/London moves to BST on Sunday 29 March 2026. The Monday before is
    // GMT, the Monday after is BST. Adding seven days of milliseconds to the
    // first would produce 10:00 local on the second — the exact bug this whole
    // module exists to avoid — so the interval here must be 167 hours, not 168.
    const from = new Date("2026-03-23T09:00:00Z");
    const next = nextOccurrence(weekly("Europe/London", 1, 9), from);

    expect(localReading(next, "Europe/London")).toBe("2026-03-30 09:00");
    expect(next.toISOString()).toBe("2026-03-30T08:00:00.000Z");
    expect((next.getTime() - from.getTime()) / HOURS).toBe(167);
  });

  it("keeps 09:00 meaning 09:00 across an autumn-back transition", () => {
    // The mirror image: BST ends on Sunday 25 October 2026, so this interval is
    // 169 hours. A schedule that drifted an hour every March would drift back
    // every October, which is exactly why the bug survives a casual look.
    const from = new Date("2026-10-19T08:00:00Z");
    const next = nextOccurrence(weekly("Europe/London", 1, 9), from);

    expect(localReading(next, "Europe/London")).toBe("2026-10-26 09:00");
    expect((next.getTime() - from.getTime()) / HOURS).toBe(169);
  });

  it("does the same in a zone whose transitions fall on different dates", () => {
    // America/New_York switches on 8 March 2026, three weeks before London.
    // Asserting a second zone is what proves the arithmetic reads the IANA
    // database rather than hard-coding one region's rules.
    const from = new Date("2026-03-02T14:00:00Z");
    const next = nextOccurrence(weekly("America/New_York", 1, 9), from);

    expect(localReading(next, "America/New_York")).toBe("2026-03-09 09:00");
    expect((next.getTime() - from.getTime()) / HOURS).toBe(167);
  });

  it("moves a run forward, never backward, when its local time does not exist", () => {
    // 01:00–01:59 on 29 March 2026 is deleted in London. A schedule set for
    // 01:30 on a Sunday has to land somewhere, and the only acceptable
    // direction is later: a run that fired at 00:30 would be a video produced
    // before the operator asked for one.
    const deleted = wallClockToInstant(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
      "Europe/London",
    );

    expect(localReading(deleted, "Europe/London")).toBe("2026-03-29 02:30");

    // Same rule in a zone with the opposite offset sign, where a naive
    // implementation errs in the other direction.
    const deletedNy = wallClockToInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      "America/New_York",
    );

    expect(localReading(deletedNy, "America/New_York")).toBe("2026-03-08 03:30");
  });

  it("picks the earlier of the two instants when a local time happens twice", () => {
    // 01:30 occurs twice on 25 October 2026 in London. Both readings are
    // correct; what matters is that the answer is deterministic, so the
    // interval never silently stretches by an hour.
    const repeated = wallClockToInstant(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      "Europe/London",
    );

    expect(repeated.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(localReading(repeated, "Europe/London")).toBe("2026-10-25 01:30");
  });

  it("clamps a monthly schedule to the last day of a month that is too short", () => {
    // Not skipped: "monthly" has to mean twelve runs a year, and a February
    // that quietly produced nothing would be a gap nobody could have predicted
    // from the form.
    const february = nextOccurrence(monthly("UTC", 31, 9), new Date("2026-01-31T09:00:00Z"));
    expect(february.toISOString()).toBe("2026-02-28T09:00:00.000Z");

    // And the clamp does not stick — March gets its 31st back.
    const march = nextOccurrence(monthly("UTC", 31, 9), february);
    expect(march.toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });

  it("never returns an occurrence at or before the instant it was given", () => {
    // Inclusive comparison here would mean a claimed occurrence advances to
    // itself, which is an infinite loop in the worker rather than a wrong time.
    const exactly = new Date("2026-03-23T09:00:00Z");

    expect(nextOccurrence(weekly("Europe/London", 1, 9), exactly).getTime()).toBeGreaterThan(
      exactly.getTime(),
    );
  });

  it("starts a new schedule at the next occurrence, never immediately", () => {
    // A Monday schedule created on a Monday afternoon must not bill a video the
    // moment Save is pressed.
    const now = new Date("2026-03-23T15:00:00Z");
    const first = firstOccurrenceAfter(weekly("Europe/London", 1, 9), now);

    expect(first.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });
});

describe("schedule-time — downtime does not become a burst", () => {
  it("advances past every missed occurrence rather than owing them", () => {
    // The worker was down from 2 March to 26 March: three Mondays passed. The
    // rule is that an occurrence is a moment, not a debt, so this reports one
    // future occurrence and three that were stepped over — never four videos.
    const catchUp = advancePast(
      weekly("Europe/London", 1, 9),
      new Date("2026-03-02T09:00:00Z"),
      new Date("2026-03-26T12:00:00Z"),
    );

    expect(catchUp.nextRunAt.toISOString()).toBe("2026-03-30T08:00:00.000Z");
    expect(catchUp.nextRunAt.getTime()).toBeGreaterThan(Date.parse("2026-03-26T12:00:00Z"));
    expect(catchUp.skippedTotal).toBe(3);
    expect(catchUp.skipped.map((date) => date.toISOString())).toEqual([
      "2026-03-09T09:00:00.000Z",
      "2026-03-16T09:00:00.000Z",
      "2026-03-23T09:00:00.000Z",
    ]);
  });

  it("reports nothing skipped for a schedule that is merely a few hours late", () => {
    // The ordinary case: the worker restarted, or the poll landed a minute
    // after the occurrence. One run, no missed rows.
    const catchUp = advancePast(
      weekly("Europe/London", 1, 9),
      new Date("2026-03-23T09:00:00Z"),
      new Date("2026-03-23T11:00:00Z"),
    );

    expect(catchUp.skippedTotal).toBe(0);
    expect(catchUp.nextRunAt.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });

  it("truncates the recorded misses for a schedule dormant for years, but not the count", () => {
    const catchUp = advancePast(
      weekly("UTC", 1, 9),
      new Date("2020-01-06T09:00:00Z"),
      new Date("2026-01-05T09:00:00Z"),
    );

    expect(catchUp.skippedTotal).toBeGreaterThan(12);
    expect(catchUp.skipped).toHaveLength(12);
    expect(catchUp.nextRunAt.getTime()).toBeGreaterThan(Date.parse("2026-01-05T09:00:00Z"));
  });
});

// ---------------------------------------------------------------------------
// Everything below drives real rows.
// ---------------------------------------------------------------------------

function fakeProvider(): Pick<TextGenerationProvider, "generateScript"> {
  return {
    generateScript: vi.fn(async () => ({
      content: SCRIPT,
      model: FAKE_MODEL,
      provider: "ANTHROPIC" as const,
      inputTokens: 100,
      outputTokens: 400,
      costUsd: 0.0063,
      latencyMs: 1200,
    })),
  };
}

async function cleanupProviderUsage(): Promise<void> {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
}

let userId: string;
let projectId: string;

/** Everything `automationService.getSetup` refuses to run without, so a test
 *  that is not about readiness never trips over it. */
async function makeReadyAccount(): Promise<string> {
  await channelService.connect(userId, {
    youtubeChannelId: `UC_schedule_${RUN}_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  await providerCredentialService.upsert(userId, {
    provider: "ELEVENLABS",
    apiKey: `sk-schedule-${RUN}`,
    label: RUN,
  });
  await prisma.promptTemplate.create({
    data: {
      userId,
      name: `Default script ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}} for {{audience}}.",
      isDefault: true,
      variables: {
        create: [
          { key: "topic", label: "Topic", required: true },
          { key: "audience", label: "Audience", defaultValue: "general viewers" },
        ],
      },
    },
  });

  const project = await projectService.create(userId, { name: `Schedule ${RUN}` });

  return project.id;
}

/**
 * A stand-in for the guided flow.
 *
 * Injected rather than mocked at the module level so the tests below exercise
 * `ScheduleService`'s real claim, real topic consumption and real history
 * writes while billing nothing. `start` creates a genuine `Video` row, because
 * `ScheduleRun.videoId` is a real foreign key and a fabricated id would fail
 * the insert rather than the assertion.
 */
function fakeAutomation(options?: {
  blockers?: { id: string; title: string; description: string; href: string }[];
  fail?: Error;
}) {
  return {
    getSetup: vi.fn(async () => ({
      blockers: options?.blockers ?? [],
      projects: [{ id: projectId, name: `Schedule ${RUN}`, channelTitle: null }],
      prompt: {
        id: "prompt",
        name: `Default script ${RUN}`,
        fields: [
          {
            key: "audience",
            label: "Audience",
            defaultValue: "general viewers",
            required: false,
          },
        ],
        duration: null,
      },
    })),
    start: vi.fn(async (owner: string, input: { projectId: string; topic: string }) => {
      if (options?.fail) {
        throw options.fail;
      }

      const video = await prisma.video.create({
        data: {
          userId: owner,
          projectId: input.projectId,
          title: input.topic.slice(0, 60),
          topic: input.topic,
          status: "QUEUED",
        },
      });

      return {
        videoId: video.id,
        title: video.title,
        scriptVersion: 1,
        wordCount: 9,
        scriptContent: SCRIPT,
      };
    }),
  };
}

/** A schedule that is already overdue, so a single `tick()` fires it. */
async function makeDueSchedule(options?: {
  dueAt?: Date;
  topics?: string[];
  timeZone?: string;
}): Promise<string> {
  const schedule = await prisma.schedule.create({
    data: {
      userId,
      projectId,
      name: `Weekly ${RUN}`,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timeZone: options?.timeZone ?? "UTC",
      variables: {},
      nextRunAt: options?.dueAt ?? new Date(Date.now() - 60_000),
      topics: {
        create: (options?.topics ?? ["topic one", "topic two"]).map((topic, index) => ({
          position: index,
          topic,
        })),
      },
    },
    select: { id: true },
  });

  return schedule.id;
}

beforeEach(async () => {
  await cleanupProviderUsage();
  userId = await createTestUser("schedule");
  projectId = await makeReadyAccount();

  // ScriptService resolves an ANTHROPIC credential before reaching the
  // (injected, fake) provider. This user has none, so this would legitimately
  // return null anyway — stubbed only to keep a real lookup off the critical
  // path.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupProviderUsage();
  await deleteTestUser(userId);
});

afterAll(cleanupProviderUsage);

describe("scheduleService — a due schedule fires exactly once", () => {
  it("produces one video and consumes one topic", async () => {
    const scheduleId = await makeDueSchedule();
    const automation = fakeAutomation();

    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("SUCCEEDED");
    expect(automation.start).toHaveBeenCalledTimes(1);
    expect(automation.start.mock.calls[0][1].topic).toBe("topic one");

    const runs = await prisma.scheduleRun.findMany({ where: { scheduleId } });
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("SUCCEEDED");
    expect(runs[0].topic).toBe("topic one");
    expect(runs[0].videoId).toBe(result?.videoId);

    // The head of the queue is spent; the next run takes the one after it.
    const topics = await prisma.scheduleTopic.findMany({
      where: { scheduleId },
      orderBy: { position: "asc" },
    });
    expect(topics[0].consumedAt).not.toBeNull();
    expect(topics[1].consumedAt).toBeNull();
  });

  it("advances nextRunAt into the future and releases the claim", async () => {
    const scheduleId = await makeDueSchedule();

    await new ScheduleService(fakeAutomation()).tick();

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.nextRunAt).not.toBeNull();
    expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // A lease left behind would make the schedule skip its own next occurrence.
    expect(schedule.claimExpiresAt).toBeNull();
    expect(schedule.status).toBe("ACTIVE");
  });

  it("is no longer due immediately afterwards", async () => {
    await makeDueSchedule();
    const service = new ScheduleService(fakeAutomation());

    expect(await service.tick()).not.toBeNull();
    expect(await service.tick()).toBeNull();
  });

  it("never fires twice under concurrent ticks", async () => {
    // The failure this prevents is a paid one: two workers poll the same table,
    // both see the same due schedule, and the operator is billed twice for one
    // occurrence. Run several rounds so the race is genuinely exercised rather
    // than accidentally serialised by a fast first call.
    for (let round = 0; round < 5; round++) {
      const scheduleId = await makeDueSchedule({
        topics: ["only topic"],
      });
      const automation = fakeAutomation();

      // Two independent services, as two workers would be, sharing one fake so
      // the call count is across both.
      const [first, second] = await Promise.all([
        new ScheduleService(automation).tick(),
        new ScheduleService(automation).tick(),
      ]);

      const fired = [first, second].filter((result) => result !== null);

      expect(fired).toHaveLength(1);
      expect(automation.start).toHaveBeenCalledTimes(1);

      // And the durable record agrees: one history row, one consumed topic.
      const runs = await prisma.scheduleRun.findMany({ where: { scheduleId } });
      expect(runs).toHaveLength(1);

      const consumed = await prisma.scheduleTopic.count({
        where: { scheduleId, consumedAt: { not: null } },
      });
      expect(consumed).toBe(1);

      await prisma.schedule.delete({ where: { id: scheduleId } });
    }
  });

  it("cannot be claimed twice for the same occurrence even by a repeated claim", async () => {
    // `claimDue` is the lock; this asserts it directly rather than through
    // `tick`, because it is the single statement everything else rests on.
    const scheduleId = await makeDueSchedule();
    const service = new ScheduleService(fakeAutomation());

    const claims = await Promise.all([
      service.claimDue(),
      service.claimDue(),
      service.claimDue(),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("scheduleService — downtime does not become a burst", () => {
  it("produces one video for three weeks of missed occurrences, and records the rest", async () => {
    // The worker was down for three weeks. A daily-style catch-up would spend
    // three times over in three minutes; the rule is that a missed occurrence
    // is gone, not owed.
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * HOURS);
    const scheduleId = await makeDueSchedule({
      dueAt: threeWeeksAgo,
      topics: ["topic one", "topic two", "topic three", "topic four"],
    });
    const automation = fakeAutomation();

    await new ScheduleService(automation).tick();

    expect(automation.start).toHaveBeenCalledTimes(1);

    const runs = await prisma.scheduleRun.findMany({
      where: { scheduleId },
      orderBy: { scheduledFor: "asc" },
    });

    // Exactly one produced a video; the rest are recorded as missed so the gap
    // in the operator's channel has an explanation.
    expect(runs.filter((run) => run.outcome === "SUCCEEDED")).toHaveLength(1);
    expect(runs.filter((run) => run.outcome === "MISSED").length).toBeGreaterThan(0);
    expect(runs.every((run) => run.videoId === null || run.outcome === "SUCCEEDED")).toBe(
      true,
    );

    // Only one topic was spent, not one per missed occurrence.
    const consumed = await prisma.scheduleTopic.count({
      where: { scheduleId, consumedAt: { not: null } },
    });
    expect(consumed).toBe(1);

    // And nothing is left due, so the next poll does not fire again.
    expect(await new ScheduleService(automation).tick()).toBeNull();
  });

  it("explains a missed occurrence rather than leaving a silent gap", async () => {
    const scheduleId = await makeDueSchedule({
      dueAt: new Date(Date.now() - 21 * 24 * HOURS),
    });

    await new ScheduleService(fakeAutomation()).tick();

    const missed = await prisma.scheduleRun.findFirstOrThrow({
      where: { scheduleId, outcome: "MISSED" },
    });

    expect(missed.reason).toContain("Nothing was running");
    expect(missed.topic).toBeNull();
  });
});

describe("scheduleService — refusing before spending", () => {
  it("skips without calling the model when the account is not ready", async () => {
    // The exact failure this exists for: narration is the first paid stage
    // after the script, so a run with no ElevenLabs key pays for a script
    // attached to a video that can never finish.
    const scheduleId = await makeDueSchedule();
    const automation = fakeAutomation({
      blockers: [
        {
          id: "add-narration-key",
          title: "Add your ElevenLabs API key",
          description: "Narration needs it.",
          href: "/providers",
        },
      ],
    });

    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(automation.start).not.toHaveBeenCalled();
    expect(result?.reason).toContain("elevenlabs");

    // No topic was spent on a run that produced nothing.
    const consumed = await prisma.scheduleTopic.count({
      where: { scheduleId, consumedAt: { not: null } },
    });
    expect(consumed).toBe(0);

    // A missing key is fixable, so the schedule stays active and simply tries
    // again next week rather than needing to be resumed by hand.
    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("ACTIVE");
    expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses itself, without spending, when the topic queue is empty", async () => {
    const scheduleId = await makeDueSchedule({ topics: [] });
    const automation = fakeAutomation();

    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(automation.start).not.toHaveBeenCalled();

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("PAUSED");
    // The whole argument for a queue over a model-invented topic: when it runs
    // out, the studio stops rather than guessing.
    expect(schedule.pausedReason).toContain("invents");
  });

  it("skips when the project has been archived", async () => {
    const scheduleId = await makeDueSchedule();
    await projectService.archive(userId, projectId);

    const automation = fakeAutomation();
    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("SKIPPED");
    expect(automation.start).not.toHaveBeenCalled();
    expect(result?.reason).toContain("archived");

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("ACTIVE");
  });
});

describe("scheduleService — a failed run does not kill the schedule", () => {
  it("records the failure, advances, and stays active", async () => {
    const scheduleId = await makeDueSchedule();
    const automation = fakeAutomation({ fail: new Error("Anthropic rejected the key") });

    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("FAILED");
    expect(result?.reason).toBe("Anthropic rejected the key");

    const run = await prisma.scheduleRun.findFirstOrThrow({ where: { scheduleId } });
    expect(run.outcome).toBe("FAILED");
    // The topic is named on the failure, so the operator knows exactly what was
    // lost and can re-queue it.
    expect(run.topic).toBe("topic one");
    expect(run.videoId).toBeNull();

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("ACTIVE");
    expect(schedule.consecutiveFailures).toBe(1);
    expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(schedule.claimExpiresAt).toBeNull();
  });

  it("pauses only after three failures in a row", async () => {
    // Past three, the fault is not weather — it is a lapsed key or a broken
    // prompt, and every further attempt is a billed call that fails the same
    // way, once a week, until somebody notices.
    const scheduleId = await makeDueSchedule({
      topics: ["one", "two", "three", "four"],
    });
    const automation = fakeAutomation({ fail: new Error("still broken") });
    const service = new ScheduleService(automation);

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Each iteration puts the schedule back in the past so the next tick is
      // due, which is what three consecutive weeks would do in production.
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          nextRunAt: new Date(Date.now() - attempt * 60_000),
          status: "ACTIVE",
        },
      });

      await service.tick();
    }

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.consecutiveFailures).toBe(3);
    expect(schedule.status).toBe("PAUSED");
    expect(schedule.pausedReason).toContain("3 runs in a row failed");
    expect(schedule.pausedReason).toContain("still broken");
  });

  it("resets the failure count on the next success", async () => {
    const scheduleId = await makeDueSchedule();

    await new ScheduleService(
      fakeAutomation({ fail: new Error("one bad week") }),
    ).tick();

    expect(
      (await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } }))
        .consecutiveFailures,
    ).toBe(1);

    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });
    await new ScheduleService(fakeAutomation()).tick();

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.consecutiveFailures).toBe(0);
    expect(schedule.status).toBe("ACTIVE");
  });
});

describe("scheduleService — a scheduled run never publishes", () => {
  it("stops at a queued video, with no Publication and no PUBLISHED transition", async () => {
    // The line this feature must not cross, asserted through the *real*
    // AutomationService (only the model call is faked) so the property holds
    // over the production composition rather than over a stub of it. Letting a
    // schedule spend money unattended is only acceptable because the second
    // gate — publishing — stays a human click.
    const scheduleId = await makeDueSchedule({ topics: ["how a port unloads a ship"] });
    const automation = new AutomationService(new ScriptService(fakeProvider()));

    const result = await new ScheduleService(automation).tick();

    expect(result?.outcome).toBe("SUCCEEDED");
    expect(result?.videoId).not.toBeNull();

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result!.videoId! },
      include: { publication: true, script: { include: { activeVersion: true } } },
    });

    // Gate 1 crossed on the operator's behalf, as the guided flow does.
    expect(video.status).toBe("QUEUED");
    expect(video.script?.activeVersion?.content).toBe(SCRIPT);

    // Gate 2 emphatically not crossed.
    expect(video.publication).toBeNull();
    expect(video.status).not.toBe("PUBLISHED");
    expect(
      await prisma.videoStatusEvent.findFirst({
        where: { videoId: video.id, to: "PUBLISHED" },
      }),
    ).toBeNull();
    expect(await prisma.publication.count({ where: { video: { userId } } })).toBe(0);

    // And the schedule's own history points at the video rather than at a
    // publication.
    const run = await prisma.scheduleRun.findFirstOrThrow({ where: { scheduleId } });
    expect(run.videoId).toBe(video.id);
  });
});

describe("scheduleService — operator actions", () => {
  it("pauses immediately, so the very next due-check ignores it", async () => {
    const scheduleId = await makeDueSchedule();
    const service = new ScheduleService(fakeAutomation());

    await service.pause(userId, scheduleId, "Paused by the operator.");

    // Still overdue by the clock, and still not claimed — which is the whole
    // meaning of "pausing is immediate".
    expect(await service.claimDue()).toBeNull();
    expect(await service.tick()).toBeNull();

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("PAUSED");
    expect(schedule.pausedReason).toBe("Paused by the operator.");
  });

  it("resumes from the next occurrence rather than catching up", async () => {
    const scheduleId = await makeDueSchedule({
      dueAt: new Date(Date.now() - 21 * 24 * HOURS),
    });
    const service = new ScheduleService(fakeAutomation());

    await service.pause(userId, scheduleId);
    await service.resume(userId, scheduleId);

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.status).toBe("ACTIVE");
    expect(schedule.pausedReason).toBeNull();
    // Not the three-week-old occurrence: resuming means "carry on from here".
    expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await service.claimDue()).toBeNull();
  });

  it("refuses to resume into an empty queue", async () => {
    const scheduleId = await makeDueSchedule({ topics: [] });
    const service = new ScheduleService(fakeAutomation());

    await service.pause(userId, scheduleId);

    await expect(service.resume(userId, scheduleId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("clears a self-imposed failure pause when the operator resumes", async () => {
    const scheduleId = await makeDueSchedule();
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { status: "PAUSED", consecutiveFailures: 3, pausedReason: "three failures" },
    });

    await new ScheduleService(fakeAutomation()).resume(userId, scheduleId);

    const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(schedule.consecutiveFailures).toBe(0);
    expect(schedule.pausedReason).toBeNull();
  });

  it("appends topics to the end of the queue, never ahead of waiting ones", async () => {
    const scheduleId = await makeDueSchedule({ topics: ["first", "second"] });
    const service = new ScheduleService(fakeAutomation());

    await service.addTopics(userId, scheduleId, { topics: ["third", "fourth"] });

    const topics = await prisma.scheduleTopic.findMany({
      where: { scheduleId },
      orderBy: { position: "asc" },
    });
    expect(topics.map((topic) => topic.topic)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("refuses to remove a topic that has already been used", async () => {
    const scheduleId = await makeDueSchedule({ topics: ["only topic"] });
    const service = new ScheduleService(fakeAutomation());

    await service.tick();

    const consumed = await prisma.scheduleTopic.findFirstOrThrow({ where: { scheduleId } });

    await expect(
      service.removeTopic(userId, scheduleId, consumed.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not move nextRunAt when only the name is edited", async () => {
    // A destructive side effect this used to be prone to: renaming a schedule
    // at 08:59 on a Monday pushing that morning's run to next week.
    const scheduleId = await makeDueSchedule();
    const before = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });

    await new ScheduleService(fakeAutomation()).update(userId, scheduleId, {
      name: "Renamed",
      projectId,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      dayOfMonth: null,
      hour: 9,
      minute: 0,
      timeZone: "UTC",
      variables: {},
    });

    const after = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(after.name).toBe("Renamed");
    expect(after.nextRunAt?.getTime()).toBe(before.nextRunAt?.getTime());
  });

  it("recomputes nextRunAt when the timing changes", async () => {
    const scheduleId = await makeDueSchedule();

    await new ScheduleService(fakeAutomation()).update(userId, scheduleId, {
      name: `Weekly ${RUN}`,
      projectId,
      frequency: "WEEKLY",
      dayOfWeek: 4,
      dayOfMonth: null,
      hour: 17,
      minute: 30,
      timeZone: "Europe/London",
      variables: {},
    });

    const after = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("scheduleService — every query is scoped to the signed-in user", () => {
  it("does not return, edit or pause another operator's schedule", async () => {
    const scheduleId = await makeDueSchedule();
    const otherUserId = await createTestUser("schedule-other");
    const service = new ScheduleService(fakeAutomation());

    try {
      await expect(service.get(otherUserId, scheduleId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.pause(otherUserId, scheduleId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        service.addTopics(otherUserId, scheduleId, { topics: ["smuggled"] }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // And nothing leaked through: the schedule is untouched.
      const schedule = await prisma.schedule.findUniqueOrThrow({
        where: { id: scheduleId },
      });
      expect(schedule.status).toBe("ACTIVE");
      expect(
        await prisma.scheduleTopic.count({ where: { scheduleId, topic: "smuggled" } }),
      ).toBe(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("lists only the signed-in operator's schedules", async () => {
    await makeDueSchedule();
    const otherUserId = await createTestUser("schedule-other-list");

    try {
      expect(await new ScheduleService(fakeAutomation()).list(otherUserId)).toEqual([]);
      expect(await new ScheduleService(fakeAutomation()).list(userId)).toHaveLength(1);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});
