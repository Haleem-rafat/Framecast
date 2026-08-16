import "server-only";

import type { ScheduleFrequency, ScheduleStatus, VideoFormat, VideoStatus } from "@/generated/prisma/enums";
import {
  ConflictError,
  isAppError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { describeRecurrence } from "@/lib/schedule-time";
import type { CreateSeriesInput, UpdateSeriesInput } from "@/schemas/series.schema";
import {
  automationService,
  type AutomationBlocker,
  type AutomationPromptSummary,
  type AutomationScriptStyle,
  type AutomationService,
} from "@/services/automation.service";
import { brandService, type ChannelBranding } from "@/services/brand.service";
import {
  scheduleService,
  type ScheduleRunRecord,
  type ScheduleService,
  type ScheduleTopicRecord,
} from "@/services/schedule.service";

/**
 * A series: one named, recurring show.
 *
 * ## What this file is for
 *
 * Everything a recurring show needs already existed, scattered over five
 * screens. The niche, tone, voice, music, footage style, art style, character
 * sheet, language, category and audience declaration are a `ChannelBrand`,
 * edited on the branding screen. Which script style writes it was a picker in
 * the script panel, answered per video. Landscape or vertical was a radio group
 * in the approve dialog, answered per video. The cadence and the topic queue
 * are a `Schedule`. Nothing tied them together or gave them a name, so setting
 * up a second show meant remembering five places, and running two different
 * shows on one channel was not expressible at all.
 *
 * A `Series` is the name. It owns two values of its own — the name and the
 * format — and points at everything else.
 *
 * ## It does not reimplement the schedule
 *
 * `Schedule` already solves the four hard problems of running something
 * unattended: the atomic claim that cannot fire twice, the advance that cannot
 * burst after downtime, the wall-clock recurrence that survives DST, and the
 * counter that pauses a schedule failing for a reason nobody is watching. This
 * service contains none of that and never will. A series *owns* a schedule row
 * (`Schedule.seriesId`), and every operation that touches the cadence, the
 * queue or the status is delegated to `ScheduleService` — pause, resume, add a
 * topic, remove a topic, take the next topic, the whole due-check. What a
 * series adds is read at exactly one point, in `ScheduleService.runTopic`:
 * which script style writes the episode, and what shape it comes out.
 *
 * ## Two things it must not do
 *
 * It schedules generation, not publishing. `generateNow` and the tick path both
 * end at `automationService.start`, which stops at a queued video. Nothing here
 * creates a `Publication` or moves a video toward PUBLISHED, and nothing here
 * ever will.
 *
 * It does not invent topics. `generateNow` takes the head of the same operator-
 * written queue a scheduled run takes, through the same atomic take, and
 * refuses when there is nothing there rather than asking a model what the show
 * should be about this week.
 */

/** How many of a show's videos the detail page lists. Enough to see the last
 *  few months of a weekly show at a glance; the full set is one filtered click
 *  away in Videos. */
const RECENT_VIDEO_LIMIT = 20;

export interface SeriesVideo {
  id: string;
  title: string;
  topic: string | null;
  status: VideoStatus;
  format: VideoFormat;
  createdAt: Date;
}

export interface SeriesSummary {
  id: string;
  name: string;
  format: VideoFormat;
  channelId: string;
  channelTitle: string;
  projectId: string;
  projectName: string;
  scriptStyleId: string;
  scriptStyleName: string;
  /** The `Schedule` row this show's cadence lives on. Surfaced because the
   *  topic-queue component and its server actions are the schedule's, reused
   *  unchanged — the series page passes this straight to them. */
  scheduleId: string;
  status: ScheduleStatus;
  pausedReason: string | null;
  /** One line of prose, built by the same `describeRecurrence` the schedules
   *  list uses, so the two phrase an identical cadence identically. */
  cadence: string;
  nextRunAt: Date | null;
  queuedTopicCount: number;
  nextTopic: string | null;
  videoCount: number;
}

export interface SeriesDetail extends SeriesSummary {
  frequency: ScheduleFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timeZone: string;
  variables: Record<string, string>;
  topics: ScheduleTopicRecord[];
  runs: ScheduleRunRecord[];
  runInFlight: boolean;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  /**
   * The channel's brand, exactly as `brandService` reads it — the values every
   * episode of this show will actually be made with.
   *
   * Carried on the detail rather than left to the page to fetch because the
   * page's job is to make it unmistakable *which value is winning*, and it can
   * only do that if it is showing the same row the renderer will read. A series
   * cannot override any of this; see the `Series.channelId` comment in
   * schema.prisma for why.
   */
  brand: ChannelBranding;
  /** The questions this show's script style asks, so the edit form can render
   *  the same answer fields the service will reconcile against. */
  prompt: AutomationPromptSummary;
  videos: SeriesVideo[];
}

/** Everything the create form needs, in one call. */
export interface SeriesSetup {
  /** The guided flow's own readiness blockers, reused verbatim: a series that
   *  cannot generate a video is a series that fails at 09:00 on a Monday. */
  blockers: AutomationBlocker[];
  channels: { id: string; title: string }[];
  /** Active projects, each carrying the channel it publishes to so the form can
   *  narrow the list the moment a channel is chosen. `channelId` is null for a
   *  project with no publishing target — offered nowhere, because a series with
   *  no channel would inherit no brand. */
  projects: { id: string; name: string; channelId: string | null }[];
  scriptStyles: AutomationScriptStyle[];
}

/** What `generateNow` produced, for the toast that reports it. */
export interface SeriesRunResult {
  videoId: string;
  title: string;
  topic: string;
}

/** The recurrence half of a create/update payload, which is exactly the shape
 *  `ScheduleService` takes. Named once so both write paths hand it over
 *  identically. */
function cadenceOf(input: CreateSeriesInput | UpdateSeriesInput) {
  return {
    frequency: input.frequency,
    dayOfWeek: input.frequency === "WEEKLY" ? input.dayOfWeek : null,
    dayOfMonth: input.frequency === "MONTHLY" ? input.dayOfMonth : null,
    hour: input.hour,
    minute: input.minute,
    timeZone: input.timeZone,
  };
}

export class SeriesService {
  /**
   * Both collaborators are injected for the same reason every other service
   * here injects the thing that costs money: a test must be able to drive a
   * whole run — the recipe, the claim, the topic, the history — against a fake
   * text provider instead of billing a real Anthropic call on every assertion.
   *
   * `ScheduleService` is injected too, and that matters more than it looks: a
   * test composes the *real* one, so the claim, the advance, the atomic topic
   * take and the failure counter under test are the production ones. Nothing
   * about the schedule is faked; only the model is.
   *
   * `Pick` rather than the whole classes, matching `AutomationService` and
   * `ScheduleService`'s own constructors — a fake has to stub what is called
   * and nothing else.
   */
  constructor(
    private readonly automation: Pick<
      AutomationService,
      "start" | "getSetup" | "describeScriptStyle" | "listScriptStyles"
    > = automationService,
    private readonly schedules: Pick<
      ScheduleService,
      "get" | "create" | "update" | "pause" | "resume" | "remove" | "takeNextTopic"
    > = scheduleService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read model
  // ---------------------------------------------------------------------------

  async list(userId: string): Promise<SeriesSummary[]> {
    const rows = await prisma.series.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        format: true,
        channelId: true,
        channel: { select: { title: true } },
        projectId: true,
        project: { select: { name: true } },
        promptTemplateId: true,
        promptTemplate: { select: { name: true } },
        _count: { select: { videos: { where: { deletedAt: null } } } },
        schedule: {
          select: {
            id: true,
            status: true,
            pausedReason: true,
            frequency: true,
            dayOfWeek: true,
            dayOfMonth: true,
            hour: true,
            minute: true,
            timeZone: true,
            nextRunAt: true,
            // Only the head is loaded for a list, exactly as `ScheduleService`
            // does it: the next topic is the one worth showing, plus a count.
            topics: {
              where: { consumedAt: null },
              orderBy: { position: "asc" },
              take: 1,
              select: { topic: true },
            },
            _count: { select: { topics: { where: { consumedAt: null } } } },
          },
        },
      },
    });

    // A series without a schedule cannot happen — `create` writes the pair and
    // `remove` retires the pair — but the relation is optional in the schema
    // (the foreign key lives on `Schedule`), so the compiler is right to insist.
    // Skipped rather than shown half-drawn: a row with no cadence has nothing
    // truthful to put in three of its columns.
    return rows.flatMap((row) => (row.schedule ? [this.toSummary(row, row.schedule)] : []));
  }

  async get(userId: string, id: string): Promise<SeriesDetail> {
    const row = await prisma.series.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        format: true,
        channelId: true,
        channel: { select: { title: true } },
        projectId: true,
        project: { select: { name: true } },
        promptTemplateId: true,
        promptTemplate: { select: { name: true } },
        _count: { select: { videos: { where: { deletedAt: null } } } },
        schedule: { select: { id: true } },
      },
    });

    if (!row?.schedule) {
      throw new NotFoundError("Series");
    }

    // The cadence, the queue, the history and the in-flight flag all come from
    // `ScheduleService.get` rather than being re-read here. One reader, one set
    // of rules about which topics are "waiting" and how many runs are shown.
    const [schedule, brand, prompt, videos] = await Promise.all([
      this.schedules.get(userId, row.schedule.id),
      brandService.getBranding(userId, row.channelId),
      this.automation.describeScriptStyle(userId, row.promptTemplateId),
      prisma.video.findMany({
        where: { seriesId: id, userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: RECENT_VIDEO_LIMIT,
        select: {
          id: true,
          title: true,
          topic: true,
          status: true,
          format: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ...this.toSummary(row, {
        id: schedule.id,
        status: schedule.status,
        pausedReason: schedule.pausedReason,
        frequency: schedule.frequency,
        dayOfWeek: schedule.dayOfWeek,
        dayOfMonth: schedule.dayOfMonth,
        hour: schedule.hour,
        minute: schedule.minute,
        timeZone: schedule.timeZone,
        nextRunAt: schedule.nextRunAt,
        topics: schedule.nextTopic ? [{ topic: schedule.nextTopic }] : [],
        _count: { topics: schedule.queuedTopicCount },
      }),
      frequency: schedule.frequency,
      dayOfWeek: schedule.dayOfWeek,
      dayOfMonth: schedule.dayOfMonth,
      hour: schedule.hour,
      minute: schedule.minute,
      timeZone: schedule.timeZone,
      variables: schedule.variables,
      topics: schedule.topics,
      runs: schedule.runs,
      runInFlight: schedule.runInFlight,
      lastRunAt: schedule.lastRunAt,
      consecutiveFailures: schedule.consecutiveFailures,
      brand,
      prompt,
      videos,
    };
  }

  /**
   * Everything the create form needs, in one call, for the same reason
   * `AutomationService.getSetup` is one call: no waterfall, and — more
   * importantly — the readiness answer and the pickers cannot disagree.
   */
  async getSetup(userId: string): Promise<SeriesSetup> {
    const [setup, channels, projects, scriptStyles] = await Promise.all([
      this.automation.getSetup(userId),
      prisma.channel.findMany({
        where: { userId, deletedAt: null },
        orderBy: { connectedAt: "asc" },
        // `title` and `id` only, never the token columns — the same discipline
        // `channelService.SUMMARY_SELECT` keeps.
        select: { id: true, title: true },
      }),
      prisma.project.findMany({
        where: { userId, deletedAt: null, status: "ACTIVE" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true, channelId: true },
      }),
      this.automation.listScriptStyles(userId),
    ]);

    return {
      blockers: withSeriesBlockers(setup.blockers, projects, scriptStyles),
      channels,
      projects,
      scriptStyles,
    };
  }

  // ---------------------------------------------------------------------------
  // Operator actions
  // ---------------------------------------------------------------------------

  /**
   * Creates the show and the cadence it runs on.
   *
   * Two writes rather than one transaction, and the ordering is deliberate: the
   * cheap, complete validation happens first (`assertRecipe` checks the
   * channel, the project, the script style *and* reconciles the stored answers
   * against that style's declarations), so by the time the `Series` row exists
   * there is nothing left that can reasonably fail. If the schedule write fails
   * anyway, the series row is hard-deleted on the way out — it is seconds old,
   * nothing references it, and leaving a show with no cadence behind would be a
   * row the operator can see and cannot use. Same shape, and same reasoning, as
   * `AutomationService.start` cleaning up a draft video whose generation failed.
   */
  async create(userId: string, input: CreateSeriesInput): Promise<{ id: string }> {
    await this.assertRecipe(userId, input);

    const series = await prisma.series.create({
      data: {
        userId,
        name: input.name,
        channelId: input.channelId,
        projectId: input.projectId,
        promptTemplateId: input.promptTemplateId,
        format: input.format,
      },
      select: { id: true },
    });

    try {
      await this.schedules.create(
        userId,
        {
          name: input.name,
          projectId: input.projectId,
          ...cadenceOf(input),
          variables: input.variables,
          topics: input.topics,
        },
        { seriesId: series.id, templateId: input.promptTemplateId },
      );
    } catch (error) {
      await prisma.series
        .delete({ where: { id: series.id } })
        .catch((cleanupError: unknown) => {
          console.error(
            `Could not clean up series ${series.id} after its schedule failed to save:`,
            cleanupError,
          );
        });

      throw error;
    }

    return series;
  }

  /**
   * Edits the recipe and the cadence together, because the operator edits them
   * on one form with one Save.
   *
   * The schedule is written first. `ScheduleService.update` is the half that
   * can still refuse — it re-checks the project and reconciles the answers —
   * and the rule that a rename must not move a Monday-morning run lives there,
   * on the existing row. Writing the series first and having the schedule
   * refuse afterwards would leave the show pointing at a new script style while
   * its stored answers still belonged to the old one.
   */
  async update(userId: string, id: string, input: UpdateSeriesInput): Promise<void> {
    const existing = await this.requireOwned(userId, id);
    await this.assertRecipe(userId, input);

    await this.schedules.update(
      userId,
      existing.scheduleId,
      {
        name: input.name,
        projectId: input.projectId,
        ...cadenceOf(input),
        variables: input.variables,
      },
      { seriesId: id, templateId: input.promptTemplateId },
    );

    await prisma.series.update({
      where: { id },
      data: {
        name: input.name,
        channelId: input.channelId,
        projectId: input.projectId,
        promptTemplateId: input.promptTemplateId,
        format: input.format,
      },
    });
  }

  /** Stops the show. Delegated so pausing means exactly what it means for any
   *  other schedule — including that it cannot recall a run already in flight,
   *  which the page says out loud. */
  async pause(userId: string, id: string, reason?: string): Promise<void> {
    const { scheduleId } = await this.requireOwned(userId, id);

    await this.schedules.pause(userId, scheduleId, reason);
  }

  /** Restarts it from the next future occurrence — never by catching up on the
   *  ones it missed, and never into an empty queue. Both rules are
   *  `ScheduleService.resume`'s, unchanged. */
  async resume(userId: string, id: string): Promise<void> {
    const { scheduleId } = await this.requireOwned(userId, id);

    await this.schedules.resume(userId, scheduleId);
  }

  /**
   * Soft delete, matching every other user-owned entity here.
   *
   * The cadence goes with it, through `ScheduleService.remove` — passing the
   * series id as the owner, which is what that method's guard is looking for.
   * Videos this show already produced keep their `seriesId` and are untouched:
   * deleting a show is the operator saying they are done commissioning
   * episodes, not that the episodes never happened.
   */
  async remove(userId: string, id: string): Promise<void> {
    const { scheduleId } = await this.requireOwned(userId, id);

    await this.schedules.remove(userId, scheduleId, { seriesId: id });

    await prisma.series.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * "Make one now" — the whole point of the feature, on demand.
   *
   * One action that applies everything the series already answered: the script
   * style writes it, the format shapes it, the project files it, the channel
   * brands it, the stored variables direct it, and the topic comes off the same
   * queue a scheduled run draws from. The operator answers nothing.
   *
   * It is the identical call the tick path makes — `automationService.start`
   * with the same three options — so a video made by hand from a series and a
   * video made by its schedule are configured the same way by construction
   * rather than by two code paths agreeing.
   *
   * Three properties it shares with the scheduled path deliberately:
   *
   *   1. **It refuses before spending.** The same readiness blockers, checked
   *      before the first billed call.
   *   2. **It does not invent a topic.** An empty queue is a refusal, not a
   *      prompt to a model asking what this show should cover this week.
   *   3. **It stops at a queued video.** No `Publication`, no PUBLISHED. The
   *      operator's own publish click is still the only thing that reaches an
   *      audience.
   *
   * The topic is consumed before the model is called and stays consumed if the
   * run then fails, for the reason `ScheduleService.takeNextTopic` documents:
   * `start` can fail after a script has been generated and billed. The error
   * names the topic so it can be re-queued in one paste.
   */
  async generateNow(userId: string, id: string): Promise<SeriesRunResult> {
    const series = await this.requireOwned(userId, id);

    const setup = await this.automation.getSetup(userId);

    if (setup.blockers.length > 0) {
      throw new ConflictError(
        `This account isn't ready to generate a video yet: ${setup.blockers
          .map((blocker) => blocker.title.toLowerCase())
          .join(", ")}.`,
      );
    }

    const topic = await this.schedules.takeNextTopic(series.scheduleId);

    if (!topic) {
      throw new ConflictError(
        "This series has no topics left. Nothing here invents a subject, so add " +
          "one to the queue and it will make that.",
      );
    }

    try {
      const result = await this.automation.start(
        userId,
        {
          projectId: series.projectId,
          topic: topic.topic,
          variables: series.variables,
        },
        {
          templateId: series.promptTemplateId,
          format: series.format,
          seriesId: series.id,
        },
      );

      await this.recordManualRun(userId, series.name, result.videoId, topic.topic);

      return {
        videoId: result.videoId,
        title: result.title,
        topic: topic.topic,
      };
    } catch (error) {
      // Only a typed error's message is repeated back. `ProviderError` and the
      // rest of the hierarchy carry sentences an operator can act on ("Anthropic
      // rejected the key"); anything else is a driver message, and `run()`
      // deliberately never lets one reach the browser — so it is rethrown
      // untouched and reported as an internal error, exactly as the guided flow
      // reports the same failure.
      if (!isAppError(error)) {
        throw error;
      }

      throw new ConflictError(
        `${error.message} The topic "${topic.topic}" has been taken off the ` +
          "queue — add it again to retry.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Shared guards
  // ---------------------------------------------------------------------------

  /**
   * Every read and write above goes through here or an equivalent `userId`
   * predicate. A series spends the owner's money on a timer; addressing one by
   * id must never be enough.
   */
  private async requireOwned(userId: string, id: string) {
    const series = await prisma.series.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        format: true,
        projectId: true,
        promptTemplateId: true,
        schedule: { select: { id: true, variables: true } },
      },
    });

    if (!series?.schedule) {
      throw new NotFoundError("Series");
    }

    return {
      id: series.id,
      name: series.name,
      format: series.format,
      projectId: series.projectId,
      promptTemplateId: series.promptTemplateId,
      scheduleId: series.schedule.id,
      variables: readVariables(series.schedule.variables),
    };
  }

  /**
   * Everything a recipe has to be true about before it is written down.
   *
   * The channel/project agreement is the interesting one. A series stores both,
   * and the brand every episode is made with is resolved by the renderer
   * through `video -> project -> channel` — so a series naming channel A while
   * filing its videos in a project that publishes to channel B would show one
   * brand on screen and use another in the render. That is the exact failure
   * mode the whole "which value is winning" question is about, so the two are
   * required to agree here rather than being reconciled later.
   */
  private async assertRecipe(
    userId: string,
    input: CreateSeriesInput | UpdateSeriesInput,
  ): Promise<void> {
    const [channel, project] = await Promise.all([
      prisma.channel.findFirst({
        where: { id: input.channelId, userId, deletedAt: null },
        select: { id: true, title: true },
      }),
      prisma.project.findFirst({
        where: { id: input.projectId, userId, deletedAt: null, status: "ACTIVE" },
        select: { id: true, name: true, channelId: true },
      }),
    ]);

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    if (!project) {
      throw new NotFoundError("Project");
    }

    if (project.channelId !== channel.id) {
      throw new ValidationError(
        `The project "${project.name}" does not publish to ${channel.title}, so its ` +
          "videos would be branded by a different channel than this series says. " +
          "Pick a project that publishes to this channel, or change the project's " +
          "channel first.",
      );
    }

    // Throws `NotFoundError` for a style that is unknown, soft-deleted or
    // somebody else's, and `ValidationError` for one that is not a SCRIPT
    // prompt. Its return value is what the answers below are reconciled
    // against, which is the whole reason it is fetched rather than merely
    // checked for existence.
    const prompt = await this.automation.describeScriptStyle(
      userId,
      input.promptTemplateId,
    );

    const declared = prompt.duration ? [...prompt.fields, prompt.duration] : prompt.fields;

    const missing = declared
      .filter(
        (field) =>
          field.required &&
          !field.defaultValue &&
          !(input.variables[field.key] ?? "").trim(),
      )
      .map((field) => field.label);

    if (missing.length > 0) {
      throw new ValidationError(
        `"${prompt.name}" needs ${missing.length === 1 ? "an answer" : "answers"} for: ${missing.join(", ")}.`,
      );
    }
  }

  /**
   * The durable record that a human pressed the button, as opposed to a
   * schedule coming due.
   *
   * `ScheduleRun` is deliberately not used for this. Every row in that table is
   * *an occurrence of the cadence* — that is what makes "why was there no video
   * on the 3rd?" answerable — and an on-demand run is not an occurrence of
   * anything. Writing one would put a row in the history at a time the
   * recurrence never named, and would compete for the
   * `[scheduleId, scheduledFor]` unique key with a real occurrence. An
   * `ActivityLog` row instead, the same way `AutomationService` discloses its
   * automatic approval, and the video itself carries `seriesId` so the show's
   * own video list shows it either way.
   *
   * Best-effort: the video is already queued by the time this runs, and failing
   * the call over a log write would report a failure for a run that succeeded.
   */
  private async recordManualRun(
    userId: string,
    seriesName: string,
    videoId: string,
    topic: string,
  ): Promise<void> {
    try {
      await prisma.activityLog.create({
        data: {
          userId,
          action: "series.generateNow",
          entityType: "Video",
          entityId: videoId,
          message:
            `Made on demand from the "${seriesName}" series — its script style, ` +
            `format and channel brand were applied without being re-asked, and ` +
            `"${topic}" was taken off its topic queue. Publishing still requires ` +
            "an explicit click.",
        },
      });
    } catch (error) {
      console.error(
        `Could not record the on-demand run of series "${seriesName}" for video ${videoId}:`,
        error,
      );
    }
  }

  private toSummary(
    row: {
      id: string;
      name: string;
      format: VideoFormat;
      channelId: string;
      channel: { title: string };
      projectId: string;
      project: { name: string };
      promptTemplateId: string;
      promptTemplate: { name: string };
      _count: { videos: number };
    },
    schedule: {
      id: string;
      status: ScheduleStatus;
      pausedReason: string | null;
      frequency: ScheduleFrequency;
      dayOfWeek: number | null;
      dayOfMonth: number | null;
      hour: number;
      minute: number;
      timeZone: string;
      nextRunAt: Date | null;
      topics: { topic: string }[];
      _count: { topics: number };
    },
  ): SeriesSummary {
    return {
      id: row.id,
      name: row.name,
      format: row.format,
      channelId: row.channelId,
      channelTitle: row.channel.title,
      projectId: row.projectId,
      projectName: row.project.name,
      scriptStyleId: row.promptTemplateId,
      scriptStyleName: row.promptTemplate.name,
      scheduleId: schedule.id,
      status: schedule.status,
      pausedReason: schedule.pausedReason,
      cadence: describeRecurrence({
        frequency: schedule.frequency,
        dayOfWeek: schedule.dayOfWeek,
        dayOfMonth: schedule.dayOfMonth,
        hour: schedule.hour,
        minute: schedule.minute,
        timeZone: schedule.timeZone,
      }),
      nextRunAt: schedule.nextRunAt,
      queuedTopicCount: schedule._count.topics,
      nextTopic: schedule.topics[0]?.topic ?? null,
      videoCount: row._count.videos,
    };
  }
}

/**
 * Narrows a `Json` column back to the string map it was written from. Same
 * defence, and the same reasoning, as `ScheduleService`'s own copy: the column
 * is only ever written through a validated schema, but it is a `Json` column on
 * a database an operator can reach with a SQL client.
 */
function readVariables(value: unknown): Record<string, string> {
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

/**
 * The two gaps between "the guided flow can run" and "a series can be created".
 *
 * The guided flow needs a project; a series needs a project that publishes to a
 * channel, because a series with no channel would inherit no brand and the
 * screen would have nothing truthful to show in its "from the channel" panel.
 * And a series names a script style explicitly, so an operator with no SCRIPT
 * template at all has nothing to point it at — a state `getSetup`'s own
 * `check-prompt-template` blocker only catches when they have no *default*.
 *
 * Both reuse an existing checklist step's id and link, so the readiness notice
 * needs no special case for them.
 */
function withSeriesBlockers(
  blockers: AutomationBlocker[],
  projects: { channelId: string | null }[],
  scriptStyles: AutomationScriptStyle[],
): AutomationBlocker[] {
  const extra: AutomationBlocker[] = [];

  if (
    !blockers.some((blocker) => blocker.id === "create-project") &&
    !projects.some((project) => project.channelId !== null)
  ) {
    extra.push({
      id: "create-project",
      title: "Point a project at a channel",
      description:
        "A series takes its look, voice, music and audience declaration from a " +
        "channel, and it finds that channel through the project its videos are " +
        "filed in. None of your projects publishes to one yet.",
      href: "/projects",
    });
  }

  if (
    !blockers.some((blocker) => blocker.id === "check-prompt-template") &&
    scriptStyles.length === 0
  ) {
    extra.push({
      id: "check-prompt-template",
      title: "Add a script style",
      description:
        "A series names the script style that writes every episode. Add one from " +
        "the catalogue in the prompt library, or write your own.",
      href: "/prompts",
    });
  }

  return [...blockers, ...extra];
}

export const seriesService = new SeriesService();
