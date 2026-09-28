import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { buildSubjectPrompt, type ReachEvidence } from "@/lib/subject-prompt";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import {
  readReachEvidence,
  REFILL_BATCH,
  REFILL_THRESHOLD,
  TopicQueueService,
} from "@/services/topic-queue.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same discipline as every other service test here: a real, shared Postgres that
// also holds the operator's real data, so every test gets its own throwaway User
// (src/test/fixtures.ts) and never touches a real project or credential.
//
// ProviderUsage is the table that escapes that cascade — the rows this service
// writes carry no `userId` of their own — so this run's rows are tagged through
// the fake provider's `model` string and swept by it.
const RUN = randomUUID().slice(0, 8);
const FAKE_MODEL = `test-topics-model-${RUN}`;

// A refill is a count, a lease, a context read, a brand resolve, two analytics
// reads, an avoid-list, a createMany and three bookkeeping writes — a couple of
// dozen sequential round trips to a remote database, and the concurrency test
// does it twice at once.
vi.setConfig({ testTimeout: 40_000 });

let userId: string;
let channelId: string;
let projectId: string;

/**
 * A provider that answers with `count` distinct subjects, or with whatever it is
 * told to.
 *
 * Records the prompt it was sent, because half of what this feature is *for* is
 * what goes into that string — the reach rule, the winners, the avoid-list — and
 * a test that only checked the rows written would pass while sending the model
 * nothing at all about reach.
 */
function fakeProvider(options?: { answer?: string[] | string; fail?: Error }) {
  const prompts: string[] = [];

  const generateScript = vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt);

    if (options?.fail) {
      throw options.fail;
    }

    const answer =
      options?.answer ??
      Array.from({ length: REFILL_BATCH }, (_, index) => `subject number ${index + 1}`);

    return {
      content: typeof answer === "string" ? answer : JSON.stringify(answer),
      model: FAKE_MODEL,
      provider: "ANTHROPIC" as const,
      inputTokens: 220,
      outputTokens: 180,
      costUsd: 0.0041,
      latencyMs: 900,
    };
  });

  return { provider: { generateScript } as Pick<TextGenerationProvider, "generateScript">, prompts, generateScript };
}

async function cleanupProviderUsage(): Promise<void> {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
}

/** A schedule with `topics` waiting, and nothing else remarkable about it. */
async function makeSchedule(topics: string[], name = `Weekly ${RUN}`): Promise<string> {
  const schedule = await prisma.schedule.create({
    data: {
      userId,
      projectId,
      name,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timeZone: "UTC",
      variables: {},
      nextRunAt: new Date(Date.now() + 60_000),
      topics: { create: topics.map((topic, index) => ({ position: index, topic })) },
    },
    select: { id: true },
  });

  return schedule.id;
}

async function queuedTopics(scheduleId: string) {
  return prisma.scheduleTopic.findMany({
    where: { scheduleId, consumedAt: null },
    orderBy: { position: "asc" },
    select: { topic: true, position: true, generated: true },
  });
}

/**
 * A published video on this channel with `days` of figures behind it.
 *
 * Written through raw rows rather than through the publish path, deliberately:
 * these tests are about how the *figures* are read, and going through
 * `PublishService` would mean an upload fixture, an OAuth grant and a rendered
 * file to assert something about an ORDER BY.
 */
