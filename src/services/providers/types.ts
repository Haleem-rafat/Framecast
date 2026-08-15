import type { AiProviderType } from "@/generated/prisma/enums";
import type { Alignment } from "@/lib/captions";
import type { VoiceStyle } from "@/lib/video-style";

export interface ScriptGenerationInput {
  prompt: string;
  /** Overrides env.AI_SCRIPT_MODEL. */
  model?: string;
  apiKey?: string;
  /**
   * Asks for narration split into sections, each with a b-roll cue, via
   * structured output — see `ScriptGenerationResult.sections`. Opt-in and
   * off by default: this method has callers other than script generation
   * proper (a pronunciation-respelling prompt, a bare API-key check) that
   * send their own free-form prompts and parse `content` their own way.
   * Forcing every call through the sections schema silently broke the
   * first of those — the model was made to satisfy a schema that had
   * nothing to do with what was asked, so `content` stopped being the
   * prose the caller requested. Defaulting to free-form text, exactly as
   * this method behaved before sections existed, is what keeps those
   * callers working without having to know sections exist at all.
   */
  withSections?: boolean;
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
  /**
   * The citations behind the narration, one per entry — and deliberately not
   * part of `content`.
   *
   * `content` is spoken verbatim by ElevenLabs, so anything merged into it is
   * something a viewer hears. These are for the video's description only (see
   * `buildDescription` in publish.service.ts). Absent when the model returned
   * prose, or returned sections but cited nothing; the description then falls
   * back to whatever inline SOURCES section an older script happens to carry.
   */
  sources?: string[];
}

export interface MetadataGenerationInput {
  /** The narration the metadata must describe. */
  script: string;
  tone: string;
  niche: string;
  /** Restated limits on a retry, so the model is told what it broke. */
  limitsReminder?: string;
  apiKey?: string;
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
}

export interface TextGenerationProvider {
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>;
  generateMetadata(input: MetadataGenerationInput): Promise<VideoMetadata>;
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

/** One of the provider's own labels for a voice — `accent: american`,
 *  `use case: narration`. Kept as pairs rather than flattened into a sentence
 *  because which labels a voice carries is up to the account, and a picker
 *  showing "accent" beside its value is legible where a comma-joined string of
 *  bare values is not. */
export interface SpeechVoiceLabel {
  name: string;
  value: string;
}

/**
 * A voice the operator's own account can synthesise with, as the picker needs
 * to show it.
 *
 * Everything here comes from the provider. There is no hardcoded voice
 * anywhere in this app on purpose: which voices exist is a property of one
 * ElevenLabs account, a curated list would offer voices the operator may not
 * have, and choosing one they do not have is a failed narration rather than a
 * bad default.
 */
export interface SpeechVoice {
  voiceId: string;
  name: string;
  /** The provider's free-text blurb, when it has one. */
  description: string | null;
  /** `accent`, `age`, `gender`, `use case`, … — whatever the voice carries. */
  labels: SpeechVoiceLabel[];
  /**
   * A plain, unauthenticated audio URL the browser can play directly, or null
   * for a voice with no sample. Nothing about it is secret and no key is
   * involved — it is handed to an `<audio src>` as-is.
   */
  previewUrl: string | null;
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
  /**
   * The voices this key may synthesise with. Optional for the same reason
   * `getQuota` is: a provider that cannot enumerate its voices says nothing,
   * and the screen that asks reports that it could not offer a choice rather
   * than inventing one.
   *
   * Throws rather than returning an empty list on failure — "the account has
   * no voices" and "we could not ask" are different things to put in front of
   * an operator, and only a throw distinguishes them.
   */
  listVoices?(apiKey: string): Promise<SpeechVoice[]>;
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

export interface GeneratedImage {
  data: Buffer;
  model: string;
}

export interface ImageProvider {
  generate(input: {
    prompt: string;
    aspectRatio: "16:9" | "1:1";
  }): Promise<GeneratedImage>;
}
