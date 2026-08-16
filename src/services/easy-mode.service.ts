import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { starterSubjectsForStyleName } from "@/lib/script-styles";
import type { StartEasyVideoInput } from "@/schemas/easy-mode.schema";
import {
  automationService,
  type AutomationBlocker,
  type AutomationField,
  type AutomationProject,
  type AutomationPromptSummary,
  type AutomationResult,
  type AutomationService,
} from "@/services/automation.service";
import { brandService, type ResolvedBrand } from "@/services/brand.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider } from "@/services/providers/types";

/**
 * Easy mode: a whole video from two taps and no typing.
 *
 * ## What it is
 *
 * `AutomationService` already reduced "make a video" from five screens to one
 * form. The form is still four written answers — a topic to invent, a value per
 * variable the operator's script prompt declares, and a length — and the
 * operator's complaint was precisely that: *"just select, not write anything"*.
 *
 * So this service answers those questions from data that already exists, and
 * leaves the operator two choices: **which channel**, and **which subject**.
 * It owns no pipeline logic whatsoever — `start()` below assembles an ordinary
 * `StartAutomationInput` and hands it to `automationService.start`, which
 * performs the identical create/generate/approve sequence with the identical
 * readiness checks, duplicate guard and Gate 1 disclosure. Easy mode cannot
 * produce a video the long form could not have produced; it can only produce it
 * with fewer keystrokes.
 *
 * ## The channel is the unit, not the project
 *
 * The long form asks for a *project*, because a project is what a `Video` row
 * points at. Easy mode asks for a *channel*, because a channel is what the
 * operator actually thinks in — it is where the video ends up, and it is the
 * row that carries the niche, tone, voice, art style and made-for-kids
 * declaration every stage downstream reads (`ChannelBrand`, via
 * `brandService.resolve`).
 *
 * The project is then derived from the channel, and derived in exactly one
 * direction: the most recently touched **active project whose `channelId` is
 * the chosen channel**. That constraint is not a nicety. `Project.channelId` is
 * what `PublishService.resolvePublishTarget` reads, and a video filed under a
 * project on a different channel is either refused at publish time or
 * silently refiled — after the render has been paid for. Picking "any project"
 * and hoping would put money behind a filing the publish path may reject, so a
 * channel with no project on it is reported as unusable *before* anything is
 * spent, with the reason and the page that fixes it.
 *
 * ## Nothing here is guessed
 *
 * Every derived value has a named provenance, carried on `EasyPlan` and shown
 * to the operator before the button is pressed. There are exactly four sources,
 * in priority order, and each is something the operator or the deployment has
 * already decided:
 *
 *   1. **A schedule on this channel.** `Schedule.variables` is a map of answers
 *      the operator typed for recurring videos on this very channel. If they
 *      told a weekly schedule to write eight-minute scripts for beginners, that
 *      is the best available answer to the same question here, and it is their
 *      own words.
 *   2. **The channel's brand.** `tone` and `niche` are columns an operator
 *      filled in on the channel page.
 *   3. **The prompt variable's own default.** Left *out* of the submitted map
 *      rather than copied into it, so `renderTemplate` applies the template's
 *      default itself — see `resolveVariables` in automation.service.ts.
 *   4. **`brandService.resolve`'s documented fallbacks**, for a channel with no
 *      brand row. See `describeChannel` for why that is neither a refusal nor a
 *      guess.
 *
 * A required variable that none of the four can answer is not invented. It is
 * reported on `EasyModeSetup.unanswerable`, and easy mode stands aside and
 * points at the written form — which is the only surface that can ask.
 */

/** The variable `scriptService.generate` fills from the video's own topic, and
 *  which `AutomationPromptSummary` therefore never lists. Named here only so the
 *  brand mapping below cannot accidentally claim it. */
const TOPIC_VARIABLE_KEY = "topic";

/**
 * How many subjects the picker offers at once, across all sources.
 *
 * A picker is only easier than a text box while it can be read at a glance on a
 * phone. Past a screenful the operator is scanning rather than choosing, which
 * is the same cognitive work typing was, with worse ergonomics.
 */
const MAX_SUBJECTS = 12;

/** How many of the operator's own queued topics may fill that budget. They rank
 *  first — they are the only subjects here the operator demonstrably wrote — but
 *  a long queue must not crowd out every other source, or a channel with a
 *  twenty-topic schedule would offer nothing else. */