async function makePublishedVideo(options: {
  title: string;
  views: number;
  retention: number;
}): Promise<void> {
  const video = await prisma.video.create({
    data: {
      userId,
      projectId,
      title: options.title,
      topic: options.title,
      status: "PUBLISHED",
    },
    select: { id: true },
  });

  const publication = await prisma.publication.create({
    data: {
      videoId: video.id,
      channelId,
      title: options.title,
      status: "PUBLISHED",
      youtubeVideoId: `yt_${randomUUID().slice(0, 8)}`,
      publishedAt: new Date(),
    },
    select: { id: true },
  });

  await prisma.videoAnalytic.create({
    data: {
      publicationId: publication.id,
      views: BigInt(options.views),
      averageViewPercent: options.retention,
      capturedFor: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });
}

beforeEach(async () => {
  await cleanupProviderUsage();
  userId = await createTestUser("topics");

  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_topics_${RUN}_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  channelId = channel.id;

  const project = await projectService.create(userId, {
    name: `Topics ${RUN}`,
    channelId,
  });

  projectId = project.id;

  await prisma.promptTemplate.create({
    data: {
      userId,
      name: `Deep dive ${RUN}`,
      category: "SCRIPT",
      content: "Write a script about {{topic}}.",
      isDefault: true,
    },
  });

  // The real credential lookup would return null for this throwaway user anyway.
  // Stubbed only to keep a round trip off the critical path of every assertion.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupProviderUsage();
  await deleteTestUser(userId);
});

afterAll(cleanupProviderUsage);

describe("topicQueueService — the threshold decides whether anything is spent", () => {
  it("refills when fewer than three topics are waiting", async () => {
    const scheduleId = await makeSchedule(["one thing", "another thing"]);
    const { provider, generateScript } = fakeProvider();

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome.status).toBe("filled");
    expect(generateScript).toHaveBeenCalledTimes(1);

    const topics = await queuedTopics(scheduleId);

    // The two the operator wrote are still at the head, in their order. A refill
    // that reordered the queue would change what the next video is about.
    expect(topics.slice(0, 2).map((topic) => topic.topic)).toEqual([
      "one thing",
      "another thing",
    ]);
    expect(topics).toHaveLength(2 + REFILL_BATCH);
    expect(topics.slice(2).every((topic) => topic.generated)).toBe(true);
    expect(topics.slice(0, 2).every((topic) => topic.generated)).toBe(false);
  });

  it("spends nothing when the queue is at the threshold", async () => {
    const scheduleId = await makeSchedule(["a", "b", "c"].map((letter) => `topic ${letter}`));
    const { provider, generateScript } = fakeProvider();

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome).toEqual({ status: "not-needed", queued: REFILL_THRESHOLD });
    expect(generateScript).not.toHaveBeenCalled();
    expect(await queuedTopics(scheduleId)).toHaveLength(3);
  });

  it("spends nothing on a comfortable queue", async () => {
    const scheduleId = await makeSchedule(
      Array.from({ length: 9 }, (_, index) => `topic ${index}`),
    );
    const { provider, generateScript } = fakeProvider();

    expect((await new TopicQueueService(provider).refill(scheduleId)).status).toBe(
      "not-needed",
    );
    expect(generateScript).not.toHaveBeenCalled();
  });

  it("counts only unconsumed topics, so a long history does not look like a full queue", async () => {
    const scheduleId = await makeSchedule([]);

    // Twelve topics, all already made. The queue is empty; a count that forgot
    // `consumedAt` would read this as the fullest queue on the deployment.
    await prisma.scheduleTopic.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        scheduleId,
        position: index,
        topic: `spent topic ${index}`,
        consumedAt: new Date(),
      })),
    });

    const { provider } = fakeProvider();
    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome.status).toBe("filled");

    // Appended after the highest stored position, not after the unconsumed count.
    const appended = await queuedTopics(scheduleId);
    expect(appended[0]?.position).toBe(12);
  });

  it("never lets two workers fill the same queue twice", async () => {
    const scheduleId = await makeSchedule(["only one left"]);
    const first = fakeProvider();
    const second = fakeProvider();

    const [a, b] = await Promise.all([
      new TopicQueueService(first.provider).refill(scheduleId),
      new TopicQueueService(second.provider).refill(scheduleId),
    ]);

    const statuses = [a.status, b.status].sort();

    // One filled; the other found the lease held and withdrew without spending.
    // A lost race here costs a wasted model call and twenty topics in an order
    // nobody chose, which is why the loser does nothing at all.
    expect(statuses).toEqual(["busy", "filled"]);
    expect(first.generateScript.mock.calls.length + second.generateScript.mock.calls.length).toBe(1);
    expect(await queuedTopics(scheduleId)).toHaveLength(1 + REFILL_BATCH);
  });

  it("releases the lease so the next refill is not locked out", async () => {
    const scheduleId = await makeSchedule(["one"]);
    await new TopicQueueService(fakeProvider().provider).refill(scheduleId);

    const row = await prisma.schedule.findUniqueOrThrow({
      where: { id: scheduleId },
      select: { topicRefillLeaseExpiresAt: true, topicRefillFailures: true },
    });

    expect(row.topicRefillLeaseExpiresAt).toBeNull();
    expect(row.topicRefillFailures).toBe(0);
  });
});

