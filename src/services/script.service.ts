import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/prompt-template";
import { promptTemplateService } from "@/services/prompt-template.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider } from "@/services/providers/types";

export interface GenerateScriptInput {
  templateId?: string;
  variables?: Record<string, string>;
}

function countWords(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

export class ScriptService {
  constructor(private readonly provider: TextGenerationProvider = gatewayProvider) {}

  async generate(
    userId: string,
    videoId: string,
    input: GenerateScriptInput,
  ) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true, title: true, topic: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "DRAFT") {
      throw new ConflictError(
        "A script can only be generated while the video is still a draft.",
      );
    }

    const template = input.templateId
      ? await promptTemplateService.get(userId, input.templateId)
      : await promptTemplateService.getDefault(userId, "SCRIPT");

    // The topic is always available as {{topic}} without the operator retyping it.
    const prompt = renderTemplate(
      template.content,
      { topic: video.topic ?? video.title, ...input.variables },
      template.variables,
    );

    const apiKey =
      (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ??
      undefined;

    try {
      const result = await this.provider.generateScript({ prompt, apiKey });

      return await prisma.$transaction(async (tx) => {
        const script = await tx.script.upsert({
          where: { videoId },
          create: { videoId },
          update: {},
        });

        const previous = await tx.scriptVersion.findFirst({
          where: { scriptId: script.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });

        const version = await tx.scriptVersion.create({
          data: {
            scriptId: script.id,
            version: (previous?.version ?? 0) + 1,
            content: result.content,
            wordCount: countWords(result.content),
            prompt,
            model: result.model,
            provider: result.provider,
          },
        });

        await tx.script.update({
          where: { id: script.id },
          data: { activeVersionId: version.id },
        });

        await tx.providerUsage.create({
          data: {
            provider: result.provider,
            operation: "script.generate",
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
            latencyMs: result.latencyMs,
            succeeded: true,
          },
        });

        await tx.activityLog.create({
          data: {
            userId,
            action: "script.generate",
            entityType: "Video",
            entityId: videoId,
            message: `Generated script v${version.version} (${version.wordCount} words)`,
          },
        });

        return version;
      });
    } catch (error) {
      // Wasted spend still has to appear on the cost dashboard.
      await prisma.providerUsage.create({
        data: {
          provider: "ANTHROPIC",
          operation: "script.generate",
          succeeded: false,
        },
      });

      throw error;
    }
  }

  /** Operator edits append a new version rather than mutating the old one. */
  async saveEdit(userId: string, videoId: string, content: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    const scriptId = video.script.id;

    return prisma.$transaction(async (tx) => {
      const previous = await tx.scriptVersion.findFirst({
        where: { scriptId },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      const version = await tx.scriptVersion.create({
        data: {
          scriptId,
          version: (previous?.version ?? 0) + 1,
          content,
          wordCount: countWords(content),
        },
      });

      await tx.script.update({
        where: { id: scriptId },
        data: { activeVersionId: version.id },
      });

      return version;
    });
  }

  async setActiveVersion(userId: string, videoId: string, versionId: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    const version = await prisma.scriptVersion.findFirst({
      where: { id: versionId, scriptId: video.script.id },
      select: { id: true },
    });

    if (!version) {
      throw new NotFoundError("Script version");
    }

    await prisma.script.update({
      where: { id: video.script.id },
      data: { activeVersionId: version.id },
    });
  }
}

export const scriptService = new ScriptService();
