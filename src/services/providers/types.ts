import type { AiProviderType } from "@/generated/prisma/enums";
import type { Alignment } from "@/lib/captions";

export interface ScriptGenerationInput {
  prompt: string;
  /** Overrides env.AI_SCRIPT_MODEL. */
  model?: string;
  apiKey?: string;
}

export interface ScriptGenerationResult {
  content: string;
  model: string;
  provider: AiProviderType;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface TextGenerationProvider {
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>;
}

export interface SpeechSynthesisInput {
  text: string;
  voiceId: string;
  apiKey: string;
}

export interface SpeechSynthesisResult {
  audio: Buffer;
  alignment: Alignment;
  characterCount: number;
}

export interface SpeechProvider {
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
}

export type StockFootageSource = "PEXELS" | "PIXABAY";

export interface StockClip {
  source: StockFootageSource;
  externalId: string;
  url: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface StockFootageProvider {
  search(query: string, count: number): Promise<StockClip[]>;
}
