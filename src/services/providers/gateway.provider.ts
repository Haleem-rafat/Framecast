import "server-only";

import { createGateway, generateObject, generateText } from "ai";
import { z } from "zod";

import { env } from "@/config/env";
import { estimateCostUsd } from "@/lib/cost";
import { ProviderError } from "@/lib/errors";
import { normalise } from "@/lib/script-cues";
import type {
  ScriptGenerationInput,
  ScriptGenerationResult,
  TextGenerationProvider,
} from "@/services/providers/types";

/** 429 and 5xx are transient; everything else means the request itself is wrong. */
function isRetryable(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;

  return status === 429 || (status !== undefined && status >= 500);
}

// Structured output rather than free-form prose: a per-section cue is only
// useful if the pipeline can tell where one section ends and the next
// begins, and asking the model to mark that up inline (special tokens,
// delimiters) is worse than having the SDK enforce the boundary via schema.
// `content` is then derived by joining `text` fields rather than asked for
// separately, so it can never drift from what the sections actually say.
//
// `sources` is a field of its own for a reason that is not tidiness. Every
// `text` field is spoken: they are joined into `content`, and `content` is
// what voiceover.service.ts hands to ElevenLabs verbatim. A script prompt
// that asks for citations (the seeded default does — see prisma/seed.ts) had
// nowhere to put them but a section's `text`, so the narrator would read a
// list of URLs aloud. The field descriptions below say so explicitly rather
// than relying on the prompt: an operator's stored prompt template is
// editable and may still ask for an inline SOURCES section, and the schema is
// the one instruction that travels with every structured request.
const scriptSchema = z.object({
  sections: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "This section's narration, exactly as it will be read aloud. " +
              "Roughly 20-25 words. Spoken prose only — never a URL, a " +
              "citation list, or a SOURCES heading.",
          ),
        cue: z
          .string()
          .describe(
            "A short stock-footage search query for what to show while this " +
              'is read. Describe the visual, not the idea: "printing press ' +
              'running", not "monetary expansion".',
          ),
      }),
    )
    .min(1),
  sources: z
    .array(z.string())
    .optional()
    .describe(
      "Every source cited in the narration, one entry per source. These are " +
        "published in the video's description and are never spoken, so they " +
        "belong here and nowhere in any section's text.",
    ),
});

/**
 * Routes plain `provider/model` strings through the Vercel AI Gateway, so adding
 * a model is a config change rather than a new dependency.
 */
export class GatewayProvider implements TextGenerationProvider {
  async generateScript(
    input: ScriptGenerationInput,
  ): Promise<ScriptGenerationResult> {
    const model = input.model ?? env.AI_SCRIPT_MODEL;
    const apiKey = input.apiKey ?? env.AI_GATEWAY_API_KEY;

    if (!apiKey) {
      throw new ProviderError(
        "ANTHROPIC",
        "No API key configured. Add one on the Providers page.",
        false,
      );
    }

    const startedAt = Date.now();

    try {
      // A per-request gateway instance, rather than the shared `gateway` singleton,
      // is what lets a user-supplied `apiKey` (a stored credential from the
      // Providers page) override the env-var default without racing a global.
      const languageModel = createGateway({ apiKey }).languageModel(model);

      // The schema is only ever sent when the caller asked for sections.
      // Every other caller of this method — a pronunciation-respelling
      // prompt, a bare API-key check — sends its own free-form prompt and
      // must get its own free-form text back, exactly as generateScript
      // behaved before sections existed. See ScriptGenerationInput.withSections.
      let content: string;
      let sections: ScriptGenerationResult["sections"];
      let sources: ScriptGenerationResult["sources"];
      let inputTokens: number;
      let outputTokens: number;

      if (input.withSections) {
        const result = await generateObject({
          model: languageModel,
          schema: scriptSchema,
          prompt: input.prompt,
        });

        sections = result.object.sections;
        // Each section is run through the same whitespace-collapsing that
        // script.service.ts's extractAnchor() applies before deriving that
        // section's stored anchor. Without this, a model that emits a
        // double space or a stray tab inside a section's opening would give
        // content a section chunk that doesn't byte-for-byte start with its
        // own anchor, and anchorCues() would orphan that cue immediately —
        // not because the operator edited anything, but because the two
        // representations of "this section's text" disagreed from the
        // start. Normalising both from the same source keeps them
        // identical over the shared prefix.
        content = sections.map((section) => normalise(section.text)).join(" ");
        // Deliberately not appended to `content`. `content` is the narration
        // script and the only thing that reaches ElevenLabs; a citation
        // joined onto it would be read out. It travels beside the narration
        // all the way to the video description instead — see
        // publish.service.ts's buildDescription.
        sources = result.object.sources;
        inputTokens = result.usage.inputTokens ?? 0;
        outputTokens = result.usage.outputTokens ?? 0;
      } else {
        const result = await generateText({
          model: languageModel,
          prompt: input.prompt,
        });

        content = result.text;
        inputTokens = result.usage.inputTokens ?? 0;
        outputTokens = result.usage.outputTokens ?? 0;
      }

      return {
        content,
        model,
        provider: "ANTHROPIC",
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
        sections,
        sources,
      };
    } catch (cause) {
      throw new ProviderError(
        "ANTHROPIC",
        "The model provider failed to generate a script.",
        isRetryable(cause),
        { cause },
      );
    }
  }
}

export const gatewayProvider: TextGenerationProvider = new GatewayProvider();
