import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "@/lib/errors";
import { doodleCues, planDoodleGeneration } from "@/lib/doodle-cadence";
import { insightScriptToScript, validateInsightScript } from "@/lib/insight-script";
import { checkLongformScript, longformCues } from "@/lib/longform-script";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/prompt-template";
import { recurringCharacterInstruction } from "@/lib/recurring-character";
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

/**
 * Which shape of script to ask the model for.
 *
 * `prose` is what every generation this app has ever made asked for: narration
 * split into sections, each with a b-roll cue. `insight` is the single-insight
 * short (see docs/superpowers/specs/2026-08-17-knowsense-format-design.md) — six
 * named narrative beats, one sentence a scene, and a per-scene visual brief.
 * `longform` is the eight-minute list (see
 * docs/superpowers/specs/2026-08-18-long-form-hybrid-design.md): the same
 * sections `prose` asks for, in the same schema, with a shot tag on the end of
 * every cue and a gate that refuses the answer if any of them is missing.
 *
 * `longform` is deliberately not a third *schema*. It sends `withSections`
 * exactly as `prose` does, because a section is already narration plus a visual
 * field and that is all the format needs; the difference is entirely in what is
 * asked for in the prompt and what is checked afterwards. `insight` earned its
 * own schema because a scene is a genuinely different object.
 *
 * A parameter rather than something derived from the chosen `PromptTemplate`,
 * and that was a choice worth making explicitly. `PromptTemplate` has no column
 * saying what shape its output is, and adding one would put a format flag on
 * every template an operator writes for a format that has one prompt. It is not
 * derived from the channel's `footageStyle` either, tempting as that is — the
 * two do belong together, but "what the writer is asked for" and "where the
 * pictures come from" are different decisions and coupling them means a channel
 * cannot try one without the other.
 *
 * Absent means `prose`, so every existing caller — the script panel, the
 * pipeline, the schedule — sends exactly the request it always did.
 */
export type ScriptFormat = "prose" | "insight" | "longform";

export interface GenerateScriptInput {
  templateId?: string;
  variables?: Record<string, string>;
  format?: ScriptFormat;
}

/** How many times the insight format's script is asked for before the
 *  generation is abandoned. Two: the first ask, and one retry carrying the
 *  validator's complaints. A third would be a third bill for a model that has
 *  now twice ignored rules stated twice. */
const INSIGHT_ATTEMPTS = 2;

/** The same two, for the long-form list, and for the same arithmetic — except
 *  that here the second bill is the cheap half: a script that reaches footage
 *  with one section untagged spends about $2 of generated stills on a video
 *  that is a quarter shorter of pictures than it was written for. */
const LONGFORM_ATTEMPTS = 2;

/**
 * What the model is told before the validator's own sentences.
 *
 * Short, and it says "return the whole script again" rather than "fix scene 4":
 * a partial answer would have to be merged with the previous one, and a merge
 * of two scripts is a script nobody wrote.
 *
 * Shared by both gated formats, and worded so it can be: neither the preface
 * nor the errors under it name a format, so the only thing it commits to is
 * "same shape, whole thing, nothing else changed".
 */
const RETRY_PREFACE =
  "Your previous answer was rejected. Fix every problem listed below and " +
  "return the complete script again in the same shape. Change nothing else.";