describe("topicQueueService — a subject is never suggested twice", () => {
  it("excludes what is queued, what was already used, and the channel's own videos", async () => {
    const scheduleId = await makeSchedule(["how tolls took over the roads"]);

    await prisma.scheduleTopic.create({
      data: {
        scheduleId,
        position: 50,
        topic: "the day the gold standard ended",
        consumedAt: new Date(),
      },
    });

    await makePublishedVideo({
      title: "Why Marcus Aurelius kept a diary",
      views: 40_000,
      retention: 52,
    });

    // Every one of the four is something this channel has covered or is about to.
    // The model is told not to repeat them, and then checked anyway.
    const { provider, prompts } = fakeProvider({
      answer: [
        "How tolls took over the roads.",
        "the DAY the gold standard ended",
        "why marcus aurelius kept a diary",
        "what the Suez Canal did to sailing times",
      ],
    });

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome).toMatchObject({
      status: "filled",
      added: ["what the Suez Canal did to sailing times"],
    });

    // And the avoid-list really was sent, rather than the dedupe quietly doing
    // all the work after a full-price call that was never told anything.
    expect(prompts[0]).toContain("Do not suggest any of these");
    expect(prompts[0]).toContain("how tolls took over the roads");
    expect(prompts[0]).toContain("Why Marcus Aurelius kept a diary");
  });

  it("drops a subject the model repeated within one answer", async () => {
    const scheduleId = await makeSchedule([]);
    const { provider } = fakeProvider({
      answer: [
        "how index funds took over the market",
        "How index funds took over the market!",
        "why the Dutch tulip crash still gets cited",
      ],
    });

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome).toMatchObject({
      status: "filled",
      added: [
        "how index funds took over the market",
        "why the Dutch tulip crash still gets cited",
      ],
    });
  });
});