const MAX_QUEUE_SUBJECTS = 6;

/** How many subjects one model call is asked for. Small on purpose: this is a
 *  paid call made before the operator has committed to a video, so it buys a
 *  short list rather than a catalogue. */
const SUGGESTION_COUNT = 6;

/**
 * How far back the "you have already covered this" filter looks.
 *
 * Suggestions are checked against the video titles and topics already on this
 * channel, because the most annoying possible suggestion is one the operator
 * made last week. Bounded rather than unbounded so the exclusion list handed to
 * the model stays short and the query stays an index scan.
 */
const RECENT_VIDEO_LIMIT = 40;

/**
 * Which prompt variables the channel's brand can answer, and with what.
 *
 * Deliberately a small, closed map rather than a fuzzy match. These three keys
 * are what the shipped catalogue declares (`script-styles.ts`) and what a prompt
 * derived from it will carry; anything else the operator invented means
 * something only they know, and filling it from a brand column that happens to
 * be nearby would be exactly the silent guessing this service exists not to do.
 *
 * `audience` is the one derivation rather than a copy. A niche ("personal
 * finance") is a subject, and the variable asks who is watching, so it is
 * phrased into one — visibly, in a form the operator reads back on the plan
 * before pressing the button.
 */
const BRAND_ANSWERS: Record<
  string,
  { value: (brand: ResolvedBrand) => string; describe: string }
> = {
  tone: {
    value: (brand) => brand.tone,
    describe: "the channel's tone",
  },
  niche: {
    value: (brand) => brand.niche,
    describe: "the channel's niche",
  },
  audience: {
    value: (brand) => `viewers interested in ${brand.niche}`,
    describe: "the channel's niche",
  },
};

/** Where one offered subject came from. The picker renders these differently
 *  and labels every one of them — see `EasySubject.origin`. */
export type EasySubjectOrigin =
  /** The operator wrote it into a schedule's queue. Theirs, verbatim. */
  | "queue"
  /** A model wrote it, just now, from this channel's niche. */
  | "suggested"
  /** It ships with Framecast, attached to a script style. */
  | "starter";

export interface EasySubject {
  /**
   * Stable within one list, and never a database id — a `ScheduleTopic.id`
   * leaking into a form the browser posts back would invite a client to name a
   * queue row it should not be able to address. The topic text is the only
   * thing `start()` accepts, and it is re-validated there like any other topic.
   */
  key: string;
  topic: string;
  origin: EasySubjectOrigin;
  /**
   * Where exactly, in the operator's terms: `Queued in "Weekly finance"`,
   * `Written for personal finance`, `Ships with Default script`.
   *
   * Never optional and never blank. The one rule this whole surface turns on is
   * that a subject the operator did not write must not be indistinguishable
   * from one they did, and a badge with no text is indistinguishable.
   */
  originLabel: string;
}

/** One answered question, as the plan shows it back before the run. */
export interface EasyDerivedAnswer {
  label: string;
  value: string;
  /** Where the value came from, in one short phrase. */
  source: string;
  /**
   * True when the value is a deployment fallback rather than anything the
   * operator chose — the state every unbranded channel is in. The plan marks
   * these; nothing else about the run changes.
   */
  isFallback: boolean;
}

/**
 * Everything easy mode decided for one channel, so it can be shown before it
 * is acted on rather than discovered afterwards.
 */
export interface EasyPlan {
  projectId: string;
  projectName: string;
  channelTitle: string;
  promptName: string;
  /** One sentence naming the whole plan, for the operator who reads nothing
   *  else. The detail below it is for the one who opens it. */
  summary: string;
  answers: EasyDerivedAnswer[];
  /**
   * Required questions the operator's prompt asks that easy mode cannot answer
   * from any of its four sources. Non-empty means easy mode refuses to run this
   * channel and says which form can.
   */
  unanswerable: string[];
}

