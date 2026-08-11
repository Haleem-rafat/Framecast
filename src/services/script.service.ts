import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/prompt-template";
import { extractAnchor } from "@/lib/script-cues";
import { promptTemplateService } from "@/services/prompt-template.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type {
  ScriptGenerationResult,
  TextGenerationProvider,
} from "@/services/providers/types";

/** Postgres unique-violation code, e.g. two concurrent generations racing
 * either the `ScriptVersion` (scriptId, version) constraint or the
 * `Script.videoId` constraint via the upsert. */
const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

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

    // Declared outside the try so the catch block can report the provider's
    // real figures: if generateScript() resolves, the operator has already
    // been billed even if a later step in the transaction fails.
    let result: ScriptGenerationResult | undefined;

    try {
      const generated = await this.provider.generateScript({ prompt, apiKey });
      result = generated;

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
            content: generated.content,
            wordCount: countWords(generated.content),
            // Null rather than an empty array when the model returned prose:
            // the column's meaning is "this script has no cues", and an empty
            // array would read as "it has cues, and there are none".
            cues:
              generated.sections?.map((section) => ({
                anchor: extractAnchor(section.text),
                cue: section.cue,
              })) ?? undefined,
            prompt,
            model: generated.model,
            provider: generated.provider,
          },
        });

        // The model call above already happened — and, in production, was
        // already billed — before this transaction opened. A regeneration
        // that takes that long can lose a race with an operator who approves
        // the video's *current* script while the spinner is still running:
        // "Approve script" wins the atomic DRAFT -> QUEUED update in
        // videoService.approveScript and reports success, and this call must
        // not then repoint activeVersionId at content no human has read.
        // Re-checking status before the model call would only narrow that
        // window — the call itself is what takes the seconds the race needs.
        //
        // This conditional update is the same shape approveScript uses, and
        // closes the race for real: only one of "approve" and "this
        // regeneration" can still find the video DRAFT. Throwing rolls the
        // whole transaction back, so the ScriptVersion created just above is
        // discarded along with the repoint — the two can never both land.
        //
        // It sits here, immediately before the repoint, rather than at the
        // top of the transaction: an UPDATE takes a row lock on the video
        // that is held until commit, and taking it first meant a concurrent
        // regeneration blocked behind it for the transaction's whole
        // remaining round-trip budget. Against the remote database that
        // exceeded Prisma's interactive-transaction timeout and the second
        // call died instead of serialising. Taking the lock last holds it
        // for one statement. Concurrent regenerations then race the
        // (scriptId, version) unique constraint as they always did, which
        // the P2002 handling below already converts to a ConflictError.
        const { count } = await tx.video.updateMany({
          where: { id: videoId, userId, deletedAt: null, status: "DRAFT" },
          data: { updatedAt: new Date() },
        });

        if (count === 0) {
          throw new ConflictError(
            "Your script was approved while this regeneration was still " +
              "running. The newly generated version has been discarded; the " +
              "version you approved is unchanged.",
          );
        }

        await tx.script.update({
          where: { id: script.id },
          data: { activeVersionId: version.id },
        });

        await tx.providerUsage.create({
          data: {
            provider: generated.provider,
            operation: "script.generate",
            model: generated.model,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            costUsd: generated.costUsd,
            latencyMs: generated.latencyMs,
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
      // Wasted spend still has to appear on the cost dashboard. If the
      // provider already resolved, real spend already happened even though
      // this generation ultimately failed — record its actual figures rather
      // than zeros, which would make real spend look like nothing was spent.
      // Only the provider-throws-before-returning case is truthfully zero.
      await prisma.providerUsage.create({
        data: {
          provider: result?.provider ?? "ANTHROPIC",
          operation: "script.generate",
          model: result?.model ?? null,
          inputTokens: result?.inputTokens ?? 0,
          outputTokens: result?.outputTokens ?? 0,
          costUsd: result?.costUsd ?? 0,
          latencyMs: result?.latencyMs ?? null,
          succeeded: false,
        },
      });

      // A concurrent generation racing this one on the same script's version
      // number (or its Script.videoId upsert) surfaces here as a raw unique
      // constraint violation rather than data corruption — the DB did its
      // job. Recast it as the typed conflict every other failure path in this
      // service uses, so it survives toSerializedError() as something the
      // operator can act on instead of collapsing to a generic 500.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(
          "Another generation for this script is already in progress. Try again.",
        );
      }

      throw error;
    }
  }

  /** Operator edits append a new version rather than mutating the old one. */
  async saveEdit(userId: string, videoId: string, content: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true, script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    // Gate 1: once approval has moved the video past DRAFT, the script that
    // was approved must stay exactly what downstream stages read. Without
    // this guard, an edit here would rewrite content nobody re-approved.
    if (video.status !== "DRAFT") {
      throw new ConflictError(
        "This video's script was already approved and can no longer be changed.",
      );
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
      select: { status: true, script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    // Same Gate 1 invariant as saveEdit: swapping the active pointer after
    // approval would let the UI silently present unapproved content as if it
    // were what was signed off.
    if (video.status !== "DRAFT") {
      throw new ConflictError(
        "This video's script was already approved and can no longer be changed.",
      );
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