describe("readReachEvidence — ranking against the channel's own figures", () => {
  it("names the best performers as winners and the worst as losers", async () => {
    await makePublishedVideo({ title: "Marcus Aurelius", views: 40_000, retention: 55 });
    await makePublishedVideo({ title: "The Berlin conference", views: 32_000, retention: 51 });
    await makePublishedVideo({ title: "Zheng He", views: 900, retention: 44 });
    await makePublishedVideo({ title: "The Aztecs", views: 600, retention: 41 });

    const evidence = await readReachEvidence(channelId);

    expect(evidence.source).toBe("analytics");
    expect(evidence.winners).toEqual(["Marcus Aurelius", "The Berlin conference"]);
    // Worst first, so truncating the list keeps the clearest examples.
    expect(evidence.losers).toEqual(["The Aztecs", "Zheng He"]);
  });

  it("keeps a high-view, low-retention video out of the winners", async () => {
    // The trap this channel's own pattern sets: a famous name pulls the click
    // whether or not there is a video behind it. Copying that subject teaches the
    // model the wrong lesson — the title worked, the video did not.
    await makePublishedVideo({ title: "Clicked and abandoned", views: 90_000, retention: 3 });
    await makePublishedVideo({ title: "Marcus Aurelius", views: 40_000, retention: 58 });
    await makePublishedVideo({ title: "The Berlin conference", views: 30_000, retention: 54 });
    await makePublishedVideo({ title: "Zheng He", views: 900, retention: 47 });
    await makePublishedVideo({ title: "The Aztecs", views: 600, retention: 45 });

    const evidence = await readReachEvidence(channelId);

    expect(evidence.winners).not.toContain("Clicked and abandoned");
    expect(evidence.winners[0]).toBe("Marcus Aurelius");
  });

  it("falls back to settings rather than calling three videos a pattern", async () => {
    await makePublishedVideo({ title: "Only one measured", views: 5_000, retention: 50 });

    expect(await readReachEvidence(channelId)).toEqual({
      winners: [],
      losers: [],
      source: "settings",
    });
  });

  it("falls back to settings for a project with no channel at all", async () => {
    expect(await readReachEvidence(null)).toEqual({
      winners: [],
      losers: [],
      source: "settings",
    });
  });

  it("feeds the winners into the prompt as 'more like these'", async () => {
    await makePublishedVideo({ title: "Marcus Aurelius", views: 40_000, retention: 55 });
    await makePublishedVideo({ title: "The Berlin conference", views: 32_000, retention: 51 });
    await makePublishedVideo({ title: "Zheng He", views: 900, retention: 44 });
    await makePublishedVideo({ title: "The Aztecs", views: 600, retention: 41 });

    const scheduleId = await makeSchedule([]);
    const { provider, prompts } = fakeProvider();

    await new TopicQueueService(provider).refill(scheduleId);

    const prompt = prompts[0] ?? "";

    expect(prompt).toContain("These did best on this channel");
    expect(prompt).toContain("- Marcus Aurelius");
    expect(prompt).toContain("These did worst");
    expect(prompt).toContain("- The Aztecs");
    // The rule itself, not just the evidence. Without it the model has two lists
    // and no idea what they are lists of.
    expect(prompt).toContain("FOUR TIMES the views");
  });

  it("says so in the prompt when the channel has no figures of its own", async () => {
    const scheduleId = await makeSchedule([]);
    const { provider, prompts } = fakeProvider();

    await new TopicQueueService(provider).refill(scheduleId);

    expect(prompts[0]).toContain("no published figures yet");
    expect(prompts[0]).toContain("FOUR TIMES the views");
  });
});

describe("buildSubjectPrompt — what the two callers do and do not share", () => {
  const reach: ReachEvidence = {
    winners: ["Marcus Aurelius"],
    losers: ["Zheng He"],
    source: "analytics",
  };

  const base = {
    count: 6,
    niche: "personal finance",
    tone: "clear and factual",
    styleName: "Deep dive",
    avoid: [] as string[],
  };

  it("leaves the reach rule out entirely for the picker", () => {
    // Easy mode offers subjects to somebody who will judge them, and its prompt
    // must be the one it has always sent. A reach paragraph appearing there
    // silently would be this change altering a feature it was not asked to touch.
    const prompt = buildSubjectPrompt(base);

    expect(prompt).not.toContain("FOUR TIMES");
    expect(prompt).not.toContain("Order them strongest first");
    expect(prompt).toContain("Each entry is a SUBJECT, not a title");
  });

  it("asks for an ordering only when the answer is going into a queue", () => {
    // The queue consumes in the order given, so position in the answer is
    // position in the schedule. A picker shows all six at once.
    expect(buildSubjectPrompt({ ...base, reach })).toContain(
      "Order them strongest first",
    );
  });

  it("caps the avoid-list so a long back catalogue cannot bury the instructions", () => {
    const avoid = Array.from({ length: 120 }, (_, index) => `covered subject ${index}`);
    const prompt = buildSubjectPrompt({ ...base, avoid });

    expect(prompt).toContain("covered subject 0");
    expect(prompt).not.toContain("covered subject 41");
  });
});

