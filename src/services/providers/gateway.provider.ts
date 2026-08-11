import "server-only";

import { createGateway, generateObject } from "ai";
import { z } from "zod";

import { env } from "@/config/env";
import { estimateCostUsd } from "@/lib/cost";
import { ProviderError } from "@/lib/errors";
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
const scriptSchema = z.object({
  sections: z
    .array(
      z.object({
        text: z
          .string()
          .describe("This section's narration. Roughly 20-25 words."),
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
      const result = await generateObject({
        model: createGateway({ apiKey }).languageModel(model),
        schema: scriptSchema,
        prompt: input.prompt,
      });

      const sections = result.object.sections;
      const content = sections.map((section) => section.text).join(" ");

      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;

      return {
        content,
        model,
        provider: "ANTHROPIC",
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
        sections,
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
