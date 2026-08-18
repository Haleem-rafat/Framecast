import type { AiProviderType } from "@/generated/prisma/enums";
import type { Alignment } from "@/lib/captions";
import type { InsightScript } from "@/lib/insight-script";
import type { VoiceStyle } from "@/lib/video-style";

export interface ScriptGenerationInput {
  prompt: string;
  /**
   * A system-level instruction sent alongside `prompt`, never merged into it.
   *
   * Exists so a caller can state something about *this channel* that the
   * operator's stored prompt template knows nothing about — today, who the
   * channel's recurring character is (see `src/lib/recurring-character.ts`).
   * That could not go in the prompt string itself: `renderTemplate` treats a
   * template's declared `PromptVariable` rows as authoritative, so an injected
   * `{{character}}` token would either be left in the output verbatim or, worse,
   * be substituted into a template that never asked for it. Keeping it a
   * separate field also keeps `ScriptVersion.prompt` meaning exactly what its
   * comment says it means — the rendered template, reproducible from the
   * operator's own library.
   *
   * Absent for every caller that does not set it, and absent means the request
   * is byte-for-byte the one this method has always made: the AI SDK omits an
   * undefined `system` entirely. That matters — `generateScript` also serves a
   * pronunciation-respelling prompt (voiceover.service.ts), a bare API-key
   * check (provider-credential.service.ts) and topic suggestion
   * (easy-mode.service.ts), none of which are writing a channel's narration.
   */
  system?: string;
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
  /**
   * Asks for the single-insight format's scene array instead — see
   * `ScriptGenerationResult.insight`.
   *
   * A third shape rather than a variant of `withSections`, because the two ask
   * for genuinely different things: a section is narration plus a search query,
   * a scene is narration plus a visual brief plus which of the six narrative
   * beats it is plus which words the voice leans on. Collapsing them into one
   * schema would send every ordinary script a beat field it has no structure
   * for, and would make "the model returned no beats" indistinguishable from
   * "this prompt has no beats to return".
   *
   * Off by default and mutually exclusive with `withSections` in practice —
   * `withSections` is checked first below, so a caller that sets both gets the
   * behaviour it had before this field existed.
   */
  withInsightScenes?: boolean;
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
  /**
   * The single-insight format's scenes, exactly as the model returned them.
   *
   * Present only when `withInsightScenes` was set. Handed up unvalidated on
   * purpose: `ScriptService` runs `validateInsightScript` over it and, on
   * failure, re-asks the model with the validator's own error sentences
   * appended. A provider that rejected the script itself would have nothing to
   * say about *why* that a retry prompt could use, and would spend the
   * operator's money twice to discover it.
   *
   * `content` is set alongside it to the scenes' narrations joined, by the same
   * pure function `ScriptService` then uses to build the cues — so the words
   * that get narrated and the anchors that locate them cannot disagree.
   */
  insight?: InsightScript;
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
  /**
   * What this one image actually cost, from the token counts the provider
   * reported — not an estimate from a per-image price list.
   *
   * Zero when the model has no entry in `cost.ts`'s rate table or the provider
   * reported no usage, which is the same "suspiciously free rather than
   * plausibly wrong" convention `estimateCostUsd` already follows. Callers
   * that state a spend to an operator (see `FootageService.collect`) sum this;
   * callers that do not (logos, thumbnails) ignore it, which is why it is not
   * optional — a number nobody has to check for undefined.
   */
  costUsd: number;
  /**
   * What the provider said it billed, unpriced.
   *
   * Both optional, and that is the point rather than laziness:
   * `ImageModelV4Usage` types them `number | undefined`, and the whole reason
   * this pair exists is that a MISSING `outputTokens` is indistinguishable from
   * a free one once `costUsd` has been computed. An image priced at $0.006 and
   * an image priced at $0.047 are the same generation with and without this
   * field, so the honest thing is to record what arrived rather than only what
   * it came to.
   */
  inputTokens?: number;
  outputTokens?: number;
}

