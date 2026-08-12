import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/prompt-template";
import { anchorCues, extractAnchor, type ScriptCue } from "@/lib/script-cues";
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
  // `Pick`, not the full `TextGenerationProvider`, for the same reason
  // `MetadataService` narrows its own constructor: this service only ever
  // calls `generateScript`, and typing the parameter as the whole interface
  // would force every test's fake provider to also stub `generateMetadata`,
  // a method this service never touches.
  constructor(
    private readonly provider: Pick<TextGenerationProvider, "generateScript"> = gatewayProvider,
  ) {}

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
      const generated = await this.provider.generateScript({
        prompt,
        apiKey,
        withSections: true,
      });
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
            // Stored beside the narration rather than inside it. `content` is
            // what voiceover.service.ts sends to ElevenLabs, so a citation
            // appended to it would be narrated; publish.service.ts reads this
            // column to build the description's SOURCES block. Same
            // null-over-empty-array convention as `cues` above: a model that
            // cited nothing leaves this null, which reads as "this script has
            // no separate sources" and lets the description fall back to an
            // inline SOURCES section if an older script carries one.
            sources: generated.sources?.length ? generated.sources : undefined,
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
        select: { version: true, cues: true, sources: true },
      });

      // Cues are re-located against the edited text rather than carried over
      // blindly. An anchor that no longer appears means the operator rewrote
      // that section's opening; its cue is dropped and reported, and that
      // stretch falls back to a topic-level clip at collection time. content
      // is trimmed before searching because cueWindows() (see
      // src/lib/script-cues.ts) treats character offsets as indices into
      // whatever voiceover.service.ts actually sends to ElevenLabs, which is
      // content.trim() — anchoring against the untrimmed string would leave
      // every offset shifted by however much leading whitespace the operator
      // happened to type.
      const previousCues = (previous?.cues ?? []) as unknown as ScriptCue[];
      const { anchored, orphaned } = anchorCues(previousCues, content.trim());

      // Anchors are re-derived from the edited content rather than carried
      // over from the previous version, so a *second* edit anchors against
      // text the operator can actually see instead of compounding drift from
      // a slice of a slice. Running the surviving slice back through
      // extractAnchor keeps every anchor at most ANCHOR_WORDS words, the
      // same invariant generate() establishes for a freshly generated
      // script.
      // Not typed as ScriptCue[]: Prisma's JSON input type requires a plain
      // object shape with an implicit string index signature, which a fresh
      // object-literal array satisfies structurally but the imported
      // `ScriptCue` interface does not (see generate()'s identically-shaped
      // `cues:` above, which relies on the same inference).
      const survivingCues = anchored.map((entry) => ({
        anchor: extractAnchor(content.trim().slice(entry.startChar, entry.endChar)),
        cue: entry.cue,
      }));

      // Carried across unchanged, unlike cues. Cues have to be re-anchored
      // because they point *into* the text the operator just rewrote; sources
      // point outside it — they are citations for the description, and the
      // editor never sees or edits them. Dropping them on the first edit
      // would silently strip a published video's citations for no reason the
      // operator could observe beforehand.
      const previousSources = Array.isArray(previous?.sources)
        ? (previous.sources as string[])
        : undefined;

      const version = await tx.scriptVersion.create({
        data: {
          scriptId,
          version: (previous?.version ?? 0) + 1,
          content,
          wordCount: countWords(content),
          // Same null-over-empty-array convention generate() uses: no
          // surviving cues reads as "this script has no cues", not "it has
          // cues, and there happen to be none".
          cues: survivingCues.length > 0 ? survivingCues : undefined,
          sources: previousSources?.length ? previousSources : undefined,
        },
      });

      await tx.script.update({
        where: { id: scriptId },
        data: { activeVersionId: version.id },
      });

      return { ...version, orphanedCueCount: orphaned.length };
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
