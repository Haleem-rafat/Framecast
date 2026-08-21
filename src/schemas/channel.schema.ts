import { z } from "zod";

import { DOODLE_BEAT_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS } from "@/lib/doodle-cadence";
import { ART_STYLES } from "@/lib/art-styles";
import { BRAND_FONTS } from "@/lib/brand-fonts";
import { FOOTAGE_STYLES } from "@/lib/footage-styles";

/**
 * A BCP-47 language tag, restricted to the shape YouTube actually accepts:
 * a two- or three-letter primary subtag, optionally followed by hyphenated
 * subtags (`en`, `en-GB`, `pt-BR`). Not a full RFC 5646 parser — this is a
 * boundary check, and the values that matter here are the short ones an
 * operator types. 35 characters is BCP-47's own practical ceiling for a tag
 * of this shape.
 *
 * A wrong-but-well-formed tag is not something validation can catch, and it
 * is not catastrophic either: YouTube stores it, and the operator can fix the
 * language on the channel and on the video afterwards in YouTube Studio.
 * Malformed input is the case worth refusing, because `videos.insert` answers
 * 400 for it *after* the whole file has been uploaded — and a failed publish
 * cannot be retried from this app (see publish.service.ts on why the failed
 * Publication row stays).
 */
const BCP_47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * YouTube's category ids are small integers sent as strings (`"27"`). The
 * regex is what stops `"Education"`, `"27 "` or an empty string reaching the
 * upload; which numeric ids are *assignable* is region-dependent and known
 * only to YouTube, so that half is not validated here — the picker is built
 * from what `videoCategories.list` returned as assignable for the channel's
 * own region. See `BrandService.listCategories`.
 */
const CATEGORY_ID = /^[0-9]{1,3}$/;

/**
 * A six-digit hex colour and nothing else — not a CSS colour name, not
 * `rgb()`, not eight digits with alpha.
 *
 * The narrowness is copied from the far end rather than invented here.
 * `resolveHeadlineColour` in thumbnail-command.ts already applies exactly
 * this allowlist before the value reaches FFmpeg, and silently substitutes
 * white for anything that fails it — because `primaryColour` is an
 * unvalidated `String?` column and a value like `white:x=0` would otherwise
 * parse as valid drawtext syntax carrying its own extra options. Refusing the
 * same shapes at the boundary is what makes the two agree: whatever this
 * accepts is what the thumbnail actually draws, so the preview beside the
 * field is not a lie.
 */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * The three prompt fields — tone, niche and music query — are optional in the
 * one specific sense that matters: an operator may clear one back to empty,
 * and it is then stored as `NULL` so `BrandService.resolve` hands out its
 * documented fallback again. There is no other way back to the default once a
 * value has been typed, and "general interest" is a better answer for a
 * channel that no longer means what it once said than a stale niche nobody
 * remembers setting.
 *
 * Trimmed before the length check and before the emptiness test, so a field
 * holding one space is a cleared field rather than a one-character tone.
 *
 * It accepts a null as well as a string, and that is not decoration. This
 * schema is parsed twice — once by the resolver in the browser, against what
 * the input holds, and again by the action, against what the browser sent. The
 * first parse is what turns an emptied box into a null, so the second parse is
 * handed the null its own transform produced. A bare `z.string()` here rejects
 * it, and because a `ZodError` is not an `AppError` the operator is told
 * "something went wrong on our end" for the entirely ordinary act of clearing
 * a field. Accepting both shapes is what makes the transform idempotent, which
 * is what a schema applied on both sides of a round trip has to be.
 */
function promptText(max: number) {
  return z
    .union([z.string(), z.null()])
    .transform((value) => value?.trim() ?? "")
    .pipe(z.string().max(max))
    .transform((value) => (value.length === 0 ? null : value));
}

/**
 * An ElevenLabs voice id: their ids are 20-character alphanumeric strings, and
 * nothing here needs to be stricter than "a token, not a sentence".
 *
 * The bound that matters is the character class, not the length. This value is
 * interpolated straight into the synthesis URL
 * (`/text-to-speech/${voiceId}/with-timestamps`), so a slash or a `?` in it
 * would be a different request to a different endpoint. Refusing everything
 * but letters and digits at the boundary is what makes that interpolation safe
 * to read.
 *
 * Which ids are *real* is deliberately not validated: that is a fact about the
 * operator's ElevenLabs account, the picker only ever offers ids that account
 * returned, and a voice deleted upstream after being saved is a synthesis
 * failure no regex could have caught.
 */
export const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * The chosen voice, or null for "narrate with the deployment default".
 *
 * Null is a first-class answer here in exactly the way it is for `tone` — it
 * is how a channel goes back to `ELEVENLABS_VOICE_ID`, which is what every
 * channel used before this existed — and it takes both shapes for the same
 * round-trip reason `promptText` does: the resolver in the browser and the
 * action on the server parse the same value, so the transform has to accept
 * its own output.
 */