export interface ImageGenerationInput {
  prompt: string;
  /** Ignored when `size` is given — the two are alternative ways to say the
   *  same thing and the AI SDK rejects both at once. */
  aspectRatio: "16:9" | "1:1" | "9:16";
  /**
   * Exact pixels, when the caller needs them rather than a ratio.
   *
   * An illustration is composed into a 1080x1920 or 1920x1080 frame and then
   * panned across, so what it needs is a picture at least as tall and wide as
   * the frame in the right shape — `1024x1536` and `1536x1024` are the nearest
   * sizes gpt-image-2 offers, and asking for them by name is more honest than
   * asking for "9:16" and hoping. Logos and thumbnails pass nothing and are
   * unaffected.
   */
  size?: `${number}x${number}`;
  /**
   * Reference images the model conditions on, in addition to the prompt.
   *
   * This is the character-consistency mechanism, and it is a real one: the AI
   * SDK's `generateImage` accepts image inputs, so the channel's character
   * sheet is *passed to* every scene generation rather than described to it.
   * A textual description alone is what Max Woolf's write-up found
   * insufficient — he escalated to seventeen reference images before fidelity
   * held.
   *
   * Empty or absent is a plain text-to-image call, byte-for-byte what logos
   * and thumbnails have always made.
   */
  referenceImages?: readonly Buffer[];
  /** Overrides `env.AI_IMAGE_MODEL`. Illustrations and thumbnails are
   *  different jobs with different right answers, and pinning one model for
   *  both would mean changing thumbnails to change illustrations. */
  model?: string;
}

export interface ImageProvider {
  generate(input: ImageGenerationInput): Promise<GeneratedImage>;
}

/**
 * A text-to-video model, which is the one provider shape in this codebase that
 * cannot be an `await`.
 *
 * Every other provider here answers in under a minute: the gateway returns a
 * script, ElevenLabs returns audio, Pexels returns JSON. A measured fal.ai
 * generation of ONE five-second clip took **217 seconds**, so a twelve-clip
 * manifest is something like an hour and a quarter of wall time. No HTTP
 * request in this app is held open for that, so the interface is split into the
 * three round trips the queue actually has — submit, poll, collect — and a job
 * row (motion.service.ts) carries the state between them.
 *
 * Splitting it this way is also what makes the money auditable. `submit` is the
 * exact moment a bill starts; it returns an id and nothing else, so the caller
 * has one thing to persist, and one thing to persist it before.
 */
export interface VideoGenerationRequest {
  /** Never a constant, never an env var — the operator's own stored
   *  credential, resolved through `providerCredentialService.resolveKey`. */
  apiKey: string;
  /** The provider's model path, e.g. `fal-ai/wan-t2v`. Passed per request
   *  rather than fixed, so a job polls the same model it was submitted to. */
  model: string;
  /** The full prompt, style lock already appended — see `clipPrompt`. */
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  durationSeconds: number;
  /** Required, not optional. `render-manifest.ts` refuses a manifest whose
   *  clips carry no integer seed, because without one a bad clip cannot be
   *  re-rolled alone — so by the time a request is built there is always one. */
  seed: number;
}

/**
 * PENDING covers both "queued" and "running", because nothing downstream treats
 * them differently: both mean poll again, neither counts an attempt, and only
 * the deadline distinguishes a slow queue from a dead one.
 */
export type VideoGenerationState = "PENDING" | "COMPLETED" | "FAILED";

export interface VideoGenerationStatus {
  state: VideoGenerationState;
  /** The provider's own words, kept for the job row's `error`. Null when it
   *  offered none. */
  detail: string | null;
}

export interface GeneratedClip {
  data: Buffer;
  contentType: string;
  /**
   * The seed the provider says it actually used, when it says so at all.
   * Compared against the requested one by the caller: a provider that silently
   * ignored the seed makes "re-roll one clip" impossible, and learning that
   * from one mismatched integer is far cheaper than learning it from twelve
   * clips that all changed.
   */
  seed: number | null;
}

export interface VideoGenerationProvider {
  /** Which credential this adapter spends. Tags the `ProviderUsage` rows. */
  readonly provider: AiProviderType;
  /** Starts a generation and returns the queue id. **This is the call that
   *  spends money**; everything before it is free, and everything after it is
   *  bookkeeping. */
  submit(request: VideoGenerationRequest): Promise<string>;
  /** Cheap enough to run every few seconds; returns no media. */
  checkStatus(
    model: string,
    requestId: string,
    apiKey: string,
  ): Promise<VideoGenerationStatus>;
  /** Collects a COMPLETED generation and downloads it. Throws rather than
   *  returning an empty clip when the provider reports success without media —
   *  see the fal adapter for why that case is not hypothetical. */
  fetchResult(
    model: string,
    requestId: string,
    apiKey: string,
  ): Promise<GeneratedClip>;
  /** True when the provider accepts the key. Spends nothing. */
  verifyKey(apiKey: string): Promise<boolean>;
}
