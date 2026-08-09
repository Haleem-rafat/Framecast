import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";
import type {
  SpeechProvider,
  SpeechSynthesisInput,
  SpeechSynthesisResult,
} from "@/services/providers/types";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

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

/** 429 and 5xx are transient; everything else means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Text-to-speech with character-level timestamps. Maps ElevenLabs' snake_case
 * alignment to the camelCase `Alignment` shape at this boundary so nothing
 * downstream (captions, the render pipeline) deals with two conventions.
 */
export class ElevenLabsProvider implements SpeechProvider {
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
          body: JSON.stringify({
            text: input.text,
            model_id: env.ELEVENLABS_MODEL_ID,
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
      // Deliberately no response body in the message: it could echo back
      // request content, and never the API key either way — the status line
      // alone is enough to act on.
      throw new ProviderError(
        "ELEVENLABS",
        `ElevenLabs request failed with status ${response.status} ${response.statusText}.`,
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
