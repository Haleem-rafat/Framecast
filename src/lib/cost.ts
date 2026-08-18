/**
 * USD per million tokens. Verify against current provider pricing when adding a
 * model — an unlisted model prices at 0 rather than guessing, so a missing entry
 * shows up as suspiciously free spend rather than a plausible wrong number.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-5": { input: 3, output: 15 },
  "anthropic/claude-opus-5": { input: 15, output: 75 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  // Image models, priced per token exactly like the text ones above — which is
  // why they belong in this table rather than in a second per-image one. Read
  // from `GET https://ai-gateway.vercel.sh/v1/models` on 16 Aug 2026, where
  // `openai/gpt-image-2` lists `input: 0.000005` and `output: 0.00003` per
  // token. Vercel's pricing page states the gateway "charges no markup and no
  // platform fee", so these are OpenAI's own list prices.
  //
  // Measured against them, one 1024x1536 illustration conditioned on a
  // character sheet reports ~1,150 input and ~1,372 output tokens, which is
  // $0.047. A twelve-beat four-minute story is therefore about $0.57 plus a
  // one-off $0.05 for the sheet.
  "openai/gpt-image-2": { input: 5, output: 30 },
  // Same gateway listing, re-read on 18 Aug 2026, where `openai/gpt-image-1`
  // lists `input: 0.000005` and `output: 0.00004` per token (gpt-image-2's own
  // pair re-confirmed unchanged at the same time). Present so a thumbnail stops
  // pricing at exactly $0.00 — which is what an unlisted model does, and which
  // is indistinguishable from a thumbnail that was never generated. This is
  // AI_IMAGE_MODEL's default and therefore every thumbnail and every channel
  // logo this app has ever drawn.
  "openai/gpt-image-1": { input: 5, output: 40 },
};

const PER_MILLION = 1_000_000;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = RATES[model];

  if (!rate) {
    return 0;
  }

  return (
    (inputTokens * rate.input + outputTokens * rate.output) / PER_MILLION
  );
}
