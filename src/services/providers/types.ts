import type { AiProviderType } from "@/generated/prisma/enums";
import type { Alignment } from "@/lib/captions";
import type { VoiceStyle } from "@/lib/video-style";

export interface ScriptGenerationInput {
  prompt: string;
  /** Overrides env.AI_SCRIPT_MODEL. */
  model?: string;
  apiKey?: string;
}

export interface ScriptSection {
  /** This section's narration, verbatim. Joined with the others to form the
   *  script's `content` — nothing here is metadata, it is all spoken. */
  text: string;
  /** A stock-footage search query for what to show while `text` is read. */
  cue: string;
}

export interface ScriptGenerationResult {
  content: string;
  model: string;
  provider: AiProviderType;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Absent when the model returned prose rather than sections — older
   *  prompts, or a provider that does not support structured output. The
   *  pipeline treats that as "no cues" rather than an error. */
  sections?: ScriptSection[];
}

export interface TextGenerationProvider {
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>;
}

export interface DictionaryLocator {
  id: string;
  versionId: string;
}

export interface SpeechSynthesisInput {
  text: string;
  voiceId: string;
  apiKey: string;
  voice?: VoiceStyle;
  /**
   * Server-side pronunciation dictionaries, applied without touching `text`.
   * SSML in the text would land in the very stream the returned alignment
   * describes, and lib/captions.ts turns that alignment straight into SRT —
   * so markup would corrupt the captions in order to fix the audio.
   */
  dictionaryLocators?: DictionaryLocator[];
}

export interface SpeechSynthesisResult {
  audio: Buffer;
  alignment: Alignment;
  characterCount: number;
}

export interface SpeechQuota {
  usedCharacters: number;
  limitCharacters: number;
}

export interface SpeechProvider {
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
  /**
   * Optional pre-flight check. A provider that cannot report an allowance
   * simply omits it, and callers proceed as they always did — the check exists
   * to turn a failure after the spend into a refusal before it, never to add a
   * new way for narration to be blocked.
   */
  getQuota?(apiKey: string): Promise<SpeechQuota | null>;
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

export interface MusicTrack {
  externalId: string;
  /** Jamendo's `audiodownload` url, only ever set when the artist permits it. */
  url: string;
  title: string;
  artistName: string;
  /** Recorded so the video's description can credit the track — see
   *  publish.service.ts's PIXABAY_CREDIT for why that is not optional. */
  licenseUrl: string;
  durationSeconds: number;
}

export interface MusicProvider {
  search(query: string, count: number): Promise<MusicTrack[]>;
}