describe("topicQueueService — failure is recorded, backed off, and never thrown", () => {
  it("reports a provider failure as an outcome rather than an exception", async () => {
    const scheduleId = await makeSchedule(["one left"]);
    const { provider } = fakeProvider({ fail: new Error("Anthropic rejected the key") });

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome).toMatchObject({
      status: "failed",
      error: "Anthropic rejected the key",
      failures: 1,
    });

    // The one topic the operator wrote is untouched. A failed refill must not be
    // able to damage a queue.
    expect(await queuedTopics(scheduleId)).toHaveLength(1);
  });

  it("treats an unusable answer as a failure rather than as an empty queue", async () => {
    const scheduleId = await makeSchedule([]);
    const { provider } = fakeProvider({ answer: "[]" });

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome.status).toBe("failed");
    expect(await queuedTopics(scheduleId)).toHaveLength(0);
  });

  it("refuses to queue the model's own chatter as a video subject", async () => {
    // The shared parser is tolerantly line-based — a bulleted list instead of JSON
    // is not worth throwing a paid call away over — and the price of that is that
    // prose passes every length bound. In easy mode's picker that is one silly
    // option among six that nobody taps. Here nobody reads the list at all before
    // a run takes the head of it, so this line would become a narrated, rendered
    // video on a real channel.
    const scheduleId = await makeSchedule([]);
    const { provider } = fakeProvider({
      answer:
        "Sure! Here are some ideas:\n" +
        "why the Bank of England was nationalised\n" +
        "I hope these help!",
    });

    const outcome = await new TopicQueueService(provider).refill(scheduleId);

    expect(outcome).toMatchObject({
      status: "filled",
      added: ["why the Bank of England was nationalised"],
    });
  });

  it("fails rather than queueing anything when the whole answer is chatter", async () => {
    const scheduleId = await makeSchedule([]);
    const { provider } = fakeProvider({
      answer: "I'd be happy to help with that! Sorry, I need more context.",
    });

    expect((await new TopicQueueService(provider).refill(scheduleId)).status).toBe(
      "failed",
    );
    expect(await queuedTopics(scheduleId)).toHaveLength(0);
  });

  it("backs the next attempt off, and the run path ignores that backoff", async () => {
    const scheduleId = await makeSchedule([]);
    const failing = fakeProvider({ fail: new Error("rate limited") });
    const service = new TopicQueueService(failing.provider);

    await service.refill(scheduleId);

    const row = await prisma.schedule.findUniqueOrThrow({
      where: { id: scheduleId },
      select: { topicRefillFailures: true, topicRefillNextAttemptAt: true },
    });

    expect(row.topicRefillFailures).toBe(1);
    expect(row.topicRefillNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // The idle tick respects it — otherwise a dead provider is a call every ten
    // seconds for as long as the worker is quiet.
    expect((await service.refill(scheduleId)).status).toBe("deferred");
    expect(failing.generateScript).toHaveBeenCalledTimes(1);

    // A run that is genuinely due does not. The backoff exists to stop the idle
    // tick hammering a dead provider, not to cost the operator a Monday.
    const working = fakeProvider();
    const forced = await new TopicQueueService(working.provider).refill(scheduleId, {
      ignoreBackoff: true,
    });

    expect(forced.status).toBe("filled");
  });

  it("clears the failure count and the backoff once a refill works", async () => {
    const scheduleId = await makeSchedule([]);
    await new TopicQueueService(fakeProvider({ fail: new Error("down") }).provider).refill(
      scheduleId,
    );
    await new TopicQueueService(fakeProvider().provider).refill(scheduleId, {
      ignoreBackoff: true,
    });

    expect(
      await prisma.schedule.findUniqueOrThrow({
        where: { id: scheduleId },
        select: { topicRefillFailures: true, topicRefillNextAttemptAt: true },
      }),
    ).toEqual({ topicRefillFailures: 0, topicRefillNextAttemptAt: null });
  });
});