const voiceIdField = z
  .union([z.string(), z.null()])
  .transform((value) => value?.trim() ?? "")
  .transform((value) => (value.length === 0 ? null : value))
  .pipe(
    z.union([
      z.string().max(64).regex(VOICE_ID, "That is not an ElevenLabs voice id"),
      z.null(),
    ]),
  );

/**
 * Long enough for a real answer, short enough that the field cannot become a
 * second script prompt. These strings are interpolated into the thumbnail,
 * logo, shorts and metadata prompts — see `updateBrandingSchema` below — and
 * a paragraph pasted into "tone" does not describe a tone, it displaces the
 * instructions around it.
 */
const TONE_MAX = 120;
const NICHE_MAX = 120;
/** Jamendo's search takes a handful of words; a sentence returns nothing. */
const MUSIC_QUERY_MAX = 160;
/** A voice's name as ElevenLabs gave it — "Roger", "Charlotte". Generous
 *  because a cloned voice can be named anything, bounded because it is stored
 *  and printed in a table cell. */
export const VOICE_NAME_MAX = 120;
/** See `characterBrief` in `updateBrandingSchema` for why this is an order of
 *  magnitude larger than the fields above it. */
const CHARACTER_BRIEF_MAX = 2000;

/**
 * Everything about a channel the branding screen edits, in one object,
 * because one screen writes them in one upsert.
 *
 * The publishing half (language, category, audience, footage) used to have a
 * schema of its own behind the "Publishing defaults" dialog. That dialog is
 * now a card on `/channels/[id]` beside the logo, colours, voice and music,
 * and splitting one Save across two writes would mean a half-saved channel
 * whenever the second one failed. The rules for those four fields are
 * unchanged, comment for comment.
 */
export const updateBrandingSchema = z.object({
  channelId: z.uuid(),

  /** Burned into the thumbnail headline by `drawtext`. */
  primaryColour: z
    .string()
    .trim()
    .regex(HEX_COLOUR, "Use a six-digit hex colour like #FFCC00"),
  /**
   * Held to the same shape as `primaryColour` even though nothing in the
   * render path reads it yet. A column that is going to be a colour should
   * never have been allowed to hold something that is not one, and the screen
   * says plainly that this one is stored rather than drawn.
   */
  secondaryColour: z
    .string()
    .trim()
    .regex(HEX_COLOUR, "Use a six-digit hex colour like #101010"),
  /**
   * An enum, not a string, and the one field on this screen where free text
   * would be actively harmful: drawtext and libass both fall back to a default
   * face *silently* on a name they cannot resolve, so an uninstalled font is
   * indistinguishable from no font at all. `BRAND_FONTS` mirrors what
   * worker/Dockerfile installs — see that module's comment.
   */
  headlineFont: z.enum(BRAND_FONTS.map((font) => font.value)),

  /** Reaches the thumbnail prompt, the logo prompt, the shorts moment-picker
   *  and the generated title, description and tags. */
  tone: promptText(TONE_MAX),
  niche: promptText(NICHE_MAX),
  /** What Jamendo is searched for. See the column comment in schema.prisma. */
  musicQuery: promptText(MUSIC_QUERY_MAX),

  /** Which ElevenLabs voice narrates this channel, or null for the
   *  deployment's own. */
  voiceId: voiceIdField,
  /**
   * The name that voice had in the list the operator picked it from, so the
   * narration library can print a name rather than an id.
   *
   * Sent by the form rather than re-derived on the server, because deriving it
   * would mean a second call to ElevenLabs on every Save — on a screen whose
   * other nine fields need no network at all — and a save that failed because
   * a *label* could not be looked up would be an absurd way to lose a colour
   * change. It is display text for the operator's own narration, bounded here
   * like every other free string, and `BrandService.updateBranding` drops it
   * outright whenever `voiceId` is null so it can never describe a voice that
   * is not set.
   */
  voiceName: promptText(VOICE_NAME_MAX),

  language: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .regex(BCP_47, "Use a language tag like en or en-GB"),
  categoryId: z
    .string()
    .trim()
    .regex(CATEGORY_ID, "Pick a category from the list"),
  /**
   * The audience declaration. No `.default()` and no `.optional()`, unlike
   * almost every other boolean in this codebase: a declaration that can arrive
   * absent is a declaration something else has to guess, and this is the one
   * field where a guess is a false legal statement. The form always sends it
   * because the screen always shows it.
   */
  madeForKids: z.boolean(),
  /**
   * Which stock providers this channel's footage is searched for. An enum
   * rather than a free string because the value is read straight into
   * `FOOTAGE_SEARCH_PLAN`'s index in footage.service.ts — an unrecognised
   * value there would be `undefined` and take the whole footage stage down
   * with it, so it is refused at the boundary instead. Kept in sync with the
   * Prisma enum by `FOOTAGE_STYLES`, which is typed against it.
   */
  footageStyle: z.enum(FOOTAGE_STYLES.map((option) => option.value)),
  /**
   * Who the recurring character is, for an illustrated channel.
   *
   * Bounded far more generously than `tone` and `niche` above, and the reason
   * is the opposite of theirs. Those two are interpolated *beside* the real
   * instructions in a prompt, so a paragraph in them displaces what matters.
   * This one IS the instruction: the whole finding behind illustrated footage
   * is that a one-line description does not hold a character across a dozen
   * generations — Max Woolf's write-up used a ~2,600-token character sheet and
   * still saw details shift — so an operator who wants to name the exact shade
   * of a scarf and the shape of an ear should be able to.
   */
  characterBrief: promptText(CHARACTER_BRIEF_MAX),
  /**
   * Which named look this channel's illustrations are drawn in.
   *
   * An enum over the shipped catalogue, so a request can never post arbitrary
   * prompt text and have it composed into a generation — the column stores a
   * slug and the server resolves it against `ART_STYLES`.
   *
   * Nullable, and null round-trips: "nobody has chosen" is a real state the
   * screen shows as such, and it is what makes the illustrated path refuse
   * rather than silently draw every channel the same way. `""` is coerced to
   * null so the picker's empty option and an untouched field mean one thing.
   */
  artStyle: z
    .union([z.enum(ART_STYLES.map((style) => style.id)), z.literal(""), z.null()])
    .transform((value) => (value === "" || value === undefined ? null : value)),
  /**
   * How long one picture holds the screen, for a `DOODLE` channel.
   *
   * Bounded here rather than in the service because the bounds are the
   * format's, not the database's: under `DOODLE_BEAT_MIN_SECONDS` is a strobe
   * and over `DOODLE_BEAT_MAX_SECONDS` is what `ILLUSTRATED` already does. An
   * integer because a fractional cadence would imply a precision the format
   * does not have — the writer is asked for a section count and the real
   * seconds fall out of how long the narration turns out to be.
   *
   * Nullable and round-tripping, exactly as `artStyle` above: "nobody has
   * chosen" is a real state, and it is what makes the doodle path refuse at
   * script generation rather than silently pick a rhythm.
   */
  beatSeconds: z
    .union([
      z.coerce.number().int().min(DOODLE_BEAT_MIN_SECONDS).max(DOODLE_BEAT_MAX_SECONDS),
      z.literal(""),
      z.null(),
    ])
    .transform((value) => (value === "" || value === undefined ? null : value)),
});

