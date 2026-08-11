import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type {
  SpeechProvider,
  SpeechQuota,
  SpeechSynthesisInput,
  SpeechSynthesisResult,
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