describe("topicQueueService — what it writes down", () => {
  it("names the topics it added in an ActivityLog row, not just how many", async () => {
    const scheduleId = await makeSchedule([], `Money Mechanics weekly ${RUN}`);
    const { provider } = fakeProvider({ answer: ["what a bond actually is"] });

    await new TopicQueueService(provider).refill(scheduleId);

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { userId, action: "schedule.topics.refill" },
    });

    expect(log.level).toBe("INFO");
    expect(log.entityType).toBe("Schedule");
    expect(log.entityId).toBe(scheduleId);
    // The list, not the count: "10 topics added" is a number the operator cannot
    // check, and these become videos on their channel.
    expect(log.message).toContain("what a bond actually is");
    expect(log.message).toContain(`Money Mechanics weekly ${RUN}`);
  });

  it("bills the model call to the cost dashboard", async () => {
    const scheduleId = await makeSchedule([]);

    await new TopicQueueService(fakeProvider().provider).refill(scheduleId);

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: { model: FAKE_MODEL },
    });

    expect(usage.operation).toBe("topic.refill");
    expect(usage.succeeded).toBe(true);
    expect(usage.inputTokens).toBe(220);
    expect(Number(usage.costUsd)).toBeCloseTo(0.0041, 6);
  });

  it("records a call that resolved and then produced nothing usable as real spend", async () => {
    // The provider was paid. Recording this as free would make real money
    // invisible on the cost page, which is the one thing that page exists for.
    const scheduleId = await makeSchedule([]);

    await new TopicQueueService(fakeProvider({ answer: "[]" }).provider).refill(
      scheduleId,
    );

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: { model: FAKE_MODEL },
    });

    expect(usage.succeeded).toBe(false);
    expect(usage.inputTokens).toBe(220);
    expect(usage.latencyMs).toBe(900);
  });

  it("records a provider that threw before answering as costing nothing", async () => {
    const scheduleId = await makeSchedule([]);

    await new TopicQueueService(
      fakeProvider({ fail: new Error("connection reset") }).provider,
    ).refill(scheduleId);

    const usage = await prisma.providerUsage.findFirstOrThrow({
      where: { operation: "topic.refill", succeeded: false, model: null },
    });

    expect(usage.inputTokens).toBe(0);
    // Null, not zero: a zero would claim a request that took no time, where null
    // says there was no request.
    expect(usage.latencyMs).toBeNull();

    await prisma.providerUsage.delete({ where: { id: usage.id } });
  });

  it("logs a failure at WARN with the retry interval, naming generation", async () => {
    const scheduleId = await makeSchedule([]);

    await new TopicQueueService(
      fakeProvider({ fail: new Error("gateway budget exhausted") }).provider,
    ).refill(scheduleId);

    const log = await prisma.activityLog.findFirstOrThrow({
      where: { userId, action: "schedule.topics.refill" },
    });

    expect(log.level).toBe("WARN");
    expect(log.message).toContain("gateway budget exhausted");
    expect(log.message).toContain("Retrying in 5 minutes");
  });
});

describe("topicQueueService — the slow tick picks one low queue", () => {
  it("finds a low queue and leaves a healthy one alone", async () => {
    const healthy = await makeSchedule(
      Array.from({ length: 6 }, (_, index) => `full ${index}`),
      `Healthy ${RUN}`,
    );
    const low = await makeSchedule(["nearly out"], `Low ${RUN}`);

    const { provider, generateScript } = fakeProvider();
    const outcome = await new TopicQueueService(provider).tick();

    expect(outcome).toMatchObject({ status: "filled", scheduleId: low });
    expect(generateScript).toHaveBeenCalledTimes(1);
    expect(await queuedTopics(healthy)).toHaveLength(6);
  });

  it("returns null, and spends nothing, when every queue is healthy", async () => {
    await makeSchedule(Array.from({ length: 4 }, (_, index) => `full ${index}`));
    const { provider, generateScript } = fakeProvider();

    expect(await new TopicQueueService(provider).tick()).toBeNull();
    expect(generateScript).not.toHaveBeenCalled();
  });

  it("ignores a paused schedule, which is not going to consume anything", async () => {
    const scheduleId = await makeSchedule([]);
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { status: "PAUSED", pausedReason: "the operator pressed pause" },
    });

    const { provider, generateScript } = fakeProvider();

    expect(await new TopicQueueService(provider).tick()).toBeNull();
    expect(generateScript).not.toHaveBeenCalled();
  });

  it("ignores a deleted schedule", async () => {
    const scheduleId = await makeSchedule([]);
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { deletedAt: new Date() },
    });

    expect(await new TopicQueueService(fakeProvider().provider).tick()).toBeNull();
  });
});
