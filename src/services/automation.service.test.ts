import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { AutomationService } from "@/services/automation.service";
import { channelService } from "@/services/channel.service";
import { projectService } from "@/services/project.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScriptService } from "@/services/script.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

// Same discipline as script.service.test.ts: these run against a real, shared
// Postgres database that also holds the operator's real data, so every test
// gets its own throwaway User (src/test/fixtures.ts) and never touches a real
// project, credential or prompt template.
//
// ProviderUsage is the one table that escapes that cascade — the rows
// scriptService.generate writes have no userId of their own — so this run's
// rows are tagged through the fake provider's `model` string and swept by it.
const RUN = randomUUID().slice(0, 8);
const FAKE_MODEL = `test-automation-model-${RUN}`;

// Every test in this file drives the whole flow — readiness checks, a video
// create, a script generation and an approval — which is a dozen sequential
// round trips to a remote database. Vitest's default would fail these for
// latency rather than for being wrong.
vi.setConfig({ testTimeout: 30_000 });

const SCRIPT = "Money is a claim on other people's work. That is the whole trick.";

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

/** The flow always composes a real ScriptService — only the model call itself
 * is faked, so the transaction, versioning and Gate 1 guard under test are the
 * production ones. */
function makeService(
  provider: Pick<TextGenerationProvider, "generateScript"> = fakeProvider(),
): AutomationService {
  return new AutomationService(new ScriptService(provider));
}

/**
 * A default SCRIPT template deliberately containing all four interesting
 * cases at once:
 *   - `topic` — declared, used, and owned by the flow's own topic step
 *   - `duration` — declared and used, surfaced as its own length step
 *   - `audience`/`tone` — declared and used, the actual direction questions
 *   - `season` — declared but never referenced in the content, so answering it
 *     could not change the prompt
 *   - `{{mystery}}` — referenced in the content but declared nowhere, which
 *     renderTemplate deliberately leaves un-substituted
 */
const PROMPT_CONTENT =
  "Write a {{duration}}-minute script about {{topic}} for {{audience}} " +
  "in a {{tone}} tone. {{mystery}}";

