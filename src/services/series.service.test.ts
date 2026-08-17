import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { AutomationService } from "@/services/automation.service";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { promptTemplateService } from "@/services/prompt-template.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScheduleService } from "@/services/schedule.service";
import { ScriptService } from "@/services/script.service";
import { SeriesService } from "@/services/series.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same discipline as schedule.service.test.ts and automation.service.test.ts:
// these run against a real, shared Postgres database that also holds the
// operator's real data, so every test gets its own throwaway User
// (src/test/fixtures.ts) and never touches a real project, credential or
// channel.
//
// ProviderUsage is the one table that escapes that cascade — the rows
// scriptService.generate writes have no userId of their own — so this run's
// rows are tagged through the fake provider's `model` string and swept by it.
const RUN = randomUUID().slice(0, 8);
const FAKE_MODEL = `test-series-model-${RUN}`;

// A run here is the whole flow — the recipe, a claim, a topic take, a video, a
// script, an approval and two history writes — which is a couple of dozen
// sequential round trips to a remote database.
vi.setConfig({ testTimeout: 40_000 });

const SCRIPT = "A series is five screens' worth of answers, given once.";

function fakeProvider(options?: { fail?: Error }): Pick<
  TextGenerationProvider,
  "generateScript"
> {
  return {
    generateScript: vi.fn(async () => {
      if (options?.fail) {
        throw options.fail;
      }

      return {
        content: SCRIPT,
        model: FAKE_MODEL,
        provider: "ANTHROPIC" as const,
        inputTokens: 100,
        outputTokens: 400,
        costUsd: 0.0063,
        latencyMs: 1200,
      };
    }),
  };
}

/**
 * The production wiring, with exactly one thing faked: the model call.
 *
 * `SeriesService` composes the *real* `ScheduleService`, so the claim, the
 * advance past missed occurrences, the atomic topic take and the consecutive-
 * failure counter exercised below are the ones the worker runs — not stand-ins.
 * And it composes the real `AutomationService` over a real `ScriptService`, so
 * the video row, the script version, Gate 1 and the hard stop before publishing
 * are all the production code paths.
 */
function makeServices(provider = fakeProvider()) {
  const automation = new AutomationService(new ScriptService(provider));
  const schedules = new ScheduleService(automation, automation);
  const series = new SeriesService(automation, schedules);

  return { automation, schedules, series };
}

async function cleanupProviderUsage(): Promise<void> {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
}

let userId: string;
/** A channel, a project that publishes to it, and two distinct script styles —
 *  which is the minimum an operator needs to express "two shows on one
 *  channel". */
let channelId: string;
let projectId: string;
let deepDiveStyleId: string;
let quickTipsStyleId: string;

const DEEP_DIVE_CONTENT =
  "Write a long explainer about {{topic}} for {{audience}} in a {{tone}} tone.";
const QUICK_TIPS_CONTENT = "Write a 45-second tip about {{topic}}. {{hook}}";

async function makeStyle(
  owner: string,
  name: string,
  content: string,
  variables: { key: string; label: string; defaultValue?: string; required?: boolean }[],
  isDefault = false,
): Promise<string> {
  const template = await prisma.promptTemplate.create({
    data: {
      userId: owner,
      name,
      category: "SCRIPT",
      content,
      isDefault,
      variables: {
        create: variables.map((variable) => ({
          key: variable.key,
          label: variable.label,
          defaultValue: variable.defaultValue ?? null,
          required: variable.required ?? false,
        })),
      },
    },
    select: { id: true },
  });

  return template.id;
}

/** Everything `automationService.getSetup` refuses to run without, plus the
 *  channel-to-project link a series additionally needs. */
