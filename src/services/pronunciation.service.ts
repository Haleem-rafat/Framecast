import "server-only";

import { prisma } from "@/lib/prisma";
import { ELEVENLABS_API_BASE } from "@/services/providers/elevenlabs.provider";
import type { DictionaryLocator } from "@/services/providers/types";

/**
 * An alias rule replaces a written form with a respelling ElevenLabs can say.
 *
 * Aliases, never phonemes. Phoneme support is model-dependent — Flash v2 takes
 * SSML phonemes, v3 takes IPA in slashes, Multilingual v2 supports only alias
 * replacement — and `ELEVENLABS_MODEL_ID` is environment-configured, so it can
 * change without anyone touching this file. An alias works on every model, so
 * a model change cannot silently degrade pronunciation.
 */
export interface AliasRule {
  string_to_replace: string;
  type: "alias";
  alias: string;
}

/** Proposes a respelling for each term. Injected rather than called directly
 *  so the LLM round trip is substitutable in tests. */
export type AliasProposer = (terms: string[]) => Promise<AliasRule[]>;

/**
 * A capitalised word that follows another word. Sentence-initial capitals are
 * ordinary words, so only mid-sentence ones are candidates for being a name
 * the engine will mangle.
 */
const CANDIDATE_TERM = /(?<=[a-z,;:]\s)([A-Z][a-zA-Z'’-]{2,})/g;

/** Past this, the request is more likely noise than a useful dictionary. */
const MAX_TERMS_PER_SCRIPT = 40;

/**
 * Per-channel pronunciation, applied through a server-side dictionary rather
 * than markup in the narration text.
 *
 * `SpeechProvider.synthesize` calls the with-timestamps endpoint, and
 * `lib/captions.ts` turns the returned character alignment straight into SRT.
 * SSML injected into `text` would land in the very stream that alignment
 * describes — corrupting the captions in order to fix the audio.
 */
export class PronunciationService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /**
   * Returns the channel's dictionary locator, or `null` when this narration
   * should be synthesised without one.
   *
   * Never throws. A missing dictionary costs pronunciation quality; it must
   * not stop a video being narrated at all.
   */
  async ensureDictionary(
    apiKey: string,
    channelId: string,
    scriptText: string,
    proposeAliases: AliasProposer,
  ): Promise<DictionaryLocator | null> {
    try {
      const channel = await prisma.channel.findFirst({
        where: { id: channelId, deletedAt: null },
        select: {
          pronunciationDictionaryId: true,
          pronunciationDictionaryVersionId: true,
        },
      });

      if (!channel) {
        return null;
      }

      const existing =
        channel.pronunciationDictionaryId && channel.pronunciationDictionaryVersionId
          ? {
              id: channel.pronunciationDictionaryId,
              versionId: channel.pronunciationDictionaryVersionId,
            }
          : null;

      const terms = [...new Set(scriptText.match(CANDIDATE_TERM) ?? [])].slice(
        0,
        MAX_TERMS_PER_SCRIPT,
      );
      const rules = terms.length > 0 ? await proposeAliases(terms) : [];

      // Nothing new to teach it — reuse whatever the channel already has.
      if (rules.length === 0) {
        return existing;
      }

      const locator = existing
        ? await this.addRules(apiKey, existing.id, rules)
        : await this.createDictionary(apiKey, channelId, rules);

      if (!locator) {
        return existing;
      }

      await prisma.channel.update({
        where: { id: channelId },
        data: {
          pronunciationDictionaryId: locator.id,
          pronunciationDictionaryVersionId: locator.versionId,
        },
      });

      return locator;
    } catch {
      return null;
    }
  }

  private async createDictionary(
    apiKey: string,
    channelId: string,
    rules: AliasRule[],
  ): Promise<DictionaryLocator | null> {
    const response = await this.fetchImpl(
      `${ELEVENLABS_API_BASE}/pronunciation-dictionaries/add-from-rules`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `framecast-${channelId}`, rules }),
      },
    );

    return this.readLocator(response);
  }

  private async addRules(
    apiKey: string,
    dictionaryId: string,
    rules: AliasRule[],
  ): Promise<DictionaryLocator | null> {
    const response = await this.fetchImpl(
      `${ELEVENLABS_API_BASE}/pronunciation-dictionaries/${dictionaryId}/add-rules`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      },
    );

    // Adding rules returns a new version of the same dictionary, so the id is
    // already known and only the version is new.
    return this.readLocator(response, dictionaryId);
  }

  private async readLocator(
    response: Response,
    knownId?: string,
  ): Promise<DictionaryLocator | null> {
    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { id?: string; version_id?: string };
    const id = body.id ?? knownId;

    return id && body.version_id ? { id, versionId: body.version_id } : null;
  }
}

export const pronunciationService = new PronunciationService();