export interface EasyChannel {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  /** Resolved, so always a usable string — the fallback when there is no brand
   *  row, which `hasBrand` distinguishes. */
  niche: string;
  tone: string;
  /** False for a channel with no `ChannelBrand` row at all. The card says so
   *  and links to the page that fixes it; the run is not refused. */
  hasBrand: boolean;
  /**
   * The plan for this channel, or null when there is none to make — which today
   * means only "no active project points at this channel". Null is what makes a
   * channel card unusable, and `blockedReason` says why in the operator's terms.
   */
  plan: EasyPlan | null;
  blockedReason: string | null;
  /**
   * The free subjects on offer for this channel, resolved on the server so
   * switching channel in the picker is instant and costs nothing. Model-written
   * suggestions are never in here — those arrive only from `suggest()`, only
   * when the operator asks, and the picker keeps them visibly apart.
   */
  subjects: EasySubject[];
}

/**
 * An `EasyChannel` plus the map that would actually be submitted for it.
 *
 * Internal, and stripped by `getSetup` before anything reaches the browser.
 * `answers` is the operator-facing account of what was decided; `variables` is
 * the machine-facing one and the two differ in a way that matters — a value
 * supplied by the template's own default appears in `answers` and is
 * deliberately *absent* from `variables`, so `renderTemplate` remains the
 * authority on its own defaults. Sending both to a client that can submit
 * neither would only invite somebody to wire the wrong one up later.
 */
interface PlannedChannel extends EasyChannel {
  variables: Record<string, string>;
}

export interface EasyModeSetup {
  /** The same preconditions `AutomationService` refuses to run without, read
   *  from the same place so the two surfaces cannot disagree about whether an
   *  account is ready. */
  blockers: AutomationBlocker[];
  channels: EasyChannel[];
  /** Null exactly when `blockers` carries `check-prompt-template`. */
  prompt: AutomationPromptSummary | null;
  /**
   * Passed straight through from `AutomationService.getSetup`, so the page can
   * render the written form from the same read.
   *
   * Carried here rather than fetched again by the route for one reason that is
   * not performance: two independent reads can disagree, and the disagreement
   * this one would produce is a page whose easy tab believes the account is
   * ready and whose written tab does not — or, worse, a written form offering a
   * project that was archived between the two calls.
   */
  projects: AutomationProject[];
}

/** What one round of model suggestions produced, including the honest empty
 *  answer. */
export interface EasySuggestions {
  subjects: EasySubject[];
  /** Null on success. Set when the call failed or came back unusable, so the
   *  UI can say "that did not work" rather than "there are no ideas". */
  error: string | null;
}

export class EasyModeService {
  /**
   * Two seams, and both exist for the same reason `AutomationService` takes a
   * `ScriptService`: every path through this file either bills the operator or
   * refuses to, and a test must be able to drive both without an API key.
   *
   * `automation` is `Pick<…, "start">` rather than the whole class — this
   * service calls exactly one method on it, and typing the parameter as
   * `AutomationService` would force every test to stub `getSetup`, `getRun` and
   * the rest to construct one.
   */
  constructor(
    private readonly suggester: Pick<
      TextGenerationProvider,
      "generateScript"
    > = gatewayProvider,
    private readonly automation: Pick<AutomationService, "start"> = automationService,
  ) {}

  /**
   * Everything the easy-mode screen needs to render itself, in one call.
   *
   * Deliberately makes **no model call**. Opening the page must be free: an
   * operator who lands here, looks, and leaves has not been billed, and a
   * suggestion that costs money is only ever produced by an explicit tap on
   * `suggest()`. That is also what keeps this page's latency the handful of
   * indexed lookups the route's own comment promises.
   */
  async getSetup(userId: string): Promise<EasyModeSetup> {
    const setup = await automationService.getSetup(userId);

    // No prompt means the account is not ready at all — `getSetup` reports that
    // as a blocker and there is nothing to derive answers *for*, so there is no
    // point resolving brands for channels that cannot run.
    const prompt = setup.prompt;

    if (!prompt) {
      return {
        blockers: setup.blockers,
        channels: [],
        prompt: null,
        projects: setup.projects,
      };
    }

    const channels = await prisma.channel.findMany({
      where: { userId, deletedAt: null, isActive: true },
      orderBy: { connectedAt: "desc" },
      // `title` and `thumbnailUrl` only, never the token columns — the same
      // discipline `channelService.list` keeps with `SUMMARY_SELECT`.
      select: { id: true, title: true, thumbnailUrl: true },
    });

    const described = await Promise.all(
      channels.map((channel) => this.describeChannel(userId, channel, prompt)),
    );

    return {
      blockers: setup.blockers,
      // `variables` is dropped here rather than never built: `describeChannel`
      // is shared with `start()`, which needs it.
      channels: described.map(withoutVariables),
      prompt,
      projects: setup.projects,
    };
  }

