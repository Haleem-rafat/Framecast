import { z } from "zod";

import { TAGS_MAX } from "@/lib/youtube-limits";

export const themePreferences = ["LIGHT", "DARK", "SYSTEM"] as const;

export const publishVisibilities = ["PUBLIC", "UNLISTED", "PRIVATE"] as const;

/**
 * `AiProviderType` covers every provider the platform knows about, including
 * image, video and stock-footage vendors that could never write a script. The
 * column is typed as the whole enum, but offering all thirteen values here
 * would let an operator save `PEXELS` as their script provider — a setting that
 * is not wrong so much as meaningless. These two tuples narrow the enum to the
 * values that name a real capability.
 */
export const scriptProviderOptions = ["OPENAI", "ANTHROPIC", "GEMINI"] as const;

/**
 * One entry on purpose: `elevenlabs.provider.ts` is the only `SpeechProvider`
 * implementation in the codebase. Listing aspirational vendors here would
 * promise a choice that does not exist.
 */
export const voiceProviderOptions = ["ELEVENLABS"] as const;

/**
 * Not a YouTube rule — YouTube only caps the combined length, enforced below.
 * This caps the *count* so a paste accident cannot turn the tag box into a
 * hundred-row wall of text.
 */
export const MAX_DEFAULT_TAGS = 20;

/**
 * Sentinel for "no script template pinned". Radix's `<Select>` treats `""` as
 * "nothing selected" and would render the placeholder instead of this option,
 * so the empty choice needs a real value. The form schema converts it back to
 * `null`, so nothing past the browser has to know it exists.
 */
export const NO_SCRIPT_PROMPT = "NONE";

/** Shared by both schemas below, so the two can never disagree about the limit. */
const tagsWithinYoutubeLimit = (tags: string[]) =>
  tags.join(",").length <= TAGS_MAX;

const TAGS_TOO_LONG = `Tags are too long — YouTube allows ${TAGS_MAX} characters combined`;
const TOO_MANY_TAGS = `At most ${MAX_DEFAULT_TAGS} tags`;

/**
 * What the server action accepts — already-normalised values, not browser text.
 *
 * This is deliberately a separate schema from `settingsFormSchema` rather than
 * the same one reused. The form's fields carry transforms (a comma-separated
 * string becomes an array; a `NONE` sentinel becomes `null`), which means the
 * form's *output* is not valid as its own *input*. Parsing the submitted values
 * against the form schema would therefore reject them — an array where a string
 * was expected. Two schemas, one per shape, keeps server validation genuinely
 * independent of whatever the browser did.
 */
export const updateSettingsSchema = z.object({
  theme: z.enum(themePreferences),
  defaultScriptProvider: z.enum(scriptProviderOptions),
  defaultVoiceProvider: z.enum(voiceProviderOptions),
  // ElevenLabs voice ids are 20-character opaque handles; 64 leaves room for
  // whatever a future provider uses without accepting a pasted essay.
  defaultVoiceId: z.string().trim().max(64).nullable(),
  defaultVisibility: z.enum(publishVisibilities),
  defaultTags: z
    .array(z.string().trim().min(1))
    .max(MAX_DEFAULT_TAGS, TOO_MANY_TAGS)
    .refine(tagsWithinYoutubeLimit, { message: TAGS_TOO_LONG }),
  storageBucket: z.string().trim().max(120).nullable(),
  defaultScriptPromptId: z.uuid().nullable(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/**
 * Trimmed free text where an empty box and an unset column mean the same
 * thing. Collapsing `""` to `null` here keeps that equivalence out of the
 * service and out of the database, where `""` would otherwise read as "the
 * operator deliberately chose the empty string".
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);
}

/**
 * What the settings form holds and validates in the browser. Its output is
 * exactly `UpdateSettingsInput`, so a successful submit can be handed straight
 * to the action.
 */
export const settingsFormSchema = z.object({
  theme: z.enum(themePreferences),
  defaultScriptProvider: z.enum(scriptProviderOptions),
  defaultVoiceProvider: z.enum(voiceProviderOptions),
  defaultVoiceId: optionalText(64),
  defaultVisibility: z.enum(publishVisibilities),
  /**
   * Held as one comma-separated string so the control stays a plain `<Input>`,
   * and split here so the array shape exists in exactly one place.
   */
  defaultTags: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    )
    .refine((tags) => tags.length <= MAX_DEFAULT_TAGS, {
      message: TOO_MANY_TAGS,
    })
    .refine(tagsWithinYoutubeLimit, { message: TAGS_TOO_LONG }),
  storageBucket: optionalText(120),
  defaultScriptPromptId: z
    .union([z.literal(NO_SCRIPT_PROMPT), z.uuid()])
    .transform((value) => (value === NO_SCRIPT_PROMPT ? null : value)),
});

export type SettingsFormValues = z.input<typeof settingsFormSchema>;