export type UpdateBrandingInput = z.infer<typeof updateBrandingSchema>;

/**
 * The form's own schema: the same fields and the same rules, minus the
 * `channelId` the page already knows.
 *
 * Its *input* type is all strings — that is what the inputs hold — while its
 * output has `tone`, `niche` and `musicQuery` narrowed to `string | null` by
 * the transform above. The form declares both, the way `SettingsForm` does,
 * so `handleSubmit` hands the action a value already in the shape the server
 * will re-parse it into rather than one the action has to convert.
 */
export const brandingFormSchema = updateBrandingSchema.omit({
  channelId: true,
});

/** What the controls hold: every field a string, before the transform. */
export type BrandingFormValues = z.input<typeof brandingFormSchema>;
/** What `handleSubmit` produces, and what the action is sent. */
export type BrandingFormOutput = z.output<typeof brandingFormSchema>;

/**
 * Choosing one of the generated logo options, and reading one back out of
 * storage to show it.
 *
 * A bare filename, never a path. `ChannelBrand.logoPath` is handed straight
 * to `getObject` by `thumbnail.service.ts` at render time, so a caller that
 * could set it to an arbitrary string could point a channel's logo at any
 * object in the bucket. The action rebuilds the full path with
 * `storagePath(channelId, "logos", filename)` instead of accepting one, which
 * pins it under the channel's own prefix by construction and puts it through
 * `storagePath`'s own refusal of `/` and `..`. The regex below is the same
 * bound stated one layer earlier, so a malformed value is a validation error
 * rather than a 500 out of the storage layer.
 */
export const logoFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._-]+$/, "Not a logo filename");

export const chooseLogoSchema = z.object({
  channelId: z.uuid(),
  filename: logoFilenameSchema,
});

export type ChooseLogoInput = z.infer<typeof chooseLogoSchema>;

/**
 * Reading a generated character sheet back out of storage to show it.
 *
 * The same bare-filename rule `logoFilenameSchema` states, for the same
 * reason and against the same threat: the route rebuilds the path with
 * `storagePath(channelId, "characters", filename)` rather than accepting one,
 * so a request cannot climb out of the channel's own prefix. Separate from the
 * logo schema rather than shared, so the error message names the thing that
 * was actually asked for.
 */
export const characterSheetFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._-]+$/, "Not a character sheet filename");
