import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { AutomationService } from "@/services/automation.service";
import { channelService } from "@/services/channel.service";
import { EasyModeService } from "@/services/easy-mode.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScriptService } from "@/services/script.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * Same discipline as automation.service.test.ts, and for the same reason: these
 * run against a real, shared Postgres database that also holds the operator's
 * real data, so every test gets its own throwaway `User` (src/test/fixtures.ts)
 * and never touches a real channel, project, schedule or credential.
 *
 * `ProviderUsage` is the one table that escapes the user cascade, so the run's
 * rows are tagged through the fake provider's `model` string and swept by it.
 */
const RUN = randomUUID().slice(0, 8);
const FAKE_MODEL = `test-easy-model-${RUN}`;

vi.setConfig({ testTimeout: 30_000 });

const SCRIPT = "Money is a claim on other people's work. That is the whole trick.";

/**
 * The prompt these tests derive answers from, chosen to exercise every one of
 * `EasyModeService`'s four sources at once:
 *   - `topic`     — owned by the flow, never asked for and never derived
 *   - `duration`  — a template default, so it is *shown* but not submitted
 *   - `tone`      — answerable from the channel's brand
 *   - `audience`  — derivable from the channel's niche
 */
const PROMPT_CONTENT =
  "Write a {{duration}}-minute script about {{topic}} for {{audience}} in a {{tone}} tone.";

const PROMPT_VARIABLES = [
  { key: "topic", label: "Topic", required: true },
  { key: "duration", label: "Duration (minutes)", defaultValue: "9" },
  { key: "audience", label: "Audience", defaultValue: "curious general viewers" },
  { key: "tone", label: "Tone", defaultValue: "clear, direct and energetic" },
];

