/**
 * USD per million tokens. Verify against current provider pricing when adding a
 * model — an unlisted model prices at 0 rather than guessing, so a missing entry
 * shows up as suspiciously free spend rather than a plausible wrong number.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-5": { input: 3, output: 15 },
  "anthropic/claude-opus-5": { input: 15, output: 75 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
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