async function setDefaultPrompt(
  userId: string,
  content: string,
  variables: {
    key: string;
    label: string;
    defaultValue?: string;
    required?: boolean;
  }[],
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

/** Everything `AutomationService` refuses to run without, so a test that isn't
 * about readiness never trips over it. */
async function makeReadyAccount(userId: string): Promise<string> {
  await channelService.connect(userId, {
    youtubeChannelId: `UC_automation_${RUN}_${randomUUID().slice(0, 8)}`,
    title: "Money Mechanics",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  // A throwaway key on a throwaway user — never the operator's real one.
  await providerCredentialService.upsert(userId, {
    provider: "ELEVENLABS",
    apiKey: `sk-automation-${RUN}`,
    label: RUN,
  });
  await setDefaultPrompt(userId, PROMPT_CONTENT, [
    { key: "topic", label: "Topic", required: true },
    { key: "duration", label: "Duration (minutes)", defaultValue: "8" },
    { key: "audience", label: "Audience", defaultValue: "general viewers" },
    { key: "tone", label: "Tone", defaultValue: "clear and energetic" },
    { key: "season", label: "Season", defaultValue: "spring" },
  ]);

  const project = await projectService.create(userId, { name: `Automation ${RUN}` });

  return project.id;
}

async function cleanupProviderUsage(): Promise<void> {
  await prisma.providerUsage.deleteMany({ where: { model: FAKE_MODEL } });
}

let userId: string;
let projectId: string;

beforeEach(async () => {
  await cleanupProviderUsage();
  userId = await createTestUser("automation");
  projectId = await makeReadyAccount(userId);

  // ScriptService resolves an ANTHROPIC credential before reaching the
  // (injected, fake) provider. This user has none, so this would legitimately
  // return null anyway — stubbed only to keep a real lookup off the critical
  // path of every test here.
  vi.spyOn(providerCredentialService, "resolveKey").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupProviderUsage();
  await deleteTestUser(userId);
});

afterAll(cleanupProviderUsage);

describe("automationService.getSetup — readiness", () => {
  it("reports every missing precondition for a brand-new account, and no prompt", async () => {
    const bareUserId = await createTestUser("automation-bare");

    try {
      const setup = await makeService().getSetup(bareUserId);

      expect(setup.blockers.map((blocker) => blocker.id).sort()).toEqual([
        "add-narration-key",
        "check-prompt-template",
        "connect-channel",
        "create-project",
      ]);
      // Null rather than a throw: the missing template is already one of the
      // blockers above, with a link to the page that fixes it.
      expect(setup.prompt).toBeNull();
      expect(setup.projects).toEqual([]);
    } finally {
      await deleteTestUser(bareUserId);
    }
  });

  it("reports nothing missing once the account is set up", async () => {
    const setup = await makeService().getSetup(userId);

    expect(setup.blockers).toEqual([]);
    expect(setup.projects.map((project) => project.name)).toEqual([`Automation ${RUN}`]);
  });

  it("blocks when every project is archived, even though a project row exists", async () => {
    // The onboarding checklist only asks whether a project row exists, and an
    // archived project satisfies it while taking no new videos. Without this
    // the flow would render with an empty project picker and fail on the final
    // click for a reason it never showed.
    await projectService.archive(userId, projectId);

    const setup = await makeService().getSetup(userId);

    expect(setup.projects).toEqual([]);
    expect(setup.blockers.map((blocker) => blocker.id)).toEqual(["create-project"]);
  });
});

describe("automationService.getSetup — questions come from the operator's own prompt", () => {
  it("asks for exactly the variables the template declares and uses", async () => {
    const setup = await makeService().getSetup(userId);

    expect(setup.prompt?.name).toBe(`Default script ${RUN}`);
    expect(setup.prompt?.fields.map((field) => field.key).sort()).toEqual([
      "audience",
      "tone",
    ]);
  });

  it("never asks for a variable the prompt cannot use", async () => {
    const setup = await makeService().getSetup(userId);
    const keys = [
      ...(setup.prompt?.fields ?? []),
      ...(setup.prompt?.duration ? [setup.prompt.duration] : []),
    ].map((field) => field.key);

    // Declared but never referenced in the content: whatever the operator
    // typed could not change the rendered prompt.
    expect(keys).not.toContain("season");
    // Referenced but declared nowhere: renderTemplate deliberately leaves such
    // a placeholder in the prompt verbatim, so a value for it goes nowhere.
    expect(keys).not.toContain("mystery");
    // Owned by the flow's own topic step, and excluded here specifically so a
    // submitted value can never override the video's stored topic.
    expect(keys).not.toContain("topic");
  });

  it("surfaces duration separately, carrying the template's own label and default", async () => {
    const setup = await makeService().getSetup(userId);

    expect(setup.prompt?.duration).toMatchObject({
      key: "duration",
      label: "Duration (minutes)",
      defaultValue: "8",
    });
  });

  it("has no length step at all when the template declares no duration", async () => {
    await setDefaultPrompt(userId, "Write about {{topic}} for {{audience}}.", [
      { key: "topic", label: "Topic", required: true },
      { key: "audience", label: "Audience", defaultValue: "general viewers" },
    ]);

    const setup = await makeService().getSetup(userId);

    expect(setup.prompt?.duration).toBeNull();
    expect(setup.prompt?.fields.map((field) => field.key)).toEqual(["audience"]);
  });

  it("follows the operator's own edits to their prompt", async () => {
    // The whole point of driving these off PromptVariable rows: adding a
    // variable to the prompt adds a question, with no change here.
    await setDefaultPrompt(
      userId,
      "Write about {{topic}} in a {{format}} format for {{audience}}.",
      [
        { key: "topic", label: "Topic", required: true },
        { key: "format", label: "Format", required: true },
        { key: "audience", label: "Audience", defaultValue: "general viewers" },
      ],
    );

    const setup = await makeService().getSetup(userId);

    expect(setup.prompt?.fields.map((field) => field.key).sort()).toEqual([
      "audience",
      "format",
    ]);
    expect(setup.prompt?.fields.find((field) => field.key === "format")?.required).toBe(
      true,
    );
  });
});

describe("automationService.start — the one-click path", () => {
  it("creates the video, writes the script, and approves it automatically", async () => {
    const result = await makeService().start(userId, {
      projectId,
      topic: "how index funds took over the stock market",
      variables: { tone: "dry and precise" },
    });

    expect(result.scriptVersion).toBe(1);
    expect(result.scriptContent).toBe(SCRIPT);

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result.videoId },
      include: { script: { include: { activeVersion: true } } },
    });

    // Gate 1 crossed without a human: DRAFT -> QUEUED is what makes the video
    // eligible for the paid stages, and nothing here waited for a click.
    expect(video.status).toBe("QUEUED");
    expect(video.topic).toBe("how index funds took over the stock market");
    expect(video.script?.activeVersion?.content).toBe(SCRIPT);
  });

  it("stops at the queue and never publishes", async () => {
    // The line this flow must not cross. A finished render is where it ends;
    // reaching YouTube stays an explicit operator action.
    const result = await makeService().start(userId, {
      projectId,
      topic: "why airlines overbook flights",
      variables: {},
    });

    const video = await prisma.video.findUniqueOrThrow({
      where: { id: result.videoId },
      include: { publication: true },
    });

    expect(video.publication).toBeNull();
    expect(video.status).not.toBe("PUBLISHED");
    expect(
      await prisma.videoStatusEvent.findFirst({
        where: { videoId: result.videoId, to: "PUBLISHED" },
      }),
    ).toBeNull();
  });

  it("records the automatic approval so it is visible after the fact", async () => {
    // videoService.approveScript writes "Script approved by operator", which is
    // true of every other caller and not of this one. The disclosure sits
    // beside it, and pipelineService.getLogStream merges ActivityLog rows into
    // the video's own log by entityType/entityId.
    const result = await makeService().start(userId, {
      projectId,
      topic: "how supermarket loyalty cards actually pay for themselves",
      variables: {},
    });

    const disclosure = await prisma.activityLog.findFirstOrThrow({
      where: {
        userId,
        action: "automation.autoApprove",
        entityType: "Video",
        entityId: result.videoId,
      },
    });

    expect(disclosure.message).toContain("approved it");
    expect(disclosure.message).toContain("Publishing still requires an explicit click.");
  });

  it("derives a working title from the topic rather than asking for one", async () => {
    const longTopic =
      "the reason a bottle of water costs more at an airport than at the " +
      "supermarket across the road, and what that says about how prices are " +
      "really set in places you cannot walk out of";

    const result = await makeService().start(userId, {
      projectId,
      topic: longTopic,
      variables: {},
    });

    expect(result.title.length).toBeLessThanOrEqual(120);
    // Cut on a word boundary, not mid-word.
    expect(result.title).toMatch(/^the reason a bottle of water/);
    expect(result.title.endsWith("…")).toBe(true);
  });
});

