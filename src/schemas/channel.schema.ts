import { z } from "zod";

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
 * What a channel sends YouTube on every upload, edited per channel because
 * that is where it belongs: a channel's videos are written, narrated and
 * categorised the same way every time.
 */
export const updatePublishingDefaultsSchema = z.object({
  channelId: z.uuid(),
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
   * because the dialog always shows it.
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
});

export type UpdatePublishingDefaultsInput = z.infer<
  typeof updatePublishingDefaultsSchema
>;

/**
 * The form's own schema. Same fields and the same rules — the values are
 * already in their stored shape in the browser, so unlike the settings form
 * there is no transform to keep the two apart, but they stay separate types
 * so a future transform doesn't have to be retrofitted into the server's
 * boundary.
 */
export const publishingDefaultsFormSchema = updatePublishingDefaultsSchema.omit({
  channelId: true,
});

export type PublishingDefaultsFormValues = z.infer<
  typeof publishingDefaultsFormSchema
>;
