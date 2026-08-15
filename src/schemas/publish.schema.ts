import { z } from "zod";

/**
 * The three values the publish dialog offers, written out rather than derived
 * from Prisma's `PublishVisibility` — the same reasoning `themePreferences` in
 * settings.schema.ts carries: a boundary that defines itself in terms of the
 * thing it is guarding validates nothing. Deliberately a separate tuple from
 * that file's `publishVisibilities` too: these are the values a *publish* may
 * be made at, and a future settings-only value (or a settings tuple narrowed
 * to fewer options) must not silently change what this action accepts.
 */
export const publishVisibilityOptions = ["PUBLIC", "UNLISTED", "PRIVATE"] as const;

export type PublishVisibilityOption = (typeof publishVisibilityOptions)[number];

/**
 * What `publishVideoAction` accepts.
 *
 * `visibility` is required, with no default. A default here would be a second
 * place that decides how public an irreversible, one-shot upload is — the
 * dialog already seeds its picker from `UserSetting.defaultVisibility` (or
 * PRIVATE), and `publishService.publish` already falls back to PRIVATE for
 * callers that pass nothing at all. A request that reaches this action having
 * forgotten the field is a bug, and failing it is cheaper than guessing.
 *
 * There is no `scheduledFor` here on purpose. The service accepts one, but
 * only alongside `visibility: "PUBLIC"` (see its own comment on why YouTube's
 * `publishAt` cannot express anything else), and no scheduling control exists
 * in the dialog — so accepting a timestamp here would only widen what a
 * hand-made request can ask this app to do without any surface offering it.
 */
export const publishVideoSchema = z.object({
  visibility: z.enum(publishVisibilityOptions),
  /**
   * Whether this click also uploads the video's READY shorts, each as its own
   * video on the same channel.
   *
   * Unlike `visibility` this *does* carry a default, and the direction is why.
   * A default visibility would be a second opinion about how public an
   * irreversible upload is; a default of `false` here can only ever result in
   * *fewer* things reaching YouTube. Shorts were unpublishable by construction
   * until this landed (see the `ShortStatus` comment in schema.prisma), so a
   * request that never mentions them — an older client, a hand-made call —
   * must behave exactly as it did then. `publishService.publish` defaults the
   * same way, independently, for callers that never reach this schema.
   */
  includeShorts: z.boolean().default(false),
});

export type PublishVideoInput = z.infer<typeof publishVideoSchema>;