describe("automationService.getRun — coming back to a run in progress", () => {
  it("rebuilds the disclosure panel from the database alone", async () => {
    // The requirement this exists for: a render takes minutes on a separate
    // worker, so the operator closes the tab. Everything the progress view
    // shows has to survive that, which means none of it may live in component
    // memory.
    const started = await makeService().start(userId, {
      projectId,
      topic: "how a port decides which ship unloads first",
      variables: {},
    });

    const run = await makeService().getRun(userId, started.videoId);

    expect(run).toMatchObject({
      videoId: started.videoId,
      title: started.title,
      scriptVersion: 1,
      scriptContent: SCRIPT,
      autoApproved: true,
    });
  });

  it("does not claim auto-approval for a video the flow never touched", async () => {
    // A video queued by hand, then opened at /automation?video=… — telling its
    // operator their script was approved automatically would be a lie about
    // the one thing this page exists to be honest about.
    const video = await prisma.video.create({
      data: { userId, projectId, title: "Hand made", topic: "hand made" },
    });

    const run = await makeService().getRun(userId, video.id);

    expect(run?.autoApproved).toBe(false);
    expect(run?.scriptContent).toBeNull();
  });

  it("returns null for another operator's video rather than confirming it exists", async () => {
    const started = await makeService().start(userId, {
      projectId,
      topic: "why train tickets cost what they do",
      variables: {},
    });
    const otherUserId = await createTestUser("automation-other");

    try {
      expect(await makeService().getRun(otherUserId, started.videoId)).toBeNull();
    } finally {
      await deleteTestUser(otherUserId);
    }
  });
});