  /**
   * The subjects on offer for one channel, free of charge.
   *
   * Two sources, both already paid for: the operator's own unconsumed schedule
   * topics for this channel, and the catalogue's starters for their script
   * style. Ranked in that order, because the first is the operator's own
   * writing and the second is a stranger's.
   *
   * ## Reading a queue is not taking from it
   *
   * The queue rows are **read and never written**. `ScheduleTopic.consumedAt`
   * is set in exactly one place — `ScheduleService.executeClaim`, inside the
   * atomic take — and offering a topic here must not race with, pre-empt or
   * empty that queue: the schedule still owns every row, and an operator who
   * makes a video by hand this afternoon must still get the Monday video they
   * asked for. Nothing in this method or in `start()` touches `consumedAt`,
   * which is the point of `EasySubject` carrying only the topic *text*.
   *
   * The cost of that decision is a real one and is disclosed rather than
   * designed away: picking a queued subject here means the schedule will write
   * a second script on the same subject when its turn comes. The picker says so
   * on the card, because the alternative — consuming the row — would silently
   * edit a schedule the operator did not open.
   */
  async listSubjects(userId: string, channelId: string): Promise<EasySubject[]> {
    const setup = await automationService.getSetup(userId);

    return this.collectFreeSubjects(userId, channelId, setup.prompt);
  }

  /** `listSubjects` with the prompt already resolved, so the callers that
   *  already hold one (`getSetup` for every channel at once, `suggest` before
   *  its model call) do not re-derive it per channel. */
  private async collectFreeSubjects(
    userId: string,
    channelId: string,
    prompt: AutomationPromptSummary | null,
  ): Promise<EasySubject[]> {
    const queued = await prisma.scheduleTopic.findMany({
      where: {
        consumedAt: null,
        schedule: {
          userId,
          deletedAt: null,
          project: { channelId, deletedAt: null },
        },
      },
      // Most imminent schedule first, then queue order — so the topic that is
      // genuinely next in line is the first one offered.
      orderBy: [{ schedule: { nextRunAt: "asc" } }, { position: "asc" }],
      take: MAX_QUEUE_SUBJECTS,
      select: { id: true, topic: true, schedule: { select: { name: true } } },
    });

    const subjects: EasySubject[] = queued.map((row) => ({
      key: `queue:${row.id}`,
      topic: row.topic,
      origin: "queue" as const,
      originLabel: `Queued in "${row.schedule.name}"`,
    }));

    const seen = new Set(subjects.map((subject) => normalise(subject.topic)));

    for (const [index, topic] of starterSubjectsForStyleName(
      prompt?.name ?? "",
    ).entries()) {
      if (subjects.length >= MAX_SUBJECTS) break;
      if (seen.has(normalise(topic))) continue;

      seen.add(normalise(topic));
      subjects.push({
        key: `starter:${index}`,
        topic,
        origin: "starter",
        originLabel: prompt
          ? `Ships with Framecast for "${prompt.name}"-style videos`
          : "Ships with Framecast",
      });
    }

    return subjects;
  }

