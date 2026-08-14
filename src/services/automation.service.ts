import "server-only";

import { ConflictError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { extractVariables } from "@/lib/prompt-template";
import type { StartAutomationInput } from "@/schemas/automation.schema";
import { onboardingService } from "@/services/onboarding.service";
import { promptTemplateService } from "@/services/prompt-template.service";
import { scriptService, type ScriptService } from "@/services/script.service";
import { videoService } from "@/services/video.service";

/**
 * The guided "easy mode" flow: one screen that takes a topic and a little
 * direction and comes back with a video the operator can watch.
 *
 * It owns no domain logic of its own. Every step it performs is an existing
 * service call in the existing order — `videoService.create`,
 * `scriptService.generate`, `videoService.approveScript` — and the whole point
 * of this file is the *composition*, not the steps. What it removes is the
 * navigation between them: today that sequence spans a projects page, a videos
 * page, a video detail page and two separate clicks separated by a wait.
 *
 * The one thing it does that the manual path does not is cross Gate 1 (script
 * approval) on the operator's behalf. See `start` for exactly where, and for
 * why Gate 2 (publishing) is emphatically not crossed with it.
 */

/**
 * The subset of the onboarding checklist that is genuinely a precondition for
 * this flow, as opposed to a thing the flow itself is about to do.
 *
 * `create-video`, `generate-script` and `approve-script` are deliberately
 * absent: those steps describe work this flow performs, so requiring them
 * would mean refusing to run until the operator had already done by hand the
 * exact thing they came here to avoid doing by hand.
 *
 * The other four are all "spend will fail partway without this", which is the
 * failure mode this flow must never have — a script is billed the moment it is
 * generated, so discovering a missing ElevenLabs key at the narration stage
 * means the operator has already paid for a video that cannot finish.
 * `connect-channel` is included even though nothing here publishes: a video
 * with nowhere to go at the end is not a finished job, and finding that out
 * after paying for one is the same unpleasant surprise.
 */
const REQUIRED_STEP_IDS: ReadonlySet<string> = new Set([
  "connect-channel",
  "add-narration-key",
  "check-prompt-template",
  "create-project",
]);

/**
 * Why each missing precondition stops *this* flow specifically.
 *
 * The onboarding checklist's own descriptions are written for a first-run
 * to-do list ("Confirm the default script prompt fits how you write"), which
 * reads oddly as the reason a button is refusing to work. The titles and
 * links are reused verbatim — they point at the same pages and mean the same
 * things — and only the explanation is restated in terms of what this flow
 * cannot do without it.
 */
const BLOCKER_REASONS: Record<string, string> = {
  "connect-channel":
    "Nothing here publishes automatically, but a finished video needs somewhere to go. Connect the channel first.",
  "add-narration-key":
    "Narration is the first paid stage after the script. Without this key the run fails partway, after the script has already been billed.",
  "check-prompt-template":
    "The script is written from your default SCRIPT prompt, and the questions below are built from the variables it declares. There is nothing to generate from until one exists.",
  "create-project":
    "Every video belongs to a project. Create one so this video has a home and a publishing target.",
};

/** The variable `scriptService.generate` fills in from the video's own topic.
 * Excluded from the direction fields so the flow asks for the topic exactly
 * once — and, more importantly, so a submitted `topic` value can never
 * override it: `generate` spreads the caller's variables *over* its own
 * `{ topic }`, so passing one through here would silently write the script
 * about something other than the topic stored on the video. */
const TOPIC_VARIABLE_KEY = "topic";

/** Surfaced as its own step rather than sitting among the direction fields:
 * length is the one variable whose answer has a cost the operator should see
 * spelled out, so the UI frames it in minutes and explains what it buys. */
const DURATION_VARIABLE_KEY = "duration";

/**
 * How far back the double-submit guard looks for an identical request.
 *
 * The failure it exists for is a paid one: a script generation takes tens of
 * seconds, during which the page shows a spinner and an impatient operator
 * clicks again, reloads, or resubmits — and every one of those calls bills
 * another Anthropic request and leaves another video in the queue. The window
 * therefore has to comfortably outlast one generation, not merely a double
 * click, which is why this is minutes rather than milliseconds.
 *
 * The cost of erring long is that a *deliberate* second video on the exact
 * same topic in the exact same project inside this window is refused. That is
 * a rare thing to want, it is refused with an explanation rather than
 * silently, and it resolves itself by waiting — whereas the failure in the
 * other direction costs real money and cannot be undone.
 */
const DUPLICATE_WINDOW_SECONDS = 120;

/** `Video.title`'s working cap, matching `createVideoSchema`'s own limit so a
 * title this flow derives is one the manual dialog would also have accepted. */
const MAX_TITLE_LENGTH = 120;

export interface AutomationBlocker {
  /** The onboarding step id this came from, so the UI can key on it. */
  id: string;
  title: string;
  description: string;
  href: string;
}

export interface AutomationProject {
  id: string;
  name: string;
  /** The channel this project publishes to, so the flow can tell the operator
   * where the video will end up rather than only which project it belongs to.
   * Null for a project with no channel set — publishing then needs one chosen
   * at publish time. */
  channelTitle: string | null;
}

/** One question the flow asks, derived from one `PromptVariable` row. */
export interface AutomationField {
  key: string;
  label: string;
  defaultValue: string | null;
  required: boolean;
}

export interface AutomationPromptSummary {
  id: string;
  name: string;
  /**
   * The direction questions: every variable the template both declares *and*
   * actually uses, minus the two the flow handles as their own steps
   * (`topic`, `duration`). Driven entirely off the operator's own
   * `PromptVariable` rows, so editing the prompt changes these fields with no
   * code change here.
   */
  fields: AutomationField[];
  /** The `duration` variable, if this template declares one. Null when it does
   * not — the flow then has no length step at all rather than asking for a
   * number the prompt would ignore. */
  duration: AutomationField | null;
}

export interface AutomationSetup {
  /** Empty when the account is ready. Anything here means the flow refuses to
   * take a topic — see `REQUIRED_STEP_IDS`. */
  blockers: AutomationBlocker[];
  projects: AutomationProject[];
  /** Null exactly when `blockers` contains `check-prompt-template`: there is
   * no default SCRIPT template to describe. */
  prompt: AutomationPromptSummary | null;
}

export interface AutomationResult {
  videoId: string;
  title: string;
  scriptVersion: number;
  wordCount: number;
  /** The generated narration, returned so the flow can show the operator the
   * script it approved on their behalf. Disclosing an auto-approval without
   * showing what was approved would be a worse kind of silence than not
   * mentioning it at all. */
  scriptContent: string;
}

/**
 * A run in flight, read back from the database rather than remembered.
 *
 * The flow's progress view is reachable by URL (`/automation?video=…`), which
 * is what makes closing the tab and coming back later work at all: a render
 * takes minutes on a separate worker, so component memory is exactly the wrong
 * place to keep the answer to "what is happening to my video". Everything the
 * progress view shows is therefore reconstructible from rows.
 */
export interface AutomationRun {
  videoId: string;
  title: string;
  /** Null only for a video with no script version at all — impossible for a
   * run this flow started, reachable by hand-editing the query string to a
   * video created some other way. The view degrades to showing progress
   * without a script rather than refusing. */
  scriptVersion: number | null;
  wordCount: number | null;
  scriptContent: string | null;
  /**
   * Whether *this* video's script was approved by the guided flow, read back
   * from the disclosure row `start` writes — never assumed from the fact that
   * the progress view is being rendered. A video queued by hand and then
   * opened at `/automation?video=…` must not be told its script was approved
   * automatically, because it wasn't.
   */
  autoApproved: boolean;
}

/**
 * A working title for the video row, derived rather than asked for.
 *
 * The flow deliberately has no title step. The title an audience sees is
 * written by the metadata stage after the render (`MetadataService` stores it
 * in `Video.generatedTitle`, and `publish()` sends `generatedTitle ?? title`),
 * so anything typed here would be overwritten before it ever reached YouTube
 * — asking for it would be asking the operator to do work the pipeline
 * discards. What `Video.title` actually needs to be is something recognisable
 * in the videos list while the run is in flight, and the topic already is
 * exactly that.
 *
 * The first sentence, capped at the column's working limit and cut on a word
 * boundary so a long topic degrades to a readable phrase rather than a
 * mid-word stump.
 */
function deriveTitle(topic: string): string {
  const trimmed = topic.trim();
  const [firstSentence] = trimmed.split(/(?<=[.!?])\s/);
  const candidate = firstSentence?.trim() || trimmed;

  if (candidate.length <= MAX_TITLE_LENGTH) {
    return candidate;
  }

  const clipped = candidate.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = clipped.lastIndexOf(" ");

  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

export class AutomationService {
  /**
   * `Pick`, not the whole `ScriptService`, for the reason that class documents
   * on its own constructor: this service only ever calls `generate`, and
   * typing the parameter as the full class would force every test to stub
   * `importScript`, `saveEdit` and `setActiveVersion` as well. Injected at all
   * so a test can drive the flow with a fake text provider instead of billing
   * the operator's real Anthropic key on every run.
   */
  constructor(
    private readonly scripts: Pick<ScriptService, "generate"> = scriptService,
  ) {}

  /**
   * Everything the guided flow needs to render itself: what's missing, which
   * projects exist, and which questions the operator's own prompt supports.
   * One call so the page has no waterfall and — more importantly — so the
   * readiness answer and the questions can never disagree with each other.
   */
  async getSetup(userId: string): Promise<AutomationSetup> {
    const blockers = await this.getBlockers(userId);
    const promptIsMissing = blockers.some(
      (blocker) => blocker.id === "check-prompt-template",
    );

    const [projects, prompt] = await Promise.all([
      this.listProjects(userId),
      // Guarded rather than caught: `getDefault` throws `NotFoundError` when
      // there is no default SCRIPT template, and that is not an error here —
      // it is one of the blockers already reported above, with a link to the
      // page that fixes it.
      promptIsMissing ? null : this.describePrompt(userId),
    ]);

    return {
      blockers: withUsableProjectBlocker(blockers, projects),
      projects,
      prompt,
    };
  }

  /**
   * Rebuilds a run's disclosure panel from the database, for an operator who
   * came back to `/automation?video=…` after closing the tab.
   *
   * Returns `null` rather than throwing for an unknown or foreign video id:
   * the query string is operator-editable, and the honest response to "this
   * isn't your video" is to show the flow's normal starting state, not an
   * error page that confirms an id exists. Scoped by `userId` like every other
   * read here, so a guessed id reveals nothing either way.
   */
  async getRun(userId: string, videoId: string): Promise<AutomationRun | null> {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: {
        id: true,
        title: true,
        script: {
          select: {
            activeVersion: { select: { version: true, wordCount: true, content: true } },
          },
        },
      },
    });

    if (!video) {
      return null;
    }

    const disclosure = await prisma.activityLog.findFirst({
      where: {
        userId,
        action: "automation.autoApprove",
        entityType: "Video",
        entityId: videoId,
      },
      select: { id: true },
    });

    const active = video.script?.activeVersion ?? null;

    return {
      videoId: video.id,
      title: video.title,
      scriptVersion: active?.version ?? null,
      wordCount: active?.wordCount ?? null,
      scriptContent: active?.content ?? null,
      autoApproved: disclosure !== null,
    };
  }

  /**
   * The whole flow, in one call: create the video, write its script, approve
   * that script, and leave it queued for the render worker.
   *
   * ## Gate 1 is crossed automatically. Gate 2 is not.
   *
   * `videoService.approveScript` below is the deliberate part. In the manual
   * flow an operator reads the generated script and clicks "Approve script",
   * which moves the video DRAFT -> QUEUED and makes it eligible for the paid
   * stages. This flow performs that transition without a human reading
   * anything first, and that is precisely the friction it exists to remove:
   * the operator asked for a finished video, not for a draft plus a second
   * errand.
   *
   * What it does *not* touch is publishing. Nothing here creates a
   * `Publication`, calls `publishService`, or moves a video toward
   * `PUBLISHED`. The run ends at a finished, watchable render and stops, and
   * the operator's own publish click remains the only thing that puts a video
   * on YouTube. That second gate is the product's central promise — it is the
   * reason an operator can let this flow spend their money unattended at all —
   * so "one click" here means one click to a video, never one click to an
   * audience.
   *
   * Because approval happens unread, it is disclosed rather than assumed: an
   * `ActivityLog` row is written against the video (see the end of this
   * method), which surfaces in the video's own merged log stream and on the
   * Activity page, and the flow's result carries the script back so the UI can
   * show what was approved.
   */
  async start(
    userId: string,
    input: StartAutomationInput,
  ): Promise<AutomationResult> {
    // Re-checked server-side even though the page already gates the form on
    // it. A server action is a public endpoint: a hand-crafted POST reaches
    // this method with no UI in the way, and the whole point of the check is
    // to refuse *before* the billed call rather than fail after it.
    const blockers = await this.getBlockers(userId);

    if (blockers.length > 0) {
      throw new ConflictError(
        `This account isn't ready to generate a video yet: ${blockers
          .map((blocker) => blocker.title.toLowerCase())
          .join(", ")}.`,
      );
    }

    const prompt = await this.describePrompt(userId);
    const variables = resolveVariables(prompt, input.variables);

    const video = await videoService.create(userId, {
      projectId: input.projectId,
      title: deriveTitle(input.topic),
      topic: input.topic,
    });

    await this.guardDuplicateSubmission(userId, video.id, input);

    // From here on real money is at stake, and the video row already exists.
    let version: Awaited<ReturnType<ScriptService["generate"]>>;

    try {
      version = await this.scripts.generate(userId, video.id, { variables });
    } catch (error) {
      // The generation failed, so this video has a topic and nothing else.
      // Leaving it behind would mean every failed attempt — a lapsed API key
      // produces a run of them — deposits another empty draft in the videos
      // list, which the operator then has to find and clean up in exactly the
      // step-by-step UI this flow exists to replace. The delete is soft (see
      // `VideoService.remove`), so the row and its status history survive for
      // debugging, and any spend that did happen was already recorded on
      // `ProviderUsage` by `generate` itself, independently of this video.
      //
      // Deliberately only on *this* failure. A generation that succeeded has
      // been paid for, and its script is worth keeping even if a later step
      // fails — see the approval below, which has no such cleanup.
      await videoService.remove(userId, video.id).catch((cleanupError: unknown) => {
        console.error(
          `Automation could not clean up draft video ${video.id} after a failed ` +
            "script generation:",
          cleanupError,
        );
      });

      // Rethrown unchanged, not wrapped. `ProviderError` and the rest of the
      // typed hierarchy carry messages an operator can act on ("Anthropic
      // rejected the key", "rate limited"), and `run()` forwards them
      // verbatim; collapsing that into a generic "generation failed" would
      // throw away the only useful part of the failure.
      throw error;
    }

    // Gate 1, crossed on the operator's behalf. See this method's doc comment.
    // No try/catch: unlike the generation above, a failure here leaves a video
    // with a real, paid-for script sitting in DRAFT, which is precisely the
    // state the manual flow's Approve button exists for — the operator loses
    // nothing but the automation, and deleting the video would destroy work
    // they have already paid for.
    await videoService.approveScript(userId, video.id);

    await this.recordAutoApproval(userId, video.id, version.version);

    return {
      videoId: video.id,
      title: video.title,
      scriptVersion: version.version,
      wordCount: version.wordCount,
      scriptContent: version.content,
    };
  }

  /**
   * Stops a second identical submission from generating a second script.
   *
   * There is no idempotency key and no unique constraint to lean on, so the
   * newly created video row is used as the claim itself: whichever of two
   * competing submissions created the *earlier* row owns the topic, and every
   * other one withdraws. `createdAt` alone is not a total order (two rows can
   * share a timestamp), so ties break on `id` — a total order over UUIDs —
   * which means two racing calls always agree on which of them won rather than
   * both deciding they lost, or both deciding they won.
   *
   * This runs after the video is created and before the model is called, which
   * is the only placement that works: checking before the create leaves the
   * classic read-then-write hole (both callers see nothing and both proceed),
   * while checking after the generation would be checking after the money was
   * already spent. The wasted work in the losing path is therefore one cheap
   * row, which is then soft-deleted.
   *
   * Scoped to project + exact topic rather than to the operator globally: two
   * genuinely different videos started seconds apart is normal use, and only
   * an identical repeat of the same request is evidence of a resubmission.
   */
  private async guardDuplicateSubmission(
    userId: string,
    videoId: string,
    input: StartAutomationInput,
  ): Promise<void> {
    const claimed = await prisma.video.findFirst({
      where: {
        id: videoId,
        userId,
        deletedAt: null,
      },
      select: { createdAt: true },
    });

    // Cannot happen — this row was created microseconds ago by the caller —
    // but reading it back is what gives the comparison below a committed
    // timestamp rather than one this process guessed.
    if (!claimed) {
      throw new ConflictError("This video disappeared while it was being set up.");
    }

    const earlier = await prisma.video.findFirst({
      where: {
        userId,
        projectId: input.projectId,
        topic: input.topic,
        deletedAt: null,
        createdAt: {
          gte: new Date(claimed.createdAt.getTime() - DUPLICATE_WINDOW_SECONDS * 1000),
        },
        // "Strictly before mine" in the total order described above. This also
        // excludes the row itself, which is neither before its own timestamp
        // nor before its own id.
        OR: [
          { createdAt: { lt: claimed.createdAt } },
          { createdAt: claimed.createdAt, id: { lt: videoId } },
        ],
      },
      select: { id: true },
    });

    if (!earlier) {
      return;
    }

    await videoService.remove(userId, videoId).catch((cleanupError: unknown) => {
      console.error(
        `Automation could not clean up duplicate draft video ${videoId}:`,
        cleanupError,
      );
    });

    throw new ConflictError(
      "You just started this exact video — same topic, same project — moments " +
        "ago, and it is already running. Open it from Videos rather than " +
        "generating a second script for it.",
    );
  }

  /**
   * The durable disclosure that no human read this script before it was
   * queued.
   *
   * It has to live somewhere other than the UI that reported the success,
   * because the operator who comes back to this video tomorrow — or the one
   * auditing the Activity page — sees only what was written down.
   * `VideoStatusEvent`'s DRAFT -> QUEUED row is written inside
   * `videoService.approveScript` and reads "Script approved by operator",
   * which is true of every other caller and not of this one; that method is
   * shared with the manual flow and is not this service's to change, so this
   * row sits beside it and says what actually happened. `getLogStream`
   * (pipeline.service.ts) merges `ActivityLog` rows by `entityType`/`entityId`
   * into the video's own log, so it appears in timeline order right next to
   * the transition it explains.
   *
   * Best-effort on purpose: the video is already queued by the time this runs,
   * and failing the whole call over a log write would report a failure for a
   * run that genuinely succeeded and is, at that moment, being picked up by a
   * worker.
   */
  private async recordAutoApproval(
    userId: string,
    videoId: string,
    scriptVersion: number,
  ): Promise<void> {
    try {
      await prisma.activityLog.create({
        data: {
          userId,
          action: "automation.autoApprove",
          entityType: "Video",
          entityId: videoId,
          message:
            `Guided flow generated script v${scriptVersion} and approved it ` +
            "automatically — the video was queued without an operator reading " +
            "it first. Publishing still requires an explicit click.",
        },
      });
    } catch (error) {
      console.error(
        `Automation could not record the auto-approval of video ${videoId}:`,
        error,
      );
    }
  }

  /** The preconditions this flow cannot proceed without, read off the same
   * checks the dashboard's getting-started card already computes — one
   * definition of "this account is set up", not a second one that could
   * drift from it. */
  private async getBlockers(userId: string): Promise<AutomationBlocker[]> {
    const checklist = await onboardingService.getChecklist(userId);

    return checklist.steps
      .filter((step) => REQUIRED_STEP_IDS.has(step.id) && !step.complete)
      .map((step) => ({
        id: step.id,
        title: step.title,
        description: BLOCKER_REASONS[step.id] ?? step.description,
        href: step.href,
      }));
  }

  private async listProjects(userId: string): Promise<AutomationProject[]> {
    const projects = await prisma.project.findMany({
      where: { userId, deletedAt: null, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        // `title` only, never the token columns — same discipline as
        // `videoService.get`'s channel select.
        channel: { select: { title: true } },
      },
    });

    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      channelTitle: project.channel?.title ?? null,
    }));
  }

  /**
   * Turns the operator's own default SCRIPT template into the questions this
   * flow asks.
   *
   * The fields come from the template's `PromptVariable` rows, not from a list
   * written here, so an operator who adds a `{{format}}` variable to their
   * prompt is asked for a format on their next visit with no code change. The
   * corollary matters just as much: a variable nobody declared is never asked
   * for, because `renderTemplate` would leave its placeholder untouched in the
   * prompt anyway (see src/lib/prompt-template.ts, which treats the
   * declarations as authoritative precisely so a typo stays visible).
   *
   * Declarations are further intersected with the placeholders the content
   * actually contains. A declared-but-unused variable is inert — nothing in
   * the rendered prompt changes whatever the operator types — so asking for
   * one would be collecting an answer the model never sees.
   */
  private async describePrompt(userId: string): Promise<AutomationPromptSummary> {
    const template = await promptTemplateService.getDefault(userId, "SCRIPT");
    const used = new Set(extractVariables(template.content));

    const asked = template.variables
      .filter((variable) => used.has(variable.key) && variable.key !== TOPIC_VARIABLE_KEY)
      .map(
        (variable): AutomationField => ({
          key: variable.key,
          label: variable.label,
          defaultValue: variable.defaultValue,
          required: variable.required,
        }),
      );

    return {
      id: template.id,
      name: template.name,
      fields: asked.filter((field) => field.key !== DURATION_VARIABLE_KEY),
      duration: asked.find((field) => field.key === DURATION_VARIABLE_KEY) ?? null,
    };
  }
}

