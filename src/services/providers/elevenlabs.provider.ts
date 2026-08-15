import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type {
  SpeechProvider,
  SpeechQuota,
  SpeechSynthesisInput,
  SpeechSynthesisResult,
  SpeechVoice,
  SpeechVoiceLabel,
} from "@/services/providers/types";

/** Exported so ProviderCredentialService.test() can hit the same host for its own check. */
export const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

/** ElevenLabs' own alignment shape — snake_case, mapped to `Alignment` below. */
interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface ElevenLabsTimestampedResponse {
  audio_base64: string;
  alignment: ElevenLabsAlignment;
}

/** The endpoint accepts at most three; more is a 422 rather than a truncation. */
const MAX_DICTIONARY_LOCATORS = 3;

/**
 * `GET /v1/voices`, as much of it as a picker needs. Everything is `unknown`
 * because this is somebody else's JSON: a voice with no labels, a label whose
 * value is a number, a `preview_url` of null are all shapes the API really
 * returns, and each one has to narrow to something showable rather than throw
 * away the whole list.
 */
interface ElevenLabsVoicesResponse {
  voices?: {
    voice_id?: unknown;
    name?: unknown;
    description?: unknown;
    labels?: unknown;
    preview_url?: unknown;
  }[];
}

/**
 * The labels ElevenLabs files a voice under, as displayable pairs.
 *
 * Not an allowlist of known keys. Which labels a voice carries depends on
 * where it came from — a premade voice has `accent`/`age`/`gender`/`use_case`,
 * a cloned one may have none, and the set is the account's to change. Taking
 * whatever string-valued keys are there means a new label shows up in the
 * picker on its own; naming them here would mean the picker quietly hides
 * anything ElevenLabs adds.
 *
 * `use_case` reads as "use case" — the key is an API identifier, and this is
 * the only place it is ever shown to a person.
 */
function toLabels(raw: unknown): SpeechVoiceLabel[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }

  return Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) =>
    typeof value === "string" && value.trim().length > 0
      ? [{ name: name.replaceAll("_", " "), value: value.trim() }]
      : [],
  );
}

/**
 * A preview URL only if it is one a browser can safely be pointed at.
 *
 * This value ends up as an `<audio src>` in the operator's page, so the scheme
 * is checked rather than assumed. https alone: ElevenLabs serves its samples
 * from public object storage over https, an http URL would be blocked as mixed
 * content on the deployed site anyway, and anything else — a `data:` or
 * `javascript:` URL in a field this app does not control — has no business
 * reaching the DOM. A voice that fails the check simply has no preview, which
 * is a state the picker already handles.
 */
function toPreviewUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** 429 and 5xx are transient; everything else means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * ElevenLabs' machine-readable reason for a rejection, and only that.
 *
 * The whole body used to be dropped, because `detail.message` can quote the
 * request back and must never reach a log or an operator-facing error. But an
 * exhausted allowance is reported as **401, not 429**, so a bare status code
 * is indistinguishable from a bad key — and an operator with a valid key can
 * spend a long time retrying something no retry can fix.
 *
 * `detail.status` is a short machine token (`quota_exceeded`,
 * `invalid_api_key`, …) with no request content in it, so it is the one part
 * of the body that is safe to repeat. The message field is deliberately never
 * read.
 */
async function readErrorStatus(response: Response): Promise<string> {
  try {
    // Parsed whole, then narrowed. Truncating the body first read as a memory
    // bound but was not one — `response.text()` has already materialised the
    // whole body by then — and it broke the one case it mattered in: an
    // error body over the cap came back as invalid JSON, `JSON.parse` threw,
    // and the `quota_exceeded` token was lost exactly when the body was
    // large. Nothing is repeated on the strength of having been parsed: the
    // shape check below is what decides that, and it caps the length itself.
    const parsed = JSON.parse(await response.text()) as {
      detail?: { status?: unknown };
    };
    const status = parsed.detail?.status;

    return typeof status === "string" && ERROR_STATUS_SHAPE.test(status)
      ? ` (${status})`
      : "";
  } catch {
    // A non-JSON body (an HTML gateway page, an empty response) leaves the
    // status line to speak for itself, exactly as before.
    return "";
  }
}

/** A short snake_case token, and the only thing from the body that is ever
 *  repeated. The length bound lives here rather than on the body, so a long
 *  body cannot smuggle anything out and cannot suppress the token either. */
const ERROR_STATUS_SHAPE = /^[a-z_]{1,40}$/;

/**
 * Text-to-speech with character-level timestamps. Maps ElevenLabs' snake_case
 * alignment to the camelCase `Alignment` shape at this boundary so nothing
 * downstream (captions, the render pipeline) deals with two conventions.
 */