  /**
   * Fresh subjects written for this channel's niche, from one model call.
   *
   * ## Why this is a button and not part of the page load
   *
   * It costs money. Not much — one short completion, orders of magnitude
   * cheaper than the script it might lead to — but it is spent *before* the
   * operator has committed to anything, and a page that quietly billed an
   * account every time it was opened would be a page nobody could afford to
   * browse. So it is an explicit tap, on a button that says what it costs, and
   * the page is complete and useful without it.
   *
   * ## Why it exists at all
   *
   * The free sources have a floor they cannot rise above. A channel with no
   * schedule has no queue, and the catalogue's starters were written without
   * knowing whose channel they would land on — offered to a personal finance
   * channel they are noise, and an operator who finds nothing they would
   * actually publish goes back to typing, which is the whole failure this mode
   * exists to prevent. This is the only source that knows what the channel is
   * about.
   *
   * ## Never throws
   *
   * A provider outage, a rate limit, or a model that answered in prose all
   * resolve to `{ subjects: [], error }`. Suggestions are an enhancement to a
   * picker that already works; nothing here may take away the subjects the free
   * sources already produced.
   */
  async suggest(userId: string, channelId: string): Promise<EasySuggestions> {
    try {
      const setup = await automationService.getSetup(userId);

      if (!setup.prompt) {
        return {
          subjects: [],
          error: "There is no default script prompt to write suggestions for.",
        };
      }

      const channel = await prisma.channel.findFirst({
        where: { id: channelId, userId, deletedAt: null },
        select: { id: true, title: true },
      });

      if (!channel) {
        throw new NotFoundError("Channel");
      }

      const brand = await brandService.resolve(channel.id);
      const [onOffer, covered] = await Promise.all([
        this.collectFreeSubjects(userId, channelId, setup.prompt),
        this.listCoveredTopics(userId, channelId),
      ]);

      const avoid = [...onOffer.map((subject) => subject.topic), ...covered];

      const apiKey =
        (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ?? undefined;

      const result = await this.suggester.generateScript({
        prompt: buildSuggestionPrompt({
          niche: brand.niche,
          tone: brand.tone,
          styleName: setup.prompt.name,
          avoid,
        }),
        apiKey,
      });

      const seen = new Set(avoid.map(normalise));
      const subjects: EasySubject[] = [];

      for (const topic of parseSuggestions(result.content)) {
        if (subjects.length >= SUGGESTION_COUNT) break;
        if (seen.has(normalise(topic))) continue;

        seen.add(normalise(topic));
        subjects.push({
          key: `suggested:${subjects.length}`,
          topic,
          origin: "suggested",
          originLabel: `Written just now for ${brand.niche}`,
        });
      }

      if (subjects.length === 0) {
        return {
          subjects: [],
          error:
            "The model answered with nothing usable. Try again, or write your own subject.",
        };
      }

      return { subjects, error: null };
    } catch (error) {
      console.error(
        `Easy mode could not suggest subjects for channel ${channelId}:`,
        error,
      );

      return {
        subjects: [],
        error:
          "Could not reach the model for suggestions. The subjects already listed still work.",
      };
    }
  }

  /**
   * Make the video.
   *
   * This is a thin, deliberate wrapper. It re-derives the plan server-side —
   * never trusting a project id, a duration or a tone from the browser, none of
   * which easy mode's payload even carries — and then calls
   * `automationService.start` with an ordinary input. Every guarantee that
   * method makes is therefore made here unchanged: the readiness re-check
   * before any spend, the duplicate-submission guard, the cleanup of a draft
   * whose generation failed, Gate 1 crossed *and disclosed* in an
   * `ActivityLog` row, and Gate 2 — publishing — not crossed at all.
   *
   * The plan is re-derived rather than passed in for one specific reason beyond
   * the usual "a server action is a public endpoint": the plan the operator read
   * was computed when the page loaded, and a project can be archived or refiled
   * between then and the tap. Deriving again here means the video is filed
   * against what is true at the moment it is created, or refused — it can never
   * be filed against a project that has since stopped belonging to the chosen
   * channel, which is the state `PublishService.resolvePublishTarget` exists to
   * refuse.
   */
  async start(userId: string, input: StartEasyVideoInput): Promise<AutomationResult> {
    const setup = await automationService.getSetup(userId);

    if (!setup.prompt) {
      throw new ConflictError(
        "There is no default script prompt to write this video with. Set one in your prompt library first.",
      );
    }

    const channel = await prisma.channel.findFirst({
      where: { id: input.channelId, userId, deletedAt: null },
      select: { id: true, title: true, thumbnailUrl: true },
    });

    if (!channel) {
      throw new NotFoundError("Channel");
    }

    const described = await this.describeChannel(userId, channel, setup.prompt);

    if (!described.plan) {
      throw new ConflictError(
        described.blockedReason ??
          `Nothing on ${channel.title} can take a video yet.`,
      );
    }

    if (described.plan.unanswerable.length > 0) {
      throw new ConflictError(
        `Your "${setup.prompt.name}" prompt requires an answer for ` +
          `${described.plan.unanswerable.join(", ")}, and nothing on this channel ` +
          `supplies one. Write this video on the full form instead, where you can ` +
          `answer it.`,
      );
    }

    return this.automation.start(userId, {
      projectId: described.plan.projectId,
      topic: input.topic.trim(),
      variables: described.variables,
    });
  }

  /**
   * One channel, with its brand resolved, its project derived and its plan
   * made.
   *
   * ## The no-brand decision
   *
   * Every production channel on this deployment has no `ChannelBrand` row, so
   * this is the *normal* case rather than an edge one, and there were three
   * things it could have done.
   *
   * Refusing is honest and useless: it would mean easy mode does not work for
   * anybody, on the grounds that a form the operator would have to fill in
   * first is missing.
   *
   * Guessing is worse. Inventing a niche from a channel's title, or a tone from
   * its description, would put a value the operator never wrote behind a script
   * they paid for.
   *
   * What it does instead is neither. `brandService.resolve` returns documented
   * fallbacks for an unbranded channel — `"general interest"`, `"clear and
   * factual"` — and those fallbacks **are already in effect**: metadata
   * generation, music selection and the render read them today, on every video
   * this channel has ever made, through the same call. Easy mode invents
   * nothing by using them; it uses the values the pipeline is using anyway. The
   * only thing it adds is *visibility* — `hasBrand: false` on this record, a
   * fallback mark on every answer that came from one, and a link to the page
   * that replaces them. An operator who does not care gets a video; one who
   * looks finds out, before spending, that their channel has never been
   * described.
   *
   * ## The no-project decision
   *
   * This one *is* a refusal, and the asymmetry is the point. A missing brand has
   * a defensible, already-live default. A missing project has none: a `Video`
   * needs a `projectId`, and any project not on this channel is one
   * `PublishService.resolvePublishTarget` will refuse or refile after the render
   * is paid for. There is no value to fall back to, so the channel is reported
   * unusable with the reason and the page that fixes it, before a click rather
   * than after a spend.
   *
   * Creating a project here was considered and rejected. A project is the
   * operator's own filing, and naming one on their behalf — silently, from a
   * screen they came to for a video — is the same class of act as inventing a
   * niche.
   */
  private async describeChannel(
    userId: string,
    channel: { id: string; title: string; thumbnailUrl: string | null },
    prompt: AutomationPromptSummary,
  ): Promise<PlannedChannel> {
    const brand = await brandService.resolve(channel.id);

    const [brandRow, project, scheduleVariables, subjects] = await Promise.all([
      prisma.channelBrand.findUnique({
        where: { channelId: channel.id },
        select: { id: true },
      }),
      // The one derivation that must never be loosened: active, this
      // operator's, and on *this channel*. Most recently touched, so the answer
      // is deterministic and matches the project `resolvePublishTarget` would
      // itself pick when refiling.
      prisma.project.findFirst({
        where: {
          userId,
          deletedAt: null,
          status: "ACTIVE",
          channelId: channel.id,
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, name: true },
      }),
      this.readScheduleAnswers(userId, channel.id),
      this.collectFreeSubjects(userId, channel.id, prompt),
    ]);

    const hasBrand = brandRow !== null;

    if (!project) {
      return {
        id: channel.id,
        title: channel.title,
        thumbnailUrl: channel.thumbnailUrl,
        niche: brand.niche,
        tone: brand.tone,
        hasBrand,
        plan: null,
        variables: {},
        subjects,
        blockedReason:
          `No active project publishes to ${channel.title}, and a video has to be ` +
          `filed in one. Point a project at this channel and it will appear here.`,
      };
    }

    const { variables, ...plan } = buildPlan({
      prompt,
      brand,
      hasBrand,
      scheduleVariables,
      channelTitle: channel.title,
      project,
    });

    return {
      id: channel.id,
      title: channel.title,
      thumbnailUrl: channel.thumbnailUrl,
      niche: brand.niche,
      tone: brand.tone,
      hasBrand,
      plan,
      variables,
      subjects,
      blockedReason: null,
    };
  }

  /**
   * The answers this operator already gave for recurring videos on this
   * channel.
   *
   * `Schedule.variables` is the same map the guided flow submits, typed by the
   * operator on the schedule form and stored against a project. Read from the
   * most imminent schedule on this channel — `nextRunAt` ascending, so the one
   * whose answers are about to be used for real is the one easy mode borrows —
   * and never written.
   *
   * Values are string-filtered rather than trusted: the column is `Json`, so a
   * hand-edited row could hold anything, and everything downstream of here
   * expects `Record<string, string>`.
   */
  private async readScheduleAnswers(
    userId: string,
    channelId: string,
  ): Promise<{ values: Record<string, string>; scheduleName: string } | null> {
    const schedule = await prisma.schedule.findFirst({
      where: {
        userId,
        deletedAt: null,
        status: "ACTIVE",
        project: { channelId, deletedAt: null },
      },
      orderBy: [{ nextRunAt: "asc" }, { updatedAt: "desc" }],
      select: { name: true, variables: true },
    });

    if (!schedule || typeof schedule.variables !== "object" || schedule.variables === null) {
      return null;
    }

    const values: Record<string, string> = {};

    for (const [key, value] of Object.entries(
      schedule.variables as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.trim()) {
        values[key] = value.trim();
      }
    }

    return Object.keys(values).length > 0
      ? { values, scheduleName: schedule.name }
      : null;
  }

  /**
   * Subjects this channel has already covered, so a suggestion is not one the
   * operator made last week.
   *
   * Topics rather than titles: `Video.title` is the derived working title and
   * `Video.generatedTitle` is written for an audience, but `Video.topic` is
   * what the script was actually about, which is what a duplicate suggestion
   * would duplicate. Soft-deleted videos are included on purpose — a subject
   * the operator made and then binned is one they have already judged.
   */
  private async listCoveredTopics(
    userId: string,
    channelId: string,
  ): Promise<string[]> {
    const videos = await prisma.video.findMany({
      where: { userId, project: { channelId } },
      orderBy: { createdAt: "desc" },
      take: RECENT_VIDEO_LIMIT,
      select: { topic: true },
    });

    return videos
      .map((video) => video.topic?.trim() ?? "")
      .filter((topic): topic is string => topic.length > 0);
  }
}

/**
 * Drops the submission map on the way out to the browser.
 *
 * Written field by field rather than as a rest-spread so that a field added to
 * `EasyChannel` later has to be added here too — the failure mode of `{ x, ...
 * rest }` is that a new internal-only field is forwarded to the client by
 * default, which is the wrong direction for a payload to fail in.
 */
function withoutVariables(channel: PlannedChannel): EasyChannel {
  return {
    id: channel.id,
    title: channel.title,
    thumbnailUrl: channel.thumbnailUrl,
    niche: channel.niche,
    tone: channel.tone,
    hasBrand: channel.hasBrand,
    plan: channel.plan,
    blockedReason: channel.blockedReason,
    subjects: channel.subjects,
  };
}

/**
 * Turns one prompt's declared questions into answers, and says where each came
 * from.
 *
 * The `variables` map it produces is what `AutomationService.start` receives,
 * and it obeys that method's own convention exactly: a variable answered by its
 * template's default is **omitted** rather than copied in, because
 * `renderTemplate` only falls back to a default when no value is supplied. The
 * plan still lists it — an inferred answer has to be a visible one — it is just
 * not sent, so the template stays the authority on its own defaults.
 */
function buildPlan(args: {
  prompt: AutomationPromptSummary;
  brand: ResolvedBrand;
  hasBrand: boolean;
  scheduleVariables: { values: Record<string, string>; scheduleName: string } | null;
  channelTitle: string;
  project: { id: string; name: string };
}): EasyPlan & { variables: Record<string, string> } {
  const { prompt, brand, hasBrand, scheduleVariables, channelTitle, project } = args;

  const declared: AutomationField[] = prompt.duration
    ? [...prompt.fields, prompt.duration]
    : prompt.fields;

  const variables: Record<string, string> = {};
  const answers: EasyDerivedAnswer[] = [];
  const unanswerable: string[] = [];

  for (const field of declared) {
    if (field.key === TOPIC_VARIABLE_KEY) continue;

    const fromSchedule = scheduleVariables?.values[field.key];

    if (scheduleVariables && fromSchedule) {
      variables[field.key] = fromSchedule;
      answers.push({
        label: field.label,
        value: fromSchedule,
        source: `your "${scheduleVariables.scheduleName}" schedule`,
        isFallback: false,
      });
      continue;
    }

    const brandAnswer = BRAND_ANSWERS[field.key];

    if (brandAnswer) {
      const value = brandAnswer.value(brand);
      variables[field.key] = value;
      answers.push({
        label: field.label,
        value,
        source: brandAnswer.describe,
        // An unbranded channel's tone and niche are `brandService.resolve`'s
        // fallbacks. The value is used either way — it is what the rest of the
        // pipeline uses — but it is marked, because "clear and factual" is a
        // sentence nobody on this account has ever written.
        isFallback: !hasBrand,
      });
      continue;
    }

    if (field.defaultValue) {
      // Deliberately not written into `variables`. See this function's comment.
      answers.push({
        label: field.label,
        value: field.defaultValue,
        source: "your script prompt's own default",
        isFallback: false,
      });
      continue;
    }

    if (field.required) {
      unanswerable.push(field.label);
    }
  }

  const durationField = prompt.duration;
  const durationAnswer = durationField
    ? answers.find((answer) => answer.label === durationField.label)
    : undefined;

  return {
    projectId: project.id,
    projectName: project.name,
    channelTitle,
    promptName: prompt.name,
    summary: [
      `Written with your "${prompt.name}" prompt`,
      durationAnswer ? `, about ${durationAnswer.value} minutes long` : "",
      `, filed in "${project.name}" on ${channelTitle}.`,
    ].join(""),
    answers,
    unanswerable,
    variables,
  };
}

/**
 * The one prompt this service sends, and the constraints that make its answers
 * usable.
 *
 * It asks for subjects, not titles: `{{topic}}` is substituted verbatim into
 * the operator's script prompt, so "10 SHOCKING facts about X" would produce a
 * script about a clickbait headline. And it is given the subjects already on
 * offer plus what the channel has already covered, because the cheapest way to
 * waste this call is to have it return the five things the operator is already
 * looking at.
 */
function buildSuggestionPrompt(args: {
  niche: string;
  tone: string;
  styleName: string;
  avoid: readonly string[];
}): string {
  const lines = [
    `Suggest ${SUGGESTION_COUNT} subjects for narrated explainer videos on a ` +
      `YouTube channel about: ${args.niche}.`,
    `The channel's voice is ${args.tone}. Each video is written with a script ` +
      `style called "${args.styleName}".`,
    "",
    "Rules:",
    "- Each entry is a SUBJECT, not a title. Write it the way somebody would " +
      "describe what a video is about: 'how index funds took over the stock " +
      "market', not '10 SHOCKING facts about index funds'.",
    "- One clear line each, under twenty words, no numbering and no quotation marks.",
    "- Specific enough that two of them could not be the same video.",
    "- Only subjects a narrated video over stock footage can carry. No tutorials, " +
      "no screen recordings, nothing that needs a chart or a diagram on screen.",
    "- Nothing that depends on this week's news; these are made days later.",
  ];

  if (args.avoid.length > 0) {
    lines.push(
      "",
      "Do not suggest any of these, or anything that is plainly the same video:",
      ...args.avoid.slice(0, 40).map((topic) => `- ${topic}`),
    );
  }

  lines.push(
    "",
    'Reply with JSON only, no prose: ["subject one", "subject two", ...]',
  );

  return lines.join("\n");
}

/**
 * Reads the model's answer, tolerantly.
 *
 * JSON first, because that is what the prompt asked for. A model that answered
 * with a bulleted list instead is not a failure worth throwing away a paid call
 * over, so the fallback strips the list markers and takes the lines. Anything
 * else yields nothing, and `suggest()` reports that as an error rather than as
 * an empty list of ideas.
 */
function parseSuggestions(content: string): string[] {
  const trimmed = content.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map(cleanSubject)
        .filter(isUsableSubject);
    }
  } catch {
    // Fall through to the line reader below.
  }

  return trimmed
    .split("\n")
    .map(cleanSubject)
    .filter(isUsableSubject);
}

/** Strips the decoration a model adds when it ignores "no numbering": leading
 *  bullets, `1.`, wrapping quotes, and a trailing comma from a JSON-ish line. */
function cleanSubject(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/,$/, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
}

/**
 * Bounds that match `startAutomationSchema`'s own topic limits, so a suggestion
 * the operator taps is one the server will accept. A model that returned a
 * paragraph produces a topic the action would reject after the tap, which reads
 * as the button being broken.
 */
function isUsableSubject(subject: string): boolean {
  return subject.length >= 3 && subject.length <= 300 && !subject.startsWith("[");
}

/** Case- and punctuation-insensitive comparison, so "How index funds took over"
 *  and "how index funds took over." are one subject rather than two. */
function normalise(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const easyModeService = new EasyModeService();