/**
 * Covers the one gap between "a project exists" and "a project this flow can
 * use".
 *
 * The onboarding checklist's `create-project` step asks only whether a
 * non-deleted project row exists; `listProjects` additionally excludes
 * archived ones, because archiving a project is exactly how an operator says
 * "stop putting new videos here". An operator whose only project is archived
 * therefore satisfies the checklist and still has nothing to select, which
 * would leave the flow with no project step (there is nothing to choose
 * between) and no valid project id to submit — a form that fails on the final
 * click for a reason it never showed. Reported as a blocker instead, reusing
 * the checklist step's own id and link so the UI needs no special case.
 */
function withUsableProjectBlocker(
  blockers: AutomationBlocker[],
  projects: AutomationProject[],
): AutomationBlocker[] {
  if (projects.length > 0 || blockers.some((blocker) => blocker.id === "create-project")) {
    return blockers;
  }

  return [
    ...blockers,
    {
      id: "create-project",
      title: "Create an active project",
      description:
        "Every project you have is archived, and an archived project takes no new videos. Create one, or unarchive the one this video belongs in.",
      href: "/projects",
    },
  ];
}

/**
 * Reduces the form's submission to the values `scriptService.generate` should
 * actually be given, and refuses early if the prompt cannot be rendered from
 * them.
 *
 * Only keys the template declares survive, so a stale form — or a crafted
 * payload — cannot smuggle extra values through. `topic` in particular is
 * already excluded from `fields`/`duration` by `describePrompt`, which is what
 * stops a submitted `topic` from overriding the video's own topic inside
 * `generate`.
 *
 * The required check duplicates one `renderTemplate` already performs, and
 * does so deliberately: `renderTemplate` runs inside `generate`, after the
 * video row has been created, and reports raw variable *keys*. Checking here
 * fails before anything is written and names the operator's own labels, which
 * are what the form showed them.
 */
function resolveVariables(
  prompt: AutomationPromptSummary,
  submitted: Record<string, string>,
): Record<string, string> {
  const declared = prompt.duration ? [...prompt.fields, prompt.duration] : prompt.fields;
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of declared) {
    const supplied = submitted[field.key]?.trim();

    if (supplied) {
      values[field.key] = supplied;
      continue;
    }

    // Left out of `values` entirely rather than passed as "": `renderTemplate`
    // falls back to the variable's own `defaultValue` only when no value is
    // supplied, and an empty string would defeat that.
    if (field.defaultValue) {
      continue;
    }

    if (field.required) {
      missing.push(field.label);
    }
  }

  if (missing.length > 0) {
    throw new ValidationError(
      `Your script prompt needs ${missing.length === 1 ? "an answer" : "answers"} for: ${missing.join(", ")}.`,
    );
  }

  return values;
}

export const automationService = new AutomationService();
