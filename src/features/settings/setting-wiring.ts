/**
 * Which `UserSetting` columns the pipeline actually reads.
 *
 * `theme` and `accent` are read: the dashboard layout resolves both on every
 * authenticated render and puts them into the page before it paints (see
 * `Appearance`). The other six are not. `UserSetting` was until recently a
 * fully-formed model with no consumer anywhere in `src/` — every value it
 * stored was decided somewhere else, by an environment variable, a hardcoded
 * literal, a per-video form field, or a different table's flag. The page still
 * reads and writes those, because a preference an operator saved is worth
 * keeping and because wiring each one up later is a small change. But a control
 * that silently does nothing is worse than no control at all, so every
 * unapplied field carries the sentence below saying where its value really
 * comes from today.
 *
 * When a setting is genuinely wired up, flip `applied` and delete its
 * `actualSource`. The page's banner keys off these flags, so it disappears on
 * its own once nothing is left unapplied.
 */
export interface SettingWiring {
  /** False when nothing in `src/` reads this column. */
  applied: boolean;
  /**
   * What decides this value today, in the operator's terms. Present only while
   * `applied` is false — once the pipeline reads the column, the column *is*
   * the source and there is nothing to disclose.
   */
  actualSource?: string;
}

export type SettingKey =
  | "theme"
  | "accent"
  | "defaultScriptProvider"
  | "defaultVoiceProvider"
  | "defaultVoiceId"
  | "defaultVisibility"
  | "defaultTags"
  | "storageBucket"
  | "defaultScriptPromptId";

export const SETTING_WIRING: Record<SettingKey, SettingWiring> = {
  // Read by the dashboard layout on every authenticated render, applied before
  // first paint, and written by the top-bar toggle as well as by this form —
  // so the choice follows the operator between browsers rather than living in
  // one browser's localStorage. `actualSource` is gone with the disclaimer.
  theme: { applied: true },
  accent: { applied: true },
  defaultScriptProvider: {
    applied: false,
    actualSource:
      "Script generation always calls Anthropic through the AI Gateway. The model is fixed by the AI_SCRIPT_MODEL environment variable.",
  },
  defaultVoiceProvider: {
    applied: false,
    actualSource:
      "Narration always calls ElevenLabs — it is the only speech provider implemented.",
  },
  defaultVoiceId: {
    applied: false,
    actualSource:
      "The voice is fixed for the whole deployment by the ELEVENLABS_VOICE_ID environment variable.",
  },
  defaultVisibility: {
    applied: false,
    actualSource:
      "Every publish uploads as unlisted. There is no visibility picker on the publish button yet.",
  },
  defaultTags: {
    applied: false,
    actualSource:
      "Tags are written per video by the metadata step, which generates them from the finished script.",
  },
  storageBucket: {
    applied: false,
    actualSource:
      "Files are written to local disk, not to a bucket — the STORAGE_ROOT and RENDER_ROOT environment variables set the two directories. This field is left over from the Supabase Storage era.",
  },
  defaultScriptPromptId: {
    applied: false,
    actualSource:
      "The template marked as default in the Prompt Library is the one script generation uses. Set it there.",
  },
};

/**
 * Drives the page banner. Computed rather than hardcoded so that wiring up a
 * single setting narrows the warning to the remaining ones, and wiring up the
 * last one removes it entirely, without anybody having to remember to.
 */
export const UNAPPLIED_SETTING_COUNT = Object.values(SETTING_WIRING).filter(
  (wiring) => !wiring.applied,
).length;

export const TOTAL_SETTING_COUNT = Object.keys(SETTING_WIRING).length;