describe("automationService.start — variables reach the prompt", () => {
  it("substitutes the operator's answers and falls back to the template's defaults", async () => {
    const result = await makeService().start(userId, {
      projectId,
      topic: "inflation",
      variables: { tone: "dry and precise" },
    });

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId: result.videoId } },
    });

    expect(version.prompt).toContain("dry and precise");
    // Unanswered but defaulted — renderTemplate fills these from the template.
    expect(version.prompt).toContain("general viewers");
    expect(version.prompt).toContain("8-minute");
    // Declared nowhere, so deliberately left standing in the prompt rather
    // than silently emptied (see src/lib/prompt-template.ts).
    expect(version.prompt).toContain("{{mystery}}");
  });

  it("refuses to let a submitted topic override the video's own topic", async () => {
    const result = await makeService().start(userId, {
      projectId,
      topic: "the real topic",
      // scriptService.generate spreads caller variables *over* its own
      // `{ topic }`, so this would rewrite the script's subject if the flow
      // passed it through.
      variables: { topic: "something else entirely" },
    });

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId: result.videoId } },
    });

    expect(version.prompt).toContain("the real topic");
    expect(version.prompt).not.toContain("something else entirely");
  });

  it("ignores values for variables the template does not declare", async () => {
    const result = await makeService().start(userId, {
      projectId,
      topic: "compound interest",
      variables: { mystery: "smuggled", season: "winter" },
    });

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId: result.videoId } },
    });

    expect(version.prompt).not.toContain("smuggled");
    // `season` is declared but unused, so it cannot appear either way — the
    // assertion that matters is that an undeclared key never reached the model.
    expect(version.prompt).not.toContain("winter");
  });

  it("refuses before creating anything when a required variable has no answer", async () => {
    await setDefaultPrompt(userId, "Write about {{topic}} from a {{angle}} angle.", [
      { key: "topic", label: "Topic", required: true },
      { key: "angle", label: "Angle", required: true },
    ]);

    await expect(
      makeService().start(userId, {
        projectId,
        topic: "carbon offsets",
        variables: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing was written: the check runs before the video row exists, so a
    // missing answer never leaves debris behind.
    expect(await prisma.video.count({ where: { userId } })).toBe(0);
  });
});

describe("automationService.start — refusing to spend money", () => {
  it("refuses before taking any action when the account is not ready", async () => {
    // The exact failure this guard exists for: narration is the first paid
    // stage after the script, so a missing key means paying for a script
    // attached to a video that can never finish.
    await prisma.providerCredential.deleteMany({
      where: { userId, provider: "ELEVENLABS" },
    });

    await expect(
      makeService().start(userId, {
        projectId,
        topic: "why bridges are painted grey",
        variables: {},
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await prisma.video.count({ where: { userId } })).toBe(0);
  });

  it("leaves no draft behind when the model call fails, and rethrows the real error", async () => {
    const upstream = new Error("Anthropic rejected the key");
    const failing = makeService({
      generateScript: vi.fn(async () => {
        throw upstream;
      }),
    });

    let caught: unknown;
    try {
      await failing.start(userId, {
        projectId,
        topic: "how ports decide which ship unloads first",
        variables: {},
      });
    } catch (error) {
      caught = error;
    }

    // Unwrapped: the provider's own message is the only useful part of the
    // failure, and run() forwards it verbatim to the operator.
    expect(caught).toBe(upstream);

    // Soft-deleted rather than hard: the row survives for debugging, but a
    // string of failed attempts does not silently fill the videos list with
    // empty drafts the operator then has to clean up by hand.
    const videos = await prisma.video.findMany({ where: { userId } });
    expect(videos).toHaveLength(1);
    expect(videos[0].deletedAt).not.toBeNull();
  });

  it("does not delete a video whose script succeeded but whose approval failed", async () => {
    // The asymmetry that matters: a generated script has been paid for. Losing
    // it would destroy work, and DRAFT-with-a-script is exactly the state the
    // manual Approve button already handles.
    const service = makeService();
    const forced = new ConflictError("approval blew up");

    // `start()` opens exactly three transactions, in this order:
    //   1. videoService.create        (video.service.ts:107)
    //   2. scriptService.generate     (script.service.ts:97)
    //   3. videoService.approveScript (video.service.ts:153)
    // Only the third is forced to fail — the first two must commit, because
    // the whole point of this test is that a *paid-for* script survives an
    // approval that did not.
    //
    // Counting explicitly rather than chaining `mockImplementationOnce`: the
    // chained form scheduled the next rejection from inside the first call and
    // then invoked `prisma.$transaction` again, which is the spy — so the
    // rejection meant for call 2 fired on call 1, rolled back the video
    // creation, and left nothing for the assertions to find.
    const realTransaction = prisma.$transaction.bind(prisma) as typeof prisma.$transaction;
    let transactionCalls = 0;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementation(((...args: Parameters<typeof prisma.$transaction>) => {
        transactionCalls += 1;

        if (transactionCalls === 3) {
          return Promise.reject(forced);
        }

        return realTransaction(...(args as Parameters<typeof realTransaction>));
      }) as typeof prisma.$transaction);

    // `finally`, because `mockImplementation` persists until it is restored: if
    // the assertion below fails, an un-restored spy follows every later test in
    // this file and turns one failure into a cascade that hides its own cause.
    try {
      await expect(
        service.start(userId, {
          projectId,
          topic: "how a container ship is loaded",
          variables: {},
        }),
      ).rejects.toBe(forced);
    } finally {
      spy.mockRestore();
    }

    const video = await prisma.video.findFirstOrThrow({
      where: { userId },
      include: { script: { include: { activeVersion: true } } },
    });
    expect(video.deletedAt).toBeNull();
    expect(video.status).toBe("DRAFT");
    expect(video.script?.activeVersion?.content).toBe(SCRIPT);
  });
});

describe("automationService.start — double submission", () => {
  it("refuses a second identical request while the first is still generating", async () => {
    // The real failure: the operator clicks Generate, the page sits on a
    // spinner for tens of seconds, and they click again. Without the guard
    // that is two Anthropic calls and two videos.
    let releaseFirst!: (
      value: Awaited<ReturnType<TextGenerationProvider["generateScript"]>>,
    ) => void;
    const held = new Promise<
      Awaited<ReturnType<TextGenerationProvider["generateScript"]>>
    >((resolve) => {
      releaseFirst = resolve;
    });

    const input = {
      projectId,
      topic: "why some roads are toll roads",
      variables: {},
    };

    const firstProvider = { generateScript: vi.fn(() => held) };
    const secondProvider = fakeProvider();

    const first = makeService(firstProvider).start(userId, input);

    // Let the first call commit its video row and reach the (held-open)
    // model call, so the second genuinely lands mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(makeService(secondProvider).start(userId, input)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // The decisive assertion: the duplicate withdrew *before* the model was
    // called, so nothing was billed for it.
    expect(secondProvider.generateScript).not.toHaveBeenCalled();

    releaseFirst({
      content: SCRIPT,
      model: FAKE_MODEL,
      provider: "ANTHROPIC",
      inputTokens: 100,
      outputTokens: 400,
      costUsd: 0.0063,
      latencyMs: 1200,
    });

    const result = await first;

    const live = await prisma.video.findMany({ where: { userId, deletedAt: null } });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(result.videoId);
    expect(live[0].status).toBe("QUEUED");
  });

  it("still allows a genuinely different topic in the same project", async () => {
    const service = makeService();

    await service.start(userId, { projectId, topic: "topic one", variables: {} });
    await service.start(userId, { projectId, topic: "topic two", variables: {} });

    const live = await prisma.video.findMany({ where: { userId, deletedAt: null } });
    expect(live).toHaveLength(2);
    expect(live.every((video) => video.status === "QUEUED")).toBe(true);
  });
});