function fakeScriptProvider(): Pick<TextGenerationProvider, "generateScript"> {
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

/** A suggester that answers with whatever this test wants the model to have
 *  said, so the parsing and de-duplication are exercised without a paid call. */
function fakeSuggester(
  content: string,
): Pick<TextGenerationProvider, "generateScript"> {
  return {
    generateScript: vi.fn(async () => ({
      content,
      model: FAKE_MODEL,
      provider: "ANTHROPIC" as const,
      inputTokens: 50,
      outputTokens: 80,
      costUsd: 0.0002,
      latencyMs: 300,
    })),
  };
}

/** Real `AutomationService` with only the model call faked, so `start()` under
 *  test exercises the production create/generate/approve sequence. */
function realAutomation(): AutomationService {
  return new AutomationService(new ScriptService(fakeScriptProvider()));
}

/** A recording stand-in, for the tests that are about *what easy mode decided*
 *  rather than about the pipeline it hands the decision to. Typed against
 *  `AutomationService["start"]` so the recorded arguments are the real ones and
 *  a signature change fails here rather than silently loosening the assertion. */
function spyAutomation(): { start: MockedFunction<AutomationService["start"]> } {
  return {
    start: vi.fn(async () => automationResult()) as MockedFunction<
      AutomationService["start"]
    >,
  };
}

function automationResult() {
  return {
    videoId: randomUUID(),
    title: "stub",
    scriptVersion: 1,
    wordCount: 12,
    scriptContent: SCRIPT,
  };
}

async function setDefaultPrompt(
  userId: string,
  variables: {
    key: string;
    label: string;
    defaultValue?: string;
    required?: boolean;
  }[] = PROMPT_VARIABLES,
  content = PROMPT_CONTENT,
): Promise<void> {
  await prisma.promptTemplate.deleteMany({ where: { userId, category: "SCRIPT" } });
  await prisma.promptTemplate.create({
    data: {
      userId,
      name: `Default script ${RUN}`,
      category: "SCRIPT",
      content,
      isDefault: true,
      variables: {
        create: variables.map((variable) => ({
          key: variable.key,
          label: variable.label,
          defaultValue: variable.defaultValue ?? null,
          required: variable.required ?? false,
        })),
      },
    },
  });
}

async function connectChannel(userId: string, title: string): Promise<string> {
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_easy_${RUN}_${randomUUID().slice(0, 8)}`,
    title,
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  return channel.id;
}

async function makeProject(
  userId: string,
  name: string,
  channelId: string | null,
): Promise<string> {
  const project = await prisma.project.create({
    data: { userId, name, channelId },
  });

  return project.id;
}

/** Everything `AutomationService` refuses to run without, so a test that is not
 *  about readiness never trips over it. */
async function makeReadyAccount(userId: string): Promise<void> {
  // A throwaway key on a throwaway user — never the operator's real one.
  await providerCredentialService.upsert(userId, {
    provider: "ELEVENLABS",
    apiKey: `sk-easy-${RUN}`,
    label: RUN,
  });
  await setDefaultPrompt(userId);
}

async function makeSchedule(args: {
  userId: string;
  projectId: string;
  name: string;
  variables?: Record<string, string>;
  topics?: string[];
  nextRunAt?: Date;
}): Promise<string> {
  const schedule = await prisma.schedule.create({
    data: {
      userId: args.userId,
      projectId: args.projectId,
      name: args.name,
      frequency: "WEEKLY",
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timeZone: "Europe/London",
      variables: args.variables ?? {},
      nextRunAt: args.nextRunAt ?? new Date(Date.now() + 86_400_000),
      topics: {
        create: (args.topics ?? []).map((topic, index) => ({
          position: index,
          topic,
        })),
      },
    },
  });

  return schedule.id;
}

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("easy");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

afterAll(async () => {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
});

describe("EasyModeService.getSetup — deriving the project", () => {
  it("picks a project on the chosen channel, never one on another channel", async () => {
    // The invariant `PublishService.resolvePublishTarget` exists to defend:
    // `Project.channelId` decides where a video can ever publish, and a video
    // filed against a project on a different channel is refused or refiled
    // *after* the render has been paid for.
    await makeReadyAccount(userId);
    const finance = await connectChannel(userId, "Money Mechanics");
    const kids = await connectChannel(userId, "Bedtime Stories");

    const financeProject = await makeProject(userId, "Finance", finance);
    const kidsProject = await makeProject(userId, "Kids", kids);

    const setup = await new EasyModeService().getSetup(userId);

    const financeChannel = setup.channels.find((entry) => entry.id === finance);
    const kidsChannel = setup.channels.find((entry) => entry.id === kids);

    expect(financeChannel?.plan?.projectId).toBe(financeProject);
    expect(kidsChannel?.plan?.projectId).toBe(kidsProject);
  });

  it("does not fall back to a more recently touched project on another channel", async () => {
    // The tempting bug: order by `updatedAt` without scoping by channel. The
    // kids project is touched last, so a global "most recent" pick would file a
    // finance video under it.
    await makeReadyAccount(userId);
    const finance = await connectChannel(userId, "Money Mechanics");
    const kids = await connectChannel(userId, "Bedtime Stories");

    const financeProject = await makeProject(userId, "Finance", finance);
    const kidsProject = await makeProject(userId, "Kids", kids);

    await prisma.project.update({
      where: { id: kidsProject },
      data: { name: "Kids (touched last)" },
    });

    const setup = await new EasyModeService().getSetup(userId);

    expect(
      setup.channels.find((entry) => entry.id === finance)?.plan?.projectId,
    ).toBe(financeProject);
  });

  it("ignores an archived project, and reports the channel as unusable", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    const project = await makeProject(userId, "Finance", channel);
    // A project has to exist somewhere or `create-project` blocks the account
    // outright, which is a different state from the one under test.
    await makeProject(userId, "Unfiled", null);

    await prisma.project.update({
      where: { id: project },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    const setup = await new EasyModeService().getSetup(userId);
    const entry = setup.channels.find((one) => one.id === channel);

    expect(entry?.plan).toBeNull();
    expect(entry?.blockedReason).toContain("Money Mechanics");
  });

  it("reports a channel with no project rather than borrowing one", async () => {
    await makeReadyAccount(userId);
    const withProject = await connectChannel(userId, "Money Mechanics");
    const withoutProject = await connectChannel(userId, "Bedtime Stories");
    await makeProject(userId, "Finance", withProject);

    const setup = await new EasyModeService().getSetup(userId);
    const stranded = setup.channels.find((entry) => entry.id === withoutProject);

    expect(stranded?.plan).toBeNull();
    expect(stranded?.blockedReason).toContain("Bedtime Stories");
    // The usable channel is unaffected — one stranded channel must not take the
    // whole screen down with it.
    expect(
      setup.channels.find((entry) => entry.id === withProject)?.plan,
    ).not.toBeNull();
  });
});

describe("EasyModeService.getSetup — a channel with no brand", () => {
  it("runs on the resolver's documented fallbacks and marks them as such", async () => {
    // The state every production channel is in. Refusing would make easy mode
    // work for nobody; guessing a niche from the channel's title would put a
    // value the operator never wrote behind a script they paid for. So the
    // values `brandService.resolve` already hands the rest of the pipeline are
    // used, and marked.
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const setup = await new EasyModeService().getSetup(userId);
    const entry = setup.channels.find((one) => one.id === channel);

    expect(entry?.hasBrand).toBe(false);
    expect(entry?.niche).toBe("general interest");
    expect(entry?.tone).toBe("clear and factual");
    expect(entry?.plan).not.toBeNull();

    const tone = entry?.plan?.answers.find((answer) => answer.label === "Tone");
    const audience = entry?.plan?.answers.find(
      (answer) => answer.label === "Audience",
    );

    expect(tone?.value).toBe("clear and factual");
    expect(tone?.isFallback).toBe(true);
    expect(audience?.value).toBe("viewers interested in general interest");
    expect(audience?.isFallback).toBe(true);
  });

  it("stops marking a fallback once the operator has described the channel", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);
    await prisma.channelBrand.create({
      data: { channelId: channel, niche: "personal finance", tone: "dry and exact" },
    });

    const setup = await new EasyModeService().getSetup(userId);
    const entry = setup.channels.find((one) => one.id === channel);

    expect(entry?.hasBrand).toBe(true);

    const tone = entry?.plan?.answers.find((answer) => answer.label === "Tone");

    expect(tone?.value).toBe("dry and exact");
    expect(tone?.isFallback).toBe(false);
  });

  it("still makes a video for a channel that has never been branded", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const service = new EasyModeService(fakeSuggester("[]"), realAutomation());
    const result = await service.start(userId, {
      channelId: channel,
      topic: "How index funds took over the market",
    });

    expect(result.videoId).toBeTruthy();
    expect(result.scriptContent).toBe(SCRIPT);
  });
});

describe("EasyModeService.getSetup — where the answers come from", () => {
  it("prefers the operator's own schedule answers over the channel's brand", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    const project = await makeProject(userId, "Finance", channel);
    await prisma.channelBrand.create({
      data: { channelId: channel, niche: "personal finance", tone: "dry and exact" },
    });
    await makeSchedule({
      userId,
      projectId: project,
      name: "Weekly finance",
      variables: { tone: "warm and patient", duration: "6" },
    });

    const setup = await new EasyModeService().getSetup(userId);
    const plan = setup.channels.find((one) => one.id === channel)?.plan;

    const tone = plan?.answers.find((answer) => answer.label === "Tone");
    const duration = plan?.answers.find(
      (answer) => answer.label === "Duration (minutes)",
    );

    expect(tone?.value).toBe("warm and patient");
    expect(tone?.source).toContain("Weekly finance");
    // The duration the operator set for this channel's recurring videos, not
    // the prompt's own default of 9.
    expect(duration?.value).toBe("6");
  });

  it("shows a template default without submitting it, so the template stays authoritative", async () => {
    // `renderTemplate` only falls back to a variable's own default when no value
    // is supplied, so copying the default into the submitted map would turn
    // every default into a value the operator appears to have chosen — and would
    // freeze it at whatever it was when the page loaded.
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const automation = spyAutomation();
    await new EasyModeService(fakeSuggester("[]"), automation).start(userId, {
      channelId: channel,
      topic: "How index funds took over the market",
    });

    const submitted = automation.start.mock.calls[0]![1];

    expect(submitted.variables).not.toHaveProperty("duration");
    expect(submitted.variables.tone).toBe("clear and factual");

    const setup = await new EasyModeService().getSetup(userId);
    const plan = setup.channels.find((one) => one.id === channel)?.plan;

    // Absent from the submission, present in the account of what was decided.
    expect(
      plan?.answers.find((answer) => answer.label === "Duration (minutes)")?.value,
    ).toBe("9");
  });

  it("refuses rather than invents when a required question has no answer anywhere", async () => {
    await makeReadyAccount(userId);
    await setDefaultPrompt(userId, [
      { key: "topic", label: "Topic", required: true },
      { key: "sponsor", label: "Sponsor", required: true },
    ], "Write about {{topic}}, sponsored by {{sponsor}}.");

    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const setup = await new EasyModeService().getSetup(userId);
    const plan = setup.channels.find((one) => one.id === channel)?.plan;

    expect(plan?.unanswerable).toEqual(["Sponsor"]);

    const automation = spyAutomation();
    await expect(
      new EasyModeService(fakeSuggester("[]"), automation).start(userId, {
        channelId: channel,
        topic: "How index funds took over the market",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing was spent: the refusal happens before the pipeline is entered.
    expect(automation.start).not.toHaveBeenCalled();
  });
});

describe("EasyModeService — subjects and their provenance", () => {
  it("offers the operator's queued topics, named as theirs and attributed to the schedule", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    const project = await makeProject(userId, "Finance", channel);
    await makeSchedule({
      userId,
      projectId: project,
      name: "Weekly finance",
      topics: ["Why bond yields move house prices", "What a central bank actually does"],
    });

    const subjects = await new EasyModeService().listSubjects(userId, channel);
    const queued = subjects.filter((subject) => subject.origin === "queue");

    expect(queued.map((subject) => subject.topic)).toEqual([
      "Why bond yields move house prices",
      "What a central bank actually does",
    ]);
    // The one rule this surface turns on: a subject the operator did not write
    // must never be indistinguishable from one they did.
    for (const subject of queued) {
      expect(subject.originLabel).toContain("Weekly finance");
    }
  });

  it("marks a shipped starter as shipping with the app, not as the operator's", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const subjects = await new EasyModeService().listSubjects(userId, channel);
    const starters = subjects.filter((subject) => subject.origin === "starter");

    expect(starters.length).toBeGreaterThan(0);
    for (const subject of starters) {
      expect(subject.origin).not.toBe("queue");
      expect(subject.originLabel).toContain("Ships with Framecast");
    }
  });

  it("only offers queued topics belonging to the chosen channel", async () => {
    await makeReadyAccount(userId);
    const finance = await connectChannel(userId, "Money Mechanics");
    const kids = await connectChannel(userId, "Bedtime Stories");
    const financeProject = await makeProject(userId, "Finance", finance);
    const kidsProject = await makeProject(userId, "Kids", kids);

    await makeSchedule({
      userId,
      projectId: financeProject,
      name: "Weekly finance",
      topics: ["Why bond yields move house prices"],
    });
    await makeSchedule({
      userId,
      projectId: kidsProject,
      name: "Bedtime queue",
      topics: ["Counting ducks on the pond"],
    });

    const subjects = await new EasyModeService().listSubjects(userId, finance);
    const queued = subjects.filter((subject) => subject.origin === "queue");

    expect(queued.map((subject) => subject.topic)).toEqual([
      "Why bond yields move house prices",
    ]);
  });

  it("never consumes a schedule's topics — not by listing them, not by making a video from one", async () => {
    // The schedule still owns every row. An operator who makes a video by hand
    // this afternoon must still get the Monday video they asked for, so
    // `consumedAt` is written in exactly one place and it is not here.
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    const project = await makeProject(userId, "Finance", channel);
    const scheduleId = await makeSchedule({
      userId,
      projectId: project,
      name: "Weekly finance",
      topics: ["Why bond yields move house prices", "What a central bank actually does"],
    });

    const service = new EasyModeService(
      fakeSuggester('["Something else entirely"]'),
      realAutomation(),
    );

    const subjects = await service.listSubjects(userId, channel);
    await service.suggest(userId, channel);
    await service.start(userId, {
      channelId: channel,
      topic: subjects.find((subject) => subject.origin === "queue")!.topic,
    });

    const rows = await prisma.scheduleTopic.findMany({
      where: { scheduleId },
      orderBy: { position: "asc" },
      select: { topic: true, consumedAt: true },
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.consumedAt).toBeNull();
    }
  });
});

describe("EasyModeService.suggest", () => {
  it("labels model-written subjects as written by a model, for this channel", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);
    await prisma.channelBrand.create({
      data: { channelId: channel, niche: "personal finance", tone: "dry and exact" },
    });

    const service = new EasyModeService(
      fakeSuggester('["How pension funds quietly own everything", "What an index really is"]'),
    );
    const result = await service.suggest(userId, channel);

    expect(result.error).toBeNull();
    expect(result.subjects).toHaveLength(2);
    for (const subject of result.subjects) {
      expect(subject.origin).toBe("suggested");
      expect(subject.originLabel).toContain("personal finance");
    }
  });

  it("drops a suggestion that repeats something already on offer", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    const project = await makeProject(userId, "Finance", channel);
    await makeSchedule({
      userId,
      projectId: project,
      name: "Weekly finance",
      topics: ["Why bond yields move house prices"],
    });

    const service = new EasyModeService(
      fakeSuggester(
        '["why bond yields move house prices.", "What a central bank actually does"]',
      ),
    );
    const result = await service.suggest(userId, channel);

    expect(result.subjects.map((subject) => subject.topic)).toEqual([
      "What a central bank actually does",
    ]);
  });

  it("reports a provider failure without taking away the free subjects", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const service = new EasyModeService({
      generateScript: vi.fn(async () => {
        throw new Error("Anthropic is unreachable");
      }),
    });

    const result = await service.suggest(userId, channel);

    expect(result.subjects).toEqual([]);
    expect(result.error).toBeTruthy();
    // The picker still has something in it.
    expect(await service.listSubjects(userId, channel)).not.toHaveLength(0);
  });
});

describe("EasyModeService.start", () => {
  it("files the video in a project on the chosen channel", async () => {
    await makeReadyAccount(userId);
    const finance = await connectChannel(userId, "Money Mechanics");
    const kids = await connectChannel(userId, "Bedtime Stories");
    const financeProject = await makeProject(userId, "Finance", finance);
    await makeProject(userId, "Kids", kids);

    const service = new EasyModeService(fakeSuggester("[]"), realAutomation());
    const result = await service.start(userId, {
      channelId: finance,
      topic: "How index funds took over the market",
    });

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result.videoId },
      select: { projectId: true, project: { select: { channelId: true } } },
    });

    expect(video.projectId).toBe(financeProject);
    // The property that matters downstream: whatever project was chosen, it is
    // on the channel the operator picked.
    expect(video.project?.channelId).toBe(finance);
  });

  it("refuses a channel with no project instead of filing the video anywhere", async () => {
    await makeReadyAccount(userId);
    const withProject = await connectChannel(userId, "Money Mechanics");
    const stranded = await connectChannel(userId, "Bedtime Stories");
    await makeProject(userId, "Finance", withProject);

    const automation = spyAutomation();
    const service = new EasyModeService(fakeSuggester("[]"), automation);

    await expect(
      service.start(userId, {
        channelId: stranded,
        topic: "Counting ducks on the pond",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(automation.start).not.toHaveBeenCalled();
  });

  it("refuses a channel that is not this operator's", async () => {
    await makeReadyAccount(userId);
    const mine = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", mine);

    const strangerId = await createTestUser("easy-stranger");

    try {
      const theirs = await connectChannel(strangerId, "Somebody Else");
      await makeProject(strangerId, "Theirs", theirs);

      const automation = spyAutomation();
      await expect(
        new EasyModeService(fakeSuggester("[]"), automation).start(userId, {
          channelId: theirs,
          topic: "How index funds took over the market",
        }),
      ).rejects.toThrow();

      expect(automation.start).not.toHaveBeenCalled();
    } finally {
      await deleteTestUser(strangerId);
    }
  });

  it("crosses Gate 1 and no further — the video is queued, never published", async () => {
    await makeReadyAccount(userId);
    const channel = await connectChannel(userId, "Money Mechanics");
    await makeProject(userId, "Finance", channel);

    const service = new EasyModeService(fakeSuggester("[]"), realAutomation());
    const result = await service.start(userId, {
      channelId: channel,
      topic: "How index funds took over the market",
    });

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result.videoId },
      select: { status: true, publication: { select: { id: true } } },
    });

    expect(video.status).toBe("QUEUED");
    expect(video.publication).toBeNull();

    // The auto-approval is disclosed durably, not only in the toast that
    // reported it — the same row `AutomationService.start` writes for the
    // written form, because it is the same call.
    const disclosure = await prisma.activityLog.findFirst({
      where: {
        userId,
        action: "automation.autoApprove",
        entityType: "Video",
        entityId: result.videoId,
      },
    });

    expect(disclosure).not.toBeNull();
  });
});
