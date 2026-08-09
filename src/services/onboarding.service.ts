import "server-only";

import type {
  OnboardingChecklist,
  OnboardingReader,
  OnboardingStep,
} from "@/features/onboarding/types";
import { prisma } from "@/lib/prisma";

/**
 * Read model for the "getting started" checklist. Each step is a single
 * existence check against the table that step's action writes to — cheap,
 * indexed `findFirst`s rather than loading full rows, run in parallel.
 * Every query is scoped by `userId`, matching the rest of this service layer.
 */
export class OnboardingService implements OnboardingReader {
  async getChecklist(userId: string): Promise<OnboardingChecklist> {
    const notDeleted = { userId, deletedAt: null };

    const [
      hasChannel,
      hasDefaultScriptPrompt,
      hasProject,
      hasVideo,
      hasScriptVersion,
      hasQueuedVideo,
    ] = await Promise.all([
      prisma.channel.findFirst({ where: notDeleted, select: { id: true } }),
      prisma.promptTemplate.findFirst({
        where: { ...notDeleted, category: "SCRIPT", isDefault: true },
        select: { id: true },
      }),
      prisma.project.findFirst({ where: notDeleted, select: { id: true } }),
      prisma.video.findFirst({ where: notDeleted, select: { id: true } }),
      // No direct userId column on ScriptVersion — reach it through the
      // Script -> Video relation, scoped to this user's non-deleted videos.
      prisma.scriptVersion.findFirst({
        where: { script: { video: notDeleted } },
        select: { id: true },
      }),
      prisma.video.findFirst({
        where: { ...notDeleted, status: "QUEUED" },
        select: { id: true },
      }),
    ]);

    const steps: OnboardingStep[] = [
      {
        id: "connect-channel",
        title: "Connect a YouTube channel",
        description: "Link the channel videos will eventually publish to.",
        href: "/channels",
        complete: hasChannel !== null,
      },
      {
        id: "check-prompt-template",
        title: "Check your prompt template",
        description: "Confirm the default script prompt fits how you write.",
        href: "/prompts",
        complete: hasDefaultScriptPrompt !== null,
      },
      {
        id: "create-project",
        title: "Create a project",
        description: "Projects group videos and hold their publish defaults.",
        href: "/projects",
        complete: hasProject !== null,
      },
      {
        id: "create-video",
        title: "Create a video from a topic",
        description: "Give the pipeline a topic to turn into a video.",
        href: "/videos",
        complete: hasVideo !== null,
      },
      {
        id: "generate-script",
        title: "Generate a script",
        description: "Run script generation on a video's topic.",
        href: "/videos",
        complete: hasScriptVersion !== null,
      },
      {
        id: "approve-script",
        title: "Approve the script",
        description: "Lock in a script version so the video is queued.",
        href: "/videos",
        complete: hasQueuedVideo !== null,
      },
    ];

    return { steps, isComplete: steps.every((step) => step.complete) };
  }
}

/**
 * Composition point. Consumers depend on `OnboardingReader`, never on which
 * implementation is bound.
 */
export const onboardingService: OnboardingReader = new OnboardingService();