export class ElevenLabsProvider implements SpeechProvider {
  /**
   * What the account has spent this period, or `null` when that cannot be
   * determined.
   *
   * Free to call — it costs no characters — which is what makes it usable as
   * a pre-flight check before spending quota on a synthesis that cannot fit.
   * Null on any failure: a quota check that fails must never be the reason
   * narration does not happen.
   */
  async getQuota(apiKey: string): Promise<SpeechQuota | null> {
    try {
      const response = await fetch(`${ELEVENLABS_API_BASE}/user/subscription`, {
        headers: { "xi-api-key": apiKey },
      });

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as {
        character_count?: unknown;
        character_limit?: unknown;
      };

      return typeof body.character_count === "number" &&
        typeof body.character_limit === "number"
        ? {
            usedCharacters: body.character_count,
            limitCharacters: body.character_limit,
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Every voice this key may synthesise with, in the order ElevenLabs returns
   * them.
   *
   * Free to call — listing voices costs no characters, unlike synthesising
   * with one — which is what makes it usable behind a picker the operator
   * opens whenever they like.
   *
   * Throws on failure rather than returning `[]`. A caller has to be able to
   * tell "this account has no voices" from "we could not ask", because the
   * honest thing to show for the second is not an empty list — it is a note
   * saying the account could not be reached and that whatever the channel
   * already has is untouched.
   *
   * The key goes in the header and nowhere else: it is never logged, never put
   * in the URL, and `readErrorStatus` deliberately reads only ElevenLabs'
   * machine token out of a failure body.
   */
  async listVoices(apiKey: string): Promise<SpeechVoice[]> {
    let response: Response;

    try {
      response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
        headers: { "xi-api-key": apiKey },
      });
    } catch (cause) {
      throw new ProviderError(
        "ELEVENLABS",
        "Could not reach ElevenLabs to list the available voices.",
        true,
        { cause },
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        "ELEVENLABS",
        `ElevenLabs refused to list voices (${response.status}: ${await readErrorStatus(response)}).`,
        isRetryable(response.status),
      );
    }

    const body = (await response.json()) as ElevenLabsVoicesResponse;

    // A voice with no id or no name cannot be offered — the first is what
    // would be saved and the second is the only thing the operator picks by —
    // so it is dropped rather than rendered as a blank row. Everything else
    // about a voice is optional.
    return (body.voices ?? []).flatMap((voice) =>
      typeof voice.voice_id === "string" && typeof voice.name === "string"
        ? [
            {
              voiceId: voice.voice_id,
              name: voice.name,
              description:
                typeof voice.description === "string" && voice.description.trim()
                  ? voice.description.trim()
                  : null,
              labels: toLabels(voice.labels),
              previewUrl: toPreviewUrl(voice.preview_url),
            },
          ]
        : [],
    );
  }

  async synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult> {
    let response: Response;

    try {
      response = await fetch(
        `${ELEVENLABS_API_BASE}/text-to-speech/${input.voiceId}/with-timestamps`,
        {
          method: "POST",
          headers: {
            "xi-api-key": input.apiKey,
            "Content-Type": "application/json",
          },
          // Every optional field is omitted rather than sent as undefined, so
          // a caller that passes neither produces exactly the request this
          // made before they existed.
          body: JSON.stringify({
            text: input.text,
            model_id: env.ELEVENLABS_MODEL_ID,
            ...(input.voice
              ? {
                  voice_settings: {
                    stability: input.voice.stability,
                    style: input.voice.style,
                    speed: input.voice.speed,
                  },
                  seed: input.voice.seed,
                }
              : {}),
            ...(input.dictionaryLocators?.length
              ? {
                  pronunciation_dictionary_locators: input.dictionaryLocators
                    .slice(0, MAX_DICTIONARY_LOCATORS)
                    .map((locator) => ({
                      pronunciation_dictionary_id: locator.id,
                      version_id: locator.versionId,
                    })),
                }
              : {}),
          }),
        },
      );
    } catch (cause) {
      // A network failure, not an HTTP error response — no status code to
      // read, so this can't be classified as retryable/not by status. Treat
      // it as retryable: the request never reached ElevenLabs.
      throw new ProviderError(
        "ELEVENLABS",
        "Could not reach ElevenLabs.",
        true,
        { cause },
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        "ELEVENLABS",
        `ElevenLabs request failed with status ${response.status} ${response.statusText}` +
          `${await readErrorStatus(response)}.`,
        isRetryable(response.status),
      );
    }

    let body: ElevenLabsTimestampedResponse;

    try {
      body = await response.json();
    } catch (cause) {
      throw new ProviderError(
        "ELEVENLABS",
        "ElevenLabs returned a response that could not be parsed.",
        false,
        { cause },
      );
    }

    const audio = Buffer.from(body.audio_base64, "base64");
    const alignment = {
      characters: body.alignment.characters,
      characterStartTimesSeconds: body.alignment.character_start_times_seconds,
      characterEndTimesSeconds: body.alignment.character_end_times_seconds,
    };

    return {
      audio,
      alignment,
      characterCount: alignment.characters.length,
    };
  }
}

export const elevenLabsProvider: SpeechProvider = new ElevenLabsProvider();
