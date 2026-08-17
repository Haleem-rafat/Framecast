import "server-only";

import {
  withDismissed,
  withEverythingRestored,
  withRestored,
} from "@/features/onboarding/dismissal";
import type {
  OnboardingChecklist,
  OnboardingProgress,
  OnboardingReader,
  OnboardingStep,
} from "@/features/onboarding/types";
import { prisma } from "@/lib/prisma";

/**
 * Read model for the "getting started" checklist, plus the small amount of
 * state onboarding keeps about a person.
 *
 * ## What the checklist is for
 *
 * Getting one operator from an empty account to a video on their own YouTube
 * channel, in the order the app actually imposes. Each step is a single
 * existence check against the table that step's action writes to — cheap,
 * indexed `findFirst`s rather than loading full rows, run in parallel. Every
 * query is scoped by `userId`, matching the rest of this service layer.
 *
 * ## Why these steps and not the old ones
 *
 * The previous list ended at "approve the script", and said so out loud on the
 * dashboard: voice, footage and publishing were described as unbuilt. All three
 * ship. It also spent three of its seven rows walking the operator through the
 * manual video path — create a video, generate a script, approve the script —
 * which is now the long way round: `/automation/generate` does all three in one
 * press, and that press is the single most common reason anyone opens this app.
 * So those three rows collapse into one "make your first video", and the two
 * rows they freed go to the things the checklist never mentioned and the
 * pipeline genuinely needs: what the channel is *about*, and getting the
 * finished file onto YouTube.
 *
 * ## The four ids that are not free to rename
 *
 * `connect-channel`, `add-narration-key`, `check-prompt-template` and
 * `create-project` are read back by `AutomationService.getBlockers` (and
 * through it by easy mode, schedules and series) to decide whether an account
 * can run at all. They are this app's preconditions expressed once: a step in
 * the checklist and a refusal on the generate screen are the same fact. Adding
 * a step here is safe; renaming one of those four silently empties a gate.
 */
export class OnboardingService implements OnboardingReader {
  async getChecklist(userId: string): Promise<OnboardingChecklist> {
    const notDeleted = { userId, deletedAt: null };

    const [
      channel,
      brandedChannel,
      hasNarrationKey,
      hasDefaultScriptPrompt,
      hasProject,
      hasVideo,
      publishedVideo,
    ] = await Promise.all([
      // The row itself, not just its existence: the branding step below links
      // to a specific channel's page, and there is no such page to link to
      // until one is connected.
      prisma.channel.findFirst({
        where: notDeleted,
        orderBy: { connectedAt: "asc" },
        select: { id: true },
      }),
      // A `ChannelBrand` row on its own proves nothing — the brand form
      // upserts one the first time any group on that screen is saved, so a
      // channel whose logo was uploaded and nothing else would tick a step
      // about what the channel is *about*. Niche and tone are the two fields
      // the script and the footage search actually read (see
      // `BrandService.forRender`), so one of them being set is the honest
      // test.
      prisma.channelBrand.findFirst({
        where: {
          channel: notDeleted,
          OR: [{ NOT: { niche: null } }, { NOT: { tone: null } }],
        },
        select: { id: true },
      }),
      // Same predicate ProviderCredentialService.resolveKey uses at narration
      // time — an inactive or soft-deleted credential resolves to null there,
      // so counting one here would tick a box the pipeline then fails on.
      prisma.providerCredential.findFirst({
        where: { userId, provider: "ELEVENLABS", deletedAt: null, isActive: true },
        select: { id: true },
      }),
      prisma.promptTemplate.findFirst({
        where: { ...notDeleted, category: "SCRIPT", isDefault: true },
        select: { id: true },
      }),
      prisma.project.findFirst({ where: notDeleted, select: { id: true } }),
      prisma.video.findFirst({ where: notDeleted, select: { id: true } }),
      // PUBLISHED specifically, not "a Publication row exists". A FAILED row is
      // kept forever as the record that an attempt happened (see the
      // Publication model), so counting any row would tick the last step of
      // onboarding on the strength of an upload that never landed.
      //
      // No `userId` column on Publication — reach it through the video, scoped
      // to this operator's non-deleted rows exactly as the script check does.
      prisma.publication.findFirst({
        where: { status: "PUBLISHED", video: notDeleted },
        select: { id: true },
      }),
    ]);

    const steps: OnboardingStep[] = [
      {
        id: "connect-channel",
        title: "Connect a YouTube channel",
        description: "Framecast uploads to it, and reads its stats back.",
        href: "/channels",
        complete: channel !== null,
      },
      {
        id: "describe-brand",
        title: "Say what the channel is about",
        description:
          "Its niche and tone steer every script, voice and footage search.",
        // The channel's own page when there is one, the list when there is
        // not. A first-run operator clicking this before step one would
        // otherwise land on a 404 built from an id that does not exist.
        href: channel ? `/channels/${channel.id}` : "/channels",
        complete: brandedChannel !== null,
      },
      {
        id: "add-narration-key",
        title: "Add your ElevenLabs API key",
        description: "Narration needs it — a run without one fails partway.",
        href: "/providers",
        complete: hasNarrationKey !== null,
      },
      {
        id: "check-prompt-template",
        title: "Pick a default script style",
        description: "The prompt every script is written from, until you change it.",
        href: "/prompts",
        complete: hasDefaultScriptPrompt !== null,
      },
      {
        id: "create-project",
        title: "Create a project",
        description: "Videos live in a project, and it decides where they publish.",
        href: "/projects",
        complete: hasProject !== null,
      },
      {
        id: "make-video",
        title: "Make your first video",
        description: "Pick a channel and a subject; Framecast does the rest.",
        href: "/automation/generate",
        complete: hasVideo !== null,
      },
      {
        id: "publish-video",
        title: "Publish it to YouTube",
        description: "You choose the channel and the visibility. Nothing goes up on its own.",
        href: "/publishing",
        complete: publishedVideo !== null,
      },
    ];

    const completedCount = steps.filter((step) => step.complete).length;

    return {
      steps,
      completedCount,
      isComplete: completedCount === steps.length,
    };
  }