function countWords(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * What a generation cost in total, across however many attempts it took.
 *
 * The insight format can bill twice for one script — see `generateInsight` —
 * and a `ProviderUsage` row recording only the successful attempt would report
 * a rejected first draft as free. Summed rather than recorded as two rows
 * because one operator action is one line on the cost dashboard; the retry is
 * an implementation detail of that action, not a second thing that happened.
 *
 * A single attempt sums to itself, so the prose path's row is unchanged.
 */
function billedTotals(attempts: readonly ScriptGenerationResult[]) {
  return attempts.reduce(
    (total, attempt) => ({
      inputTokens: total.inputTokens + attempt.inputTokens,
      outputTokens: total.outputTokens + attempt.outputTokens,
      costUsd: total.costUsd + attempt.costUsd,
      latencyMs: total.latencyMs + attempt.latencyMs,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
  );
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
      select: {
        id: true,
        status: true,
        title: true,
        topic: true,
        // Who this channel's recurring character is, if it has one.
        //
        // Read through the video's own operator-scoped row rather than via
        // `brandService.resolve(channelId)`, for the two reasons
        // footage.service.ts gives for reading the same columns the same way:
        // it costs no second query, and it cannot resolve a channel this
        // operator does not own. A video whose project has no channel, or a
        // channel with no brand row, arrives here as null and
        // `recurringCharacterInstruction` returns null for it — the same
        // outcome as a live-action channel, which is to say no change at all.
        project: {
          select: {
            channel: {
              select: {
                brand: {
                  select: {
                    footageStyle: true,
                    characterBrief: true,
                    // Read only by `planDoodleGeneration` below, and only for a
                    // DOODLE channel — see the column's comment for why this is
                    // the one place in the app that selects it.
                    beatSeconds: true,
                  },
                },
              },
            },
          },
        },
      },
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

    // Sent beside the rendered prompt, never inside it.
    //
    // The prompt string is not available for this. `renderTemplate` treats the
    // template's declared `PromptVariable` rows as authoritative — an
    // undeclared `{{placeholder}}` is deliberately left unsubstituted so a typo
    // stays visible — so injecting a `{{character}}` token would print the
    // token verbatim in every template that does not declare it, and would
    // rewrite the meaning of the one that does. Appending prose to
    // `template.content` instead would silently edit the operator's own
    // template on every generation and then store that edited text in
    // `ScriptVersion.prompt`, whose whole job is to record what the template
    // actually said.
    //
    // A system instruction has neither problem: the operator's template goes to
    // the model unchanged and is stored unchanged, and the channel's standing
    // fact about its own protagonist sits above it where a standing fact
    // belongs. `ScriptVersion.prompt` therefore still records the rendered
    // template exactly; the instruction is not stored beside it because it is
    // derived, deterministically and from data that is itself stored — this
    // channel's `characterBrief` and `footageStyle`, both visible on the
    // branding screen — rather than authored per generation.
    const brand = video.project.channel?.brand ?? null;

    // The doodle format's two numbers, validated against each other in the one
    // place that has both.
    //
    // `beatSeconds` is read here and nowhere else in the app. Everything
    // downstream — footage, render, shorts — reaches the same cadence through
    // `ScriptVersion.cues`, which is what keeps the three of them from drifting
    // apart; see the column's own comment in schema.prisma for why that matters.
    //
    // The length cap is enforced here rather than in `story-beats.ts` because
    // `MAX_BEATS` is deliberately not applied on the tagged path: capping the
    // count there would drop the last shots silently and leave the closing
    // minute with no picture over it. Capping the duration bounds the same
    // spend without ever doing that.
    //
    // Above the first billed call on purpose. A refusal is not a charge.
    const doodle = brand
      ? planDoodleGeneration({
          footageStyle: brand.footageStyle,
          beatSeconds: brand.beatSeconds,
          declaredMinutes:
            input.variables?.duration ??
            template.variables.find((variable) => variable.key === "duration")
              ?.defaultValue ??
            undefined,
        })
      : null;

    if (doodle && !doodle.ok) {
      throw new ValidationError(doodle.reason);
    }

    // Two standing facts about this channel, either of which may be absent.
    // They are mutually exclusive in practice — `recurringCharacterInstruction`
    // returns null for anything but ILLUSTRATED — but joining rather than
    // choosing means neither has to know that about the other.
    const instructions = [
      recurringCharacterInstruction(brand),
      doodle?.ok ? doodle.instruction : null,
    ].filter((line): line is string => line !== null);

    const system = instructions.length > 0 ? instructions.join("\n\n") : undefined;

    const apiKey =
      (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ??
      undefined;

    // Declared outside the try so the catch block can report the provider's
    // real figures: if generateScript() resolves, the operator has already
    // been billed even if a later step in the transaction fails.
    let result: ScriptGenerationResult | undefined;
    // Every attempt that reached the provider, in order. One entry for a prose
    // generation; up to two for an insight one, including a first draft the
    // gate threw away — which was still billed. See `billedTotals`.
    const attempts: ScriptGenerationResult[] = [];
    const record = (attempt: ScriptGenerationResult) => {
      attempts.push(attempt);
      result = attempt;
    };

    try {
      // Both gated formats record their own attempts as they resolve, since
      // a draft the gate threw away was still billed. The prose path has
      // exactly one attempt and records it below.
      const gated = input.format === "insight" || input.format === "longform";
      const generated =
        input.format === "insight"
          ? await this.generateInsight({ prompt, system, apiKey }, record)
          : input.format === "longform"
            ? await this.generateLongform({ prompt, system, apiKey }, record)
            : await this.provider.generateScript({
                prompt,
                system,
                apiKey,
                withSections: true,
              });

      if (!gated) {
        record(generated);
      }

      // Non-null for the insight format and undefined for prose, which is what
      // decides both the cues written below and whether `content` came from a
      // scene array or from sections. Parsed once here rather than at each use.
      const parsedInsight = generated.insight
        ? insightScriptToScript(generated.insight)
        : null;

      // The long-form list's cues, with the stock share already capped — see
      // `longformCues`. Null for every other format, including a prose
      // generation that happens to have produced sections, because the cap and
      // the tag-stripping are this format's rules and applying them to an
      // ordinary explainer's cues would silently rewrite them.
      const parsedLongform =
        input.format === "longform" && generated.sections
          ? longformCues(generated.sections)
          : null;

      // A doodle channel's cues, every one a still.
      //
      // Keyed off the channel rather than off `input.format`, which is the
      // difference that matters: the two formats above are chosen per
      // generation, and this one is a property of the channel that is already
      // decided by the time anybody picks a template. Gating it on a format
      // string would mean a doodle channel generating from any other template
      // silently produced untagged cues and rendered at one picture every
      // twenty seconds — which is exactly what the first real generation did.
      //
      // `planStoryBeats` needs EVERY cue to carry a shot before it will cut one
      // picture per section, so this is set in code rather than asked of the
      // model. See `doodleCues`.
      const parsedDoodle =
        doodle?.ok && generated.sections ? doodleCues(generated.sections) : null;

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
            //
            // An insight script's cues carry two extra fields — see `CueMeta`
            // in script-cues.ts. They are spread into fresh object literals
            // rather than stored as `ScriptCue[]` for the reason `saveEdit`
            // gives below: Prisma's JSON input type wants a plain object shape,
            // which a literal satisfies structurally and an imported interface
            // does not.
            cues:
              parsedInsight?.cues.map((cue) => ({
                anchor: cue.anchor,
                cue: cue.cue,
                beat: cue.beat,
                emphasis: cue.emphasis,
              })) ??
              parsedLongform?.map((cue) => ({
                anchor: cue.anchor,
                cue: cue.cue,
                shot: cue.shot,
              })) ??
              parsedDoodle?.map((cue) => ({
                anchor: cue.anchor,
                cue: cue.cue,
                shot: cue.shot,
              })) ??
              generated.sections?.map((section) => ({
                anchor: extractAnchor(section.text),
                cue: section.cue,
              })) ??
              undefined,
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
            // The whole generation, retries included. Identical to
            // `generated`'s own figures whenever there was only one attempt,
            // which is every prose generation.
            ...billedTotals(attempts),
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
          // Everything the provider was paid for before this failed — which
          // for an insight script that was rejected twice is two drafts, not
          // one. Zeros when the provider threw before returning, which is the
          // one case that truthfully cost nothing.
          ...billedTotals(attempts),
          // Null rather than 0 when nothing was ever called, exactly as before:
          // a zero here would claim a request that took no time, and null says
          // there was no request.
          latencyMs: attempts.length > 0 ? billedTotals(attempts).latencyMs : null,
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

  /**
   * Asks for a single-insight script and refuses to hand back one that breaks
   * the format.
   *
   * ## Why the gate is here and not further down
   *
   * Everything after the script costs money — narration is billed per
   * character, every scene is a generated picture, the render burns worker
   * minutes — and none of it can tell that a script has five beats instead of
   * six. `validateInsightScript` is cheap, pure, and its messages were written
   * to be pasted into a retry verbatim, so this is the one place where "the
   * model wrote the wrong thing" is both detectable and fixable.
   *
   * ## Why exactly one retry
   *
   * The first ask is a model reading the format's rules. The retry is the same
   * model reading the rules *and* a list of the ones it broke, which is the
   * strongest prompt available; a third ask would add nothing new and bill for
   * it. Two failures is a report, not a third attempt — and never a silently
   * persisted bad script, which is the outcome this whole method exists to
   * prevent. The operator sees the validator's own sentences, because they are
   * the specific thing that is wrong and they are already in plain English.
   *
   * Every attempt is handed to `onAttempt` as soon as it resolves, including
   * the ones that are then thrown away: they were billed the moment the
   * provider answered, and the cost dashboard must say so.
   */
  private async generateInsight(
    request: { prompt: string; system?: string; apiKey?: string },
    onAttempt: (result: ScriptGenerationResult) => void,
  ): Promise<ScriptGenerationResult> {
    let errors: string[] = [];

    for (let attempt = 0; attempt < INSIGHT_ATTEMPTS; attempt += 1) {
      const generated = await this.provider.generateScript({
        // The operator's template first and unchanged, then the complaints —
        // so the retry reads as the original brief with corrections attached
        // rather than as a new, shorter brief about error messages.
        prompt:
          errors.length === 0
            ? request.prompt
            : `${request.prompt}\n\n${RETRY_PREFACE}\n\n` +
              errors.map((error) => `- ${error}`).join("\n"),
        system: request.system,
        apiKey: request.apiKey,
        withInsightScenes: true,
      });

      onAttempt(generated);

      // A provider that was asked for scenes and returned none is a wiring
      // fault, not a bad script: there is nothing for the validator to
      // complain about and nothing a retry would say differently. Named as
      // ours rather than reported to the operator as a script problem.
      if (!generated.insight) {
        throw new InternalError(
          "The model provider was asked for a single-insight script and " +
            "returned no scenes.",
        );
      }

      const validation = validateInsightScript(generated.insight);

      if (validation.ok) {
        return generated;
      }

      errors = validation.errors;
    }

    throw new ConflictError(
      `The script did not meet the single-insight format after ` +
        `${INSIGHT_ATTEMPTS} attempts, so nothing was saved. What was wrong ` +
        `with the last one:\n` +
        errors.map((error) => `- ${error}`).join("\n"),
    );
  }

  /**
   * Asks for an eight-minute list script and refuses to hand back one whose
   * shot plan is not what it claims to be.
   *
   * The same loop as `generateInsight` above, deliberately not factored into a
   * shared helper: the two differ in the request they make (`withSections`
   * against `withInsightScenes`), the field they read back, the validator they
   * run and the sentence they give up with, which between them is the whole
   * body. What they share is a shape, and a shape is what a comment is for.
   *
   * ## Why this format needs a gate at all
   *
   * `planStoryBeats` cuts one picture per cue only when **every** cue carries a
   * shot tag. One section that came back untagged silently drops the video from
   * about forty slots to the twenty-four `BEAT_TARGET_SECONDS` produces: it
   * renders, it costs less, and it looks like a slideshow — and by then the
   * narration has been billed and the stills have been drawn. The tag is a
   * convention stated in a prompt, so the only place it can be checked is on
   * the model's own answer, which is here.
   *
   * The stock-share cap is **not** checked. It is applied by `longformCues`
   * instead, where a script that over-tagged motion is corrected for free
   * rather than re-asked for at four cents.
   */
  private async generateLongform(
    request: { prompt: string; system?: string; apiKey?: string },
    onAttempt: (result: ScriptGenerationResult) => void,
  ): Promise<ScriptGenerationResult> {
    let errors: string[] = [];

    for (let attempt = 0; attempt < LONGFORM_ATTEMPTS; attempt += 1) {
      const generated = await this.provider.generateScript({
        prompt:
          errors.length === 0
            ? request.prompt
            : `${request.prompt}\n\n${RETRY_PREFACE}\n\n` +
              errors.map((error) => `- ${error}`).join("\n"),
        system: request.system,
        apiKey: request.apiKey,
        withSections: true,
      });

      onAttempt(generated);

      // Asked for sections and given prose. A wiring fault rather than a bad
      // script — there is nothing for the gate to complain about and nothing a
      // retry would phrase differently — so it is named as ours, exactly as the
      // insight path names its own.
      if (!generated.sections) {
        throw new InternalError(
          "The model provider was asked for a sectioned long-form script and " +
            "returned prose.",
        );
      }

      const check = checkLongformScript(generated.sections);

      if (check.ok) {
        return generated;
      }

      errors = check.errors;
    }

    throw new ConflictError(
      `The script did not meet the long-form list format after ` +
        `${LONGFORM_ATTEMPTS} attempts, so nothing was saved. What was wrong ` +
        `with the last one:\n` +
        errors.map((error) => `- ${error}`).join("\n"),
    );
  }

  /**
   * Takes a script the operator wrote elsewhere and makes it this video's
   * active version, with no model call and no cost.
   *
   * Distinct from `saveEdit`, which refuses a video that has no `Script` row
   * yet — the case that matters here, since an operator bringing their own
   * script has by definition never generated one. This upserts that row the
   * same way `generate` does, so an import and a generation produce exactly
   * the same shape and every downstream stage is indifferent to which
   * happened.
   *
   * The imported version carries no `cues`: cue anchors are produced by the
   * model alongside the narration it wrote, and there is nothing to derive
   * them from in pasted prose. Footage collection already handles a
   * cue-less script by drawing from the topic-level pool — the same path
   * every script written before cues existed still takes — so this degrades
   * to "footage matched to the topic rather than the sentence" rather than
   * failing. `prompt`, `model` and `provider` stay null for the same reason:
   * recording a prompt nobody sent would corrupt the reproducibility those
   * columns exist to give.
   */
  async importScript(userId: string, videoId: string, content: string) {
    const trimmed = content.trim();

    if (trimmed.length === 0) {
      throw new ConflictError("An imported script cannot be empty.");
    }

    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    // Same gate `saveEdit` applies, and for the same reason: once approval has
    // moved the video past DRAFT, downstream stages have already read the
    // script that was approved, and replacing it here would swap content out
    // from under a narration that may already have been synthesised.
    if (video.status !== "DRAFT") {
      throw new ConflictError(
        "This video's script was already approved and can no longer be replaced.",
      );
    }

    try {
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
            content: trimmed,
            wordCount: countWords(trimmed),
          },
        });

        // The same conditional update `generate` uses, for the same race: an
        // operator can approve the current script between this call starting
        // and its transaction committing, and the approved version must not
        // then be silently repointed at text nobody approved. Throwing rolls
        // back the version created just above, so the two can never both land.
        const { count } = await tx.video.updateMany({
          where: { id: videoId, userId, deletedAt: null, status: "DRAFT" },
          data: { updatedAt: new Date() },
        });

        if (count === 0) {
          throw new ConflictError(
            "Your script was approved while this import was still running. " +
              "The imported version has been discarded; the version you " +
              "approved is unchanged.",
          );
        }

        await tx.script.update({
          where: { id: script.id },
          data: { activeVersionId: version.id },
        });

        await tx.activityLog.create({
          data: {
            userId,
            action: "script.import",
            entityType: "Video",
            entityId: videoId,
            message: `Imported script v${version.version} (${version.wordCount} words)`,
          },
        });

        return version;
      });
    } catch (error) {
      // Two imports racing the same script's version number surface as a raw
      // unique violation; recast to the typed conflict the rest of this
      // service uses, exactly as `generate` does.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(
          "Another change to this script is already in progress. Try again.",
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