async function makeReadyAccount(owner: string): Promise<{
  channelId: string;
  projectId: string;
}> {
  const channel = await channelService.connect(owner, {
    youtubeChannelId: `UC_series_${RUN}_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  // A throwaway key on a throwaway user — never the operator's real one.
  await providerCredentialService.upsert(owner, {
    provider: "ELEVENLABS",
    apiKey: `sk-series-${RUN}`,
    label: RUN,
  });

  const project = await projectService.create(owner, {
    name: `Series ${RUN}`,
    channelId: channel.id,
  });

  return { channelId: channel.id, projectId: project.id };
}

/** The cadence half of every payload below. Deliberately in the past-friendly
 *  shape the schedule tests use: a weekly Monday 09:00 UTC. */
const CADENCE = {
  frequency: "WEEKLY" as const,
  dayOfWeek: 1,
  dayOfMonth: null,
  hour: 9,
  minute: 0,
  timeZone: "UTC",
};

/**
 * The auto-publish pair at its defaults.
 *
 * Restated rather than folded into `CADENCE` above, which is about *when* a
 * schedule fires and has nothing to say about publishing. Needed at all because
 * `z.infer` gives the output type, where a defaulted field is required.
 */
const NO_AUTO_PUBLISH = {
  autoPublish: false,
  publishVisibility: "PRIVATE" as const,
};

function seriesInput(overrides: Partial<Parameters<SeriesService["create"]>[1]> = {}) {
  return {
    name: `Deep dive ${RUN}`,
    channelId,
    projectId,
    promptTemplateId: deepDiveStyleId,
    format: "LANDSCAPE" as const,
    ...CADENCE,
    // A test that wants a show which publishes itself overrides these.
    ...NO_AUTO_PUBLISH,
    variables: { audience: "curious adults", tone: "measured" },
    topics: ["why ports are always busy"],
    ...overrides,
  };
}

/** Makes a series' cadence overdue so a single `tick()` fires it, exactly as
 *  `makeDueSchedule` does in schedule.service.test.ts. */
async function makeDue(seriesId: string, dueAt = new Date(Date.now() - 60_000)) {
  await prisma.schedule.updateMany({
    where: { seriesId },
    data: { nextRunAt: dueAt },
  });
}

/**
 * Gate 1, asserted through the append-only history rather than through
 * `Video.status`.
 *
 * Same reasoning `automation.service.test.ts` spells out: `Video.status` is
 * denormalised and a worker is entitled to move it the instant the approval
 * commits, while the DRAFT -> QUEUED `VideoStatusEvent` is written inside
 * `approveScript`'s own transaction and never updated.
 */
async function expectGate1Crossed(videoId: string): Promise<void> {
  const approval = await prisma.videoStatusEvent.findFirst({
    where: { videoId, from: "DRAFT", to: "QUEUED" },
  });

  expect(approval, `video ${videoId} never crossed DRAFT -> QUEUED`).not.toBeNull();
}

beforeEach(async () => {
  await cleanupProviderUsage();
  userId = await createTestUser("series");

  const ready = await makeReadyAccount(userId);
  channelId = ready.channelId;
  projectId = ready.projectId;

  deepDiveStyleId = await makeStyle(
    userId,
    `Deep dive ${RUN}`,
    DEEP_DIVE_CONTENT,
    [
      { key: "topic", label: "Topic", required: true },
      { key: "audience", label: "Audience", required: true },
      { key: "tone", label: "Tone", defaultValue: "clear and factual" },
    ],
    true,
  );

  quickTipsStyleId = await makeStyle(userId, `Quick tips ${RUN}`, QUICK_TIPS_CONTENT, [
    { key: "topic", label: "Topic", required: true },
    { key: "hook", label: "Opening hook", defaultValue: "Start with the surprise." },
  ]);

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

describe("seriesService — a video made from a series inherits every setting", () => {
  it("applies the script style, the format, the project and the channel without re-asking", async () => {
    const { series } = makeServices();

    const created = await series.create(
      userId,
      seriesInput({ format: "VERTICAL", promptTemplateId: quickTipsStyleId }),
    );

    // "Make one now": one call, no arguments beyond the series id. Everything
    // else comes off the recipe.
    const run = await series.generateNow(userId, created.id);

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: run.videoId },
      include: { script: { include: { activeVersion: true } } },
    });

    // The format the series chose, written by the same `approveScript` the
    // approve dialog calls.
    expect(video.format).toBe("VERTICAL");
    // The project the series files into, and through it the channel whose brand
    // the renderer will resolve.
    expect(video.projectId).toBe(projectId);
    expect(video.seriesId).toBe(created.id);
    // The topic came off the operator's own queue, not from a model.
    expect(video.topic).toBe("why ports are always busy");

    // The script style the series names actually wrote it: the stored prompt is
    // that template's content with the series' answers substituted.
    expect(video.script?.activeVersion?.prompt).toContain("45-second tip");
    expect(video.script?.activeVersion?.prompt).toContain("Start with the surprise.");
    expect(video.script?.activeVersion?.content).toBe(SCRIPT);

    await expectGate1Crossed(run.videoId);
  });

  it("uses the same recipe on a scheduled run as on an on-demand one", async () => {
    const { series, schedules } = makeServices();

    const created = await series.create(
      userId,
      seriesInput({
        format: "VERTICAL",
        promptTemplateId: quickTipsStyleId,
        topics: ["one", "two"],
      }),
    );

    const manual = await series.generateNow(userId, created.id);

    await makeDue(created.id);
    const tick = await schedules.tick();

    expect(tick?.outcome).toBe("SUCCEEDED");

    const [manualVideo, scheduledVideo] = await Promise.all([
      prisma.video.findUniqueOrThrow({
        where: { id: manual.videoId },
        include: { script: { include: { activeVersion: true } } },
      }),
      prisma.video.findUniqueOrThrow({
        where: { id: tick!.videoId! },
        include: { script: { include: { activeVersion: true } } },
      }),
    ]);

    // Identical configuration by construction — both went through
    // `automationService.start` with the same three options.
    expect(scheduledVideo.format).toBe(manualVideo.format);
    expect(scheduledVideo.seriesId).toBe(manualVideo.seriesId);
    expect(scheduledVideo.projectId).toBe(manualVideo.projectId);
    expect(scheduledVideo.script?.activeVersion?.prompt).toContain("45-second tip");

    // ...and they are different episodes, taken in queue order.
    expect(manualVideo.topic).toBe("one");
    expect(scheduledVideo.topic).toBe("two");
  });

  it("records the on-demand run without inventing a schedule occurrence", async () => {
    const { series } = makeServices();
    const created = await series.create(userId, seriesInput());

    const run = await series.generateNow(userId, created.id);

    const disclosure = await prisma.activityLog.findFirst({
      where: {
        userId,
        action: "series.generateNow",
        entityType: "Video",
        entityId: run.videoId,
      },
    });

    expect(disclosure).not.toBeNull();

    // `ScheduleRun` is a record of *occurrences of the cadence*, which this was
    // not. Writing one would put a row in the history at a time the recurrence
    // never named.
    const detail = await series.get(userId, created.id);
    expect(detail.runs).toHaveLength(0);
    // The video is still attributed to the show, through `Video.seriesId`.
    expect(detail.videos.map((video) => video.id)).toContain(run.videoId);
  });
});

describe("seriesService — two series on one channel", () => {
  it("produce differently configured videos from the same brand", async () => {
    const { series } = makeServices();

    const deepDive = await series.create(
      userId,
      seriesInput({
        name: `Deep dive ${RUN}`,
        promptTemplateId: deepDiveStyleId,
        format: "LANDSCAPE",
        topics: ["how index funds took over"],
      }),
    );

    const quickTips = await series.create(
      userId,
      seriesInput({
        name: `Quick tips ${RUN}`,
        promptTemplateId: quickTipsStyleId,
        format: "VERTICAL",
        frequency: "MONTHLY",
        dayOfWeek: null,
        dayOfMonth: 1,
        topics: ["why airlines overbook"],
      }),
    );

    const [long, short] = await Promise.all([
      series.generateNow(userId, deepDive.id),
      series.generateNow(userId, quickTips.id),
    ]);

    const [longVideo, shortVideo] = await Promise.all([
      prisma.video.findUniqueOrThrow({
        where: { id: long.videoId },
        include: { script: { include: { activeVersion: true } } },
      }),
      prisma.video.findUniqueOrThrow({
        where: { id: short.videoId },
        include: { script: { include: { activeVersion: true } } },
      }),
    ]);

    // Different shape...
    expect(longVideo.format).toBe("LANDSCAPE");
    expect(shortVideo.format).toBe("VERTICAL");

    // ...different script style...
    expect(longVideo.script?.activeVersion?.prompt).toContain("long explainer");
    expect(shortVideo.script?.activeVersion?.prompt).toContain("45-second tip");

    // ...different show...
    expect(longVideo.seriesId).toBe(deepDive.id);
    expect(shortVideo.seriesId).toBe(quickTips.id);

    // ...and the same channel, whose brand both inherit. That is the deliberate
    // limit of the feature: a series varies how an episode is written and
    // shaped, never how the channel looks or sounds.
    const summaries = await series.list(userId);
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries.map((show) => show.channelId))).toEqual(
      new Set([channelId]),
    );
    expect(summaries.map((show) => show.cadence)).not.toEqual([
      summaries[0].cadence,
      summaries[0].cadence,
    ]);
  });

  it("keeps their queues and histories separate", async () => {
    const { series } = makeServices();

    const first = await series.create(
      userId,
      seriesInput({ name: `First ${RUN}`, topics: ["alpha", "beta"] }),
    );
    const second = await series.create(
      userId,
      seriesInput({ name: `Second ${RUN}`, topics: ["gamma"] }),
    );

    await series.generateNow(userId, first.id);

    const [firstDetail, secondDetail] = await Promise.all([
      series.get(userId, first.id),
      series.get(userId, second.id),
    ]);

    expect(firstDetail.queuedTopicCount).toBe(1);
    expect(firstDetail.nextTopic).toBe("beta");
    // The other show is untouched — one series consuming a topic must never
    // reach into another's queue.
    expect(secondDetail.queuedTopicCount).toBe(1);
    expect(secondDetail.nextTopic).toBe("gamma");
    expect(secondDetail.videos).toHaveLength(0);
  });
});

describe("seriesService — the schedule's guarantees are the schedule's", () => {
  it("fires a series' cadence exactly once, even under concurrent ticks", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(
      userId,
      seriesInput({ topics: ["one", "two", "three"] }),
    );

    await makeDue(created.id);

    // The same conditional-update-as-lock the standalone schedule tests
    // exercise. A series changes what a run is configured with, never how the
    // occurrence is claimed.
    const results = await Promise.all([
      schedules.tick(),
      schedules.tick(),
      schedules.tick(),
    ]);

    const produced = results.filter((result) => result?.outcome === "SUCCEEDED");
    expect(produced).toHaveLength(1);

    const scheduleId = (await series.get(userId, created.id)).scheduleId;
    const runs = await prisma.scheduleRun.findMany({ where: { scheduleId } });
    expect(runs).toHaveLength(1);

    const consumed = await prisma.scheduleTopic.count({
      where: { scheduleId, consumedAt: { not: null } },
    });
    expect(consumed).toBe(1);
  });

  it("does not burst after downtime — three missed weeks make one video", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(
      userId,
      seriesInput({ topics: ["one", "two", "three", "four"] }),
    );

    // Due three weeks ago. `advancePast` steps over the missed occurrences and
    // records them rather than producing them late.
    await makeDue(created.id, new Date(Date.now() - 21 * 24 * 60 * 60 * 1000));

    const result = await schedules.tick();
    expect(result?.outcome).toBe("SUCCEEDED");

    const detail = await series.get(userId, created.id);
    const outcomes = detail.runs.map((run) => run.outcome);

    expect(outcomes.filter((outcome) => outcome === "SUCCEEDED")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "MISSED").length).toBeGreaterThan(0);
    expect(detail.queuedTopicCount).toBe(3);
    expect(detail.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses a series only after three runs in a row fail", async () => {
    const { series, schedules } = makeServices(
      fakeProvider({ fail: new Error("Anthropic is unreachable") }),
    );

    const created = await series.create(
      userId,
      seriesInput({ topics: ["one", "two", "three", "four"] }),
    );

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await makeDue(created.id);
      await schedules.tick();

      const detail = await series.get(userId, created.id);
      expect(detail.status, `after ${attempt} failure(s)`).toBe("ACTIVE");
      expect(detail.consecutiveFailures).toBe(attempt);
    }

    await makeDue(created.id);
    await schedules.tick();

    const detail = await series.get(userId, created.id);
    expect(detail.status).toBe("PAUSED");
    expect(detail.pausedReason).toContain("3 runs in a row failed");
  });

  it("pauses itself rather than inventing a topic when the queue runs dry", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(userId, seriesInput({ topics: ["only one"] }));

    await makeDue(created.id);
    await schedules.tick();

    await makeDue(created.id);
    const second = await schedules.tick();

    expect(second?.outcome).toBe("SKIPPED");
    expect(second?.reason).toContain("Nothing here invents a subject");

    const detail = await series.get(userId, created.id);
    expect(detail.status).toBe("PAUSED");
  });

  it("refuses an on-demand run into an empty queue rather than improvising", async () => {
    const { series } = makeServices();
    const created = await series.create(userId, seriesInput({ topics: ["only one"] }));

    await series.generateNow(userId, created.id);

    await expect(series.generateNow(userId, created.id)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // And nothing was made for the refused request.
    const detail = await series.get(userId, created.id);
    expect(detail.videos).toHaveLength(1);
  });

  it("refuses to edit or delete a series' cadence from the standalone schedule surface", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(userId, seriesInput());
    const { scheduleId } = await series.get(userId, created.id);

    await expect(
      schedules.update(userId, scheduleId, {
        name: "hijacked",
        projectId,
        ...CADENCE,
        ...NO_AUTO_PUBLISH,
        variables: {},
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(schedules.remove(userId, scheduleId)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // Pausing is deliberately still allowed from either surface: it means the
    // same thing whoever presses it, and it is the button an operator reaches
    // for when they want spending to stop now.
    await schedules.pause(userId, scheduleId, "stop");
    expect((await series.get(userId, created.id)).status).toBe("PAUSED");
  });
});

describe("seriesService — a series never publishes", () => {
  it("stops at a queued video, with no Publication and no PUBLISHED transition", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(userId, seriesInput({ topics: ["one", "two"] }));

    const manual = await series.generateNow(userId, created.id);

    await makeDue(created.id);
    const tick = await schedules.tick();

    const videoIds = [manual.videoId, tick!.videoId!];

    for (const videoId of videoIds) {
      await expectGate1Crossed(videoId);

      expect(await prisma.publication.count({ where: { videoId } })).toBe(0);
      expect(
        await prisma.videoStatusEvent.count({ where: { videoId, to: "PUBLISHED" } }),
      ).toBe(0);
    }

    // Gate 2 belongs to nobody in this feature — not to the operator's button
    // press here, and not to the worker's tick.
    expect(await prisma.publication.count({ where: { video: { userId } } })).toBe(0);
  });
});

describe("seriesService — every query is scoped to the signed-in operator", () => {
  it("does not return, run, edit, pause or delete another operator's series", async () => {
    const { series } = makeServices();
    const created = await series.create(userId, seriesInput());
    const otherUserId = await createTestUser("series-other");

    try {
      await expect(series.get(otherUserId, created.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(series.generateNow(otherUserId, created.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(series.pause(otherUserId, created.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(series.remove(otherUserId, created.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        series.update(otherUserId, created.id, seriesInput()),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Nothing leaked through: the show is untouched and still has its topic.
      const detail = await series.get(userId, created.id);
      expect(detail.status).toBe("ACTIVE");
      expect(detail.queuedTopicCount).toBe(1);
      expect(detail.videos).toHaveLength(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("lists only the signed-in operator's series", async () => {
    const { series } = makeServices();
    await series.create(userId, seriesInput());
    const otherUserId = await createTestUser("series-other-list");

    try {
      expect(await series.list(otherUserId)).toEqual([]);
      expect(await series.list(userId)).toHaveLength(1);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });

  it("refuses a channel, project or script style belonging to somebody else", async () => {
    const { series } = makeServices();
    const otherUserId = await createTestUser("series-other-recipe");

    try {
      const other = await makeReadyAccount(otherUserId);
      const otherStyleId = await makeStyle(
        otherUserId,
        `Foreign style ${RUN}`,
        DEEP_DIVE_CONTENT,
        [{ key: "topic", label: "Topic", required: true }],
        true,
      );

      await expect(
        series.create(userId, seriesInput({ channelId: other.channelId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        series.create(userId, seriesInput({ projectId: other.projectId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        series.create(userId, seriesInput({ promptTemplateId: otherStyleId })),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await prisma.series.count({ where: { userId } })).toBe(0);
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("seriesService — the recipe has to be coherent before it is saved", () => {
  it("refuses a project that publishes to a different channel than the series names", async () => {
    const { series } = makeServices();

    const strayProject = await projectService.create(userId, {
      name: `Stray ${RUN}`,
    });

    await expect(
      series.create(userId, seriesInput({ projectId: strayProject.id })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a required prompt variable with no answer, before anything is written", async () => {
    const { series } = makeServices();

    await expect(
      series.create(userId, seriesInput({ variables: { tone: "measured" } })),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.series.count({ where: { userId } })).toBe(0);
    expect(await prisma.schedule.count({ where: { userId } })).toBe(0);
  });

  it("refuses to delete a script style a series is written with", async () => {
    const { series } = makeServices();
    await series.create(userId, seriesInput());

    await expect(
      promptTemplateService.remove(userId, deepDiveStyleId),
    ).rejects.toBeInstanceOf(ConflictError);

    // The other style is not in use and deletes normally.
    await promptTemplateService.remove(userId, quickTipsStyleId);
  });

  it("retires the cadence with the series, and leaves its videos alone", async () => {
    const { series, schedules } = makeServices();
    const created = await series.create(userId, seriesInput());
    const run = await series.generateNow(userId, created.id);
    const { scheduleId } = await series.get(userId, created.id);

    await series.remove(userId, created.id);

    expect(await series.list(userId)).toEqual([]);

    const schedule = await prisma.schedule.findUniqueOrThrow({
      where: { id: scheduleId },
    });
    expect(schedule.deletedAt).not.toBeNull();
    expect(schedule.nextRunAt).toBeNull();

    // A retired show is never due again...
    await makeDue(created.id);
    expect(await schedules.claimDue()).toBeNull();

    // ...and the episodes it already made are untouched.
    const video = await prisma.video.findUniqueOrThrow({ where: { id: run.videoId } });
    expect(video.deletedAt).toBeNull();
  });
});

describe("a deployment with no series behaves exactly as it did before", () => {
  it("runs a standalone schedule with no series attached, unchanged", async () => {
    const { schedules } = makeServices();

    const schedule = await schedules.create(userId, {
      name: `Standalone ${RUN}`,
      projectId,
      ...CADENCE,
      ...NO_AUTO_PUBLISH,
      variables: { audience: "curious adults" },
      topics: ["a topic nobody made a series for"],
    });

    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: new Date(Date.now() - 60_000) },
    });

    const result = await schedules.tick();

    expect(result?.outcome).toBe("SUCCEEDED");

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result!.videoId! },
      include: { script: { include: { activeVersion: true } } },
    });

    // No series: the default script style writes it, LANDSCAPE is the shape,
    // and nothing is attributed to a show. Byte for byte the behaviour that
    // existed before this feature.
    expect(video.seriesId).toBeNull();
    expect(video.format).toBe("LANDSCAPE");
    expect(video.script?.activeVersion?.prompt).toContain("long explainer");

    // And it is still editable and deletable from the standalone surface,
    // because the ownership guard only fires for a cadence a series owns.
    await schedules.update(userId, schedule.id, {
      name: `Renamed ${RUN}`,
      projectId,
      ...CADENCE,
      ...NO_AUTO_PUBLISH,
      variables: { audience: "curious adults" },
    });
    await schedules.remove(userId, schedule.id);
  });

  it("reports no series on an account that has never made one", async () => {
    const { series } = makeServices();

    expect(await series.list(userId)).toEqual([]);
    expect(await prisma.video.count({ where: { userId, seriesId: { not: null } } })).toBe(
      0,
    );
  });
});

/**
 * The two copies of "which channel", and what happens when they disagree.
 *
 * A series stores its own `channelId` and every series screen reads it, while
 * an upload goes to `project.channelId`. They are written to agree
 * (`assertRecipe`, below) and kept that way (`ProjectService.update`), but rows
 * predating both exist — one was found on staging, a children's show whose
 * project still pointed at a personal finance channel. This is the reporting
 * half: a mismatch that cannot be corrected automatically has to at least be
 * impossible to miss.
 */
describe("seriesService — the two channels have to agree, and say so when they do not", () => {
  it("refuses a project that belongs to a different channel, not merely one with none", async () => {
    const { series } = makeServices();

    const otherChannel = await channelService.connect(userId, {
      youtubeChannelId: `UC_other_${RUN}_${randomUUID().slice(0, 8)}`,
      title: "KIDO FUN ZONE",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });

    const otherProject = await projectService.create(userId, {
      name: `Other ${RUN}`,
      channelId: otherChannel.id,
    });

    // The series names `channelId` (Money Mechanics) while filing its episodes
    // in a project that publishes to KIDO FUN ZONE — the exact shape of the row
    // found in production, refused at the point it would be created.
    await expect(
      series.create(userId, seriesInput({ projectId: otherProject.id })),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.series.count({ where: { userId } })).toBe(0);
    expect(await prisma.schedule.count({ where: { userId } })).toBe(0);

    // The other direction is refused too: naming the project's channel while
    // filing in the project that publishes elsewhere.
    await expect(
      series.create(userId, seriesInput({ channelId: otherChannel.id })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("reports a mismatch it inherited rather than describing the row as healthy", async () => {
    const { series } = makeServices();
    const { id } = await series.create(userId, seriesInput());

    // Written straight to Prisma because every service path now refuses it —
    // which is the point. This is what a row that predates the guards looks
    // like, and the read model has to be honest about it.
    const strayChannel = await channelService.connect(userId, {
      youtubeChannelId: `UC_stray_${RUN}_${randomUUID().slice(0, 8)}`,
      title: "KIDO FUN ZONE",
      accessToken: "ya29.test",
      refreshToken: "1//test",
      expiresInSeconds: 3600,
      scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { channelId: strayChannel.id },
    });

    const detail = await series.get(userId, id);

    expect(detail.channelMismatch).toEqual({
      // What the page has been showing all along…
      seriesChannelTitle: "Money Mechanics",
      // …and where a publish would actually have gone.
      projectChannelTitle: "KIDO FUN ZONE",
    });

    // The list says so as well: the automation table is where an operator with
    // several shows would notice it first.
    const listed = (await series.list(userId)).find((row) => row.id === id);
    expect(listed?.channelMismatch).not.toBeNull();
  });

  it("says nothing at all about a series whose two channels agree", async () => {
    const { series } = makeServices();
    const { id } = await series.create(userId, seriesInput());

    expect((await series.get(userId, id)).channelMismatch).toBeNull();
    expect((await series.list(userId))[0]?.channelMismatch).toBeNull();
  });
});