  /**
   * Read once per authenticated page render, alongside the appearance columns
   * the layout already fetches — so it is one indexed lookup on a unique key
   * and selects exactly one column.
   *
   * Reading is not consent to write, the same rule `SettingsService.get`
   * follows: an operator who has never dismissed anything has no `UserSetting`
   * row and does not get one from looking at a page.
   */
  async getProgress(userId: string): Promise<OnboardingProgress> {
    const row = await prisma.userSetting.findUnique({
      where: { userId },
      select: { onboardingSeen: true },
    });

    return { dismissed: row?.onboardingSeen ?? [] };
  }

  /**
   * Read-modify-write rather than a Postgres `array_append`, because the
   * upsert has to cope with there being no row at all — the common case, since
   * a `UserSetting` is only created on first save of anything. The race two
   * tabs could lose here is "one of two dismissals is forgotten", whose entire
   * consequence is that a hint appears once more.
   */
  async dismiss(userId: string, key: string): Promise<OnboardingProgress> {
    const { dismissed } = await this.getProgress(userId);
    const next = withDismissed(dismissed, key);

    const row = await prisma.userSetting.upsert({
      where: { userId },
      create: { userId, onboardingSeen: next },
      update: { onboardingSeen: next },
      select: { onboardingSeen: true },
    });

    return { dismissed: row.onboardingSeen };
  }

  async restore(
    userId: string,
    keys?: readonly string[],
  ): Promise<OnboardingProgress> {
    const { dismissed } = await this.getProgress(userId);
    const next = keys
      ? withRestored(dismissed, keys)
      : withEverythingRestored();

    // Nothing to forget and no row to forget it in. Writing here would create
    // a `UserSetting` for an operator who has never saved a setting, purely to
    // record an empty array that is already the default.
    if (dismissed.length === 0 && next.length === 0) {
      return { dismissed: [] };
    }

    const row = await prisma.userSetting.upsert({
      where: { userId },
      create: { userId, onboardingSeen: next },
      update: { onboardingSeen: next },
      select: { onboardingSeen: true },
    });

    return { dismissed: row.onboardingSeen };
  }
}

/**
 * Composition point. Consumers depend on `OnboardingReader`, never on which
 * implementation is bound.
 */
export const onboardingService: OnboardingReader = new OnboardingService();
